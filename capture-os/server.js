require('dotenv').config();

// --- 启动时自检 (保留，用于确认加载成功) ---
console.log("------------------------------------------------");
console.log("【环境诊断】正在检查密钥加载情况...");
console.log("当前运行目录:", process.cwd());
// 这里加了 trim() 只是为了显示好看，关键是下面业务逻辑里也要加
const debugId = process.env.NOTION_CLIENT_ID ? process.env.NOTION_CLIENT_ID.trim() : "";
console.log("Client ID:", debugId ? "✅ 已加载 (开头: " + debugId.substring(0, 4) + "...)" : "❌ 未加载");
console.log("Client Secret:", process.env.NOTION_CLIENT_SECRET ? "✅ 已加载" : "❌ 未加载");
console.log("------------------------------------------------");

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cheerio = require('cheerio');

// 引入数据库模块（替换原有的 JSON 文件操作）
const userRepo = require('./db/userRepo');

const app = express();
// Trust the first proxy (Sealos ingress) for correct client IP handling
app.set('trust proxy', 1);

// --------------------------------------------------
// 中间件配置
// --------------------------------------------------
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --------------------------------------------------
// 全局配置区
// --------------------------------------------------
const PORT = process.env.PORT || 3000;
const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;

// 【关键修复】确保 BASE_URL 后面没有多余的斜杠，也没有空格
const RAW_BASE_URL = process.env.BASE_URL || "";
const BASE_URL = RAW_BASE_URL.trim().replace(/\/$/, "");

// --------------------------------------------------
// API 限速配置（防爆破）
// --------------------------------------------------
// 管理员跳过限速的检查函数
const skipIfAdmin = (req, res) => {
    const key = req.query.key || req.headers['authorization']?.replace('Bearer ', '').trim();
    if (key && key.toUpperCase().startsWith('VIP')) {
        return true; // VIP 前缀 = 管理员，跳过限速
    }
    return false;
};

const authLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟
    max: 5, // 每 IP 最多 5 次
    message: { error: '请求过于频繁，请 1 分钟后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipIfAdmin, // 管理员跳过
});

const captureLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 分钟
    max: 5, // 每 IP 最多 5 次（防连点）
    message: { error: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipIfAdmin, // 管理员跳过
});

// --------------------------------------------------
// 按 Key 每日限额（S3）
// --------------------------------------------------
const DAILY_LIMIT = 20;
const dailyUsage = new Map(); // key -> { date: 'YYYY-MM-DD', count: N }

function getDailyUsage(licenseKey) {
    const today = new Date().toISOString().slice(0, 10);
    const record = dailyUsage.get(licenseKey);
    if (!record || record.date !== today) {
        dailyUsage.set(licenseKey, { date: today, count: 0 });
        return 0;
    }
    return record.count;
}

function incrementDailyUsage(licenseKey) {
    const today = new Date().toISOString().slice(0, 10);
    const record = dailyUsage.get(licenseKey);
    if (!record || record.date !== today) {
        dailyUsage.set(licenseKey, { date: today, count: 1 });
    } else {
        record.count++;
    }
}

// ==================================================
// 模块 1：前端与授权
// ==================================================

// 1. 用户绑定页面
app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 发起 Notion 授权 (修复版)
app.get('/auth', authLimiter, (req, res) => {
    const licenseKey = req.query.key ? req.query.key.trim() : "";

    // 从数据库查询用户
    const user = userRepo.findByKey(licenseKey);

    // 检查 Key 是否存在
    if (!user) {
        return res.send(`<h3 style="color:red;text-align:center;margin-top:50px;">错误：无效的 License Key (${licenseKey})</h3>`);
    }

    // 检查是否过期（管理员跳过）
    if (!userRepo.isAdmin(user) && userRepo.isExpired(user)) {
        return res.send(`<h3 style="color:red;text-align:center;margin-top:50px;">错误：License Key 已过期</h3>`);
    }

    // 【关键修复】在这里对 Client ID 进行清洗，去除可能存在的空格/换行
    const rawClientId = process.env.NOTION_CLIENT_ID || "";
    const clientId = rawClientId.trim();

    if (!clientId) {
        return res.send("错误：服务器未配置 NOTION_CLIENT_ID");
    }

    const redirectUri = `${BASE_URL}/callback`;

    // 打印生成的链接，方便调试 (生产环境可删除)
    console.log(`[Auth] 正在发起授权... Key: ${licenseKey}`);
    console.log(`[Auth] 使用 Client ID: ${clientId}`);
    console.log(`[Auth] 回调地址: ${redirectUri}`);

    const notionAuthUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}&state=${licenseKey}`;

    res.redirect(notionAuthUrl);
});

// --------------------------------------------------
// 辅助函数：全方位数据库搜索（解决各种 Notion 数据库类型检测问题）
// --------------------------------------------------

// 尝试直接通过 Databases API 访问一个 ID，判断它是否是数据库
async function tryAsDatabase(headers, id) {
    try {
        const res = await axios.get(`https://api.notion.com/v1/databases/${id}`, { headers });
        const title = res.data.title?.[0]?.plain_text || '未命名';
        return { id: res.data.id, title };
    } catch (e) {
        return null;
    }
}

// 完整的数据库检测（3 种策略 + 重试）
async function searchDatabaseWithRetry(accessToken, maxRetries = 3, delayMs = 2000) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Notion-Version': '2022-06-28'
    };

    for (let i = 1; i <= maxRetries; i++) {
        console.log(`[数据库检测] ===== 第 ${i}/${maxRetries} 轮 =====`);

        // 策略 1：无过滤器搜索，拿到所有授权对象，逐个检查是否是数据库
        try {
            console.log(`[策略1] 无过滤器搜索所有授权对象...`);
            const searchRes = await axios.post('https://api.notion.com/v1/search', {
                page_size: 20
            }, { headers });

            const results = searchRes.data.results || [];
            console.log(`[策略1] 搜索到 ${results.length} 个对象:`);

            for (const item of results) {
                const itemTitle = item.object === 'database'
                    ? (item.title?.[0]?.plain_text || '未命名')
                    : (item.properties?.title?.title?.[0]?.plain_text || '未命名');
                console.log(`  - [${item.object}] ${itemTitle} (${item.id})`);

                // 如果搜索结果本身就是 database 类型，直接返回
                if (item.object === 'database') {
                    console.log(`[策略1] ✅ 直接找到数据库: ${itemTitle} (${item.id})`);
                    return { id: item.id, title: itemTitle };
                }
            }

            // 搜索结果中没有 database 对象，尝试把每个 page 当作数据库访问
            for (const item of results) {
                if (item.object === 'page') {
                    const dbResult = await tryAsDatabase(headers, item.id);
                    if (dbResult) {
                        console.log(`[策略1] ✅ 页面实际上是数据库: ${dbResult.title} (${dbResult.id})`);
                        return dbResult;
                    }
                }
            }
        } catch (err) {
            console.log(`[策略1] 搜索失败: ${err.message}`);
        }

        // 策略 2：遍历所有页面的子块，查找 child_database
        try {
            console.log(`[策略2] 搜索页面内嵌子数据库...`);
            const pageRes = await axios.post('https://api.notion.com/v1/search', {
                filter: { value: 'page', property: 'object' },
                page_size: 10
            }, { headers });

            for (const page of (pageRes.data.results || [])) {
                const pageTitle = page.properties?.title?.title?.[0]?.plain_text || '未命名';
                try {
                    const blocksRes = await axios.get(
                        `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`,
                        { headers }
                    );

                    const blocks = blocksRes.data.results || [];
                    console.log(`  页面「${pageTitle}」含 ${blocks.length} 个子块: [${blocks.map(b => b.type).join(', ')}]`);

                    for (const block of blocks) {
                        // 检查 child_database 类型
                        if (block.type === 'child_database') {
                            const dbTitle = block.child_database?.title || pageTitle;
                            console.log(`[策略2] ✅ 找到子数据库: ${dbTitle} (${block.id})`);
                            return { id: block.id, title: dbTitle };
                        }
                        // 检查 child_page 类型（可能是全页面数据库）
                        if (block.type === 'child_page') {
                            const dbResult = await tryAsDatabase(headers, block.id);
                            if (dbResult) {
                                console.log(`[策略2] ✅ 子页面实际上是数据库: ${dbResult.title} (${dbResult.id})`);
                                return dbResult;
                            }
                        }
                    }
                } catch (blockErr) {
                    console.log(`  页面「${pageTitle}」子块读取失败: ${blockErr.message}`);
                }
            }
        } catch (err) {
            console.log(`[策略2] 失败: ${err.message}`);
        }

        // 等待后重试
        if (i < maxRetries) {
            console.log(`[数据库检测] 等待 ${delayMs}ms 后重试...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    console.log(`[数据库检测] ❌ 所有策略均未找到数据库`);
    return null;
}

// 自动创建数据库（当检测不到时，在用户授权的页面中创建）
async function createDatabaseForUser(accessToken) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
    };

    try {
        // 先找一个授权的页面作为父级
        const searchRes = await axios.post('https://api.notion.com/v1/search', {
            filter: { value: 'page', property: 'object' },
            page_size: 5
        }, { headers });

        let parentId = null;

        if (searchRes.data.results.length > 0) {
            parentId = searchRes.data.results[0].id;
            console.log(`[自动创建] 使用页面作为父级: ${parentId}`);
        }

        // 如果没有授权的页面，尝试直接在工作区创建（Notion API 支持）
        const parentObj = parentId
            ? { type: 'page_id', page_id: parentId }
            : { type: 'workspace', workspace: true };

        console.log(`[自动创建] 正在创建 Capture OS 数据库...`);

        const dbRes = await axios.post('https://api.notion.com/v1/databases', {
            parent: parentObj,
            icon: { type: 'emoji', emoji: '📚' },
            title: [{ type: 'text', text: { content: 'Capture OS' } }],
            properties: {
                "Name": { title: {} },
                "URL": { url: {} },
                "Type": {
                    select: {
                        options: [
                            { name: "文章", color: "blue" },
                            { name: "工具", color: "green" },
                            { name: "灵感", color: "yellow" },
                            { name: "资源", color: "purple" },
                            { name: "观点", color: "orange" },
                            { name: "教程", color: "pink" },
                            { name: "视觉", color: "red" }
                        ]
                    }
                },
                "Tags": { multi_select: {} },
                "Summary": { rich_text: {} },
                "Author": { rich_text: {} },
                "Platform": {
                    select: {
                        options: [
                            { name: "微信公众号", color: "green" },
                            { name: "小红书", color: "red" },
                            { name: "抖音", color: "default" },
                            { name: "知乎", color: "blue" },
                            { name: "其他", color: "gray" }
                        ]
                    }
                },
                "Difficulty": {
                    select: {
                        options: [
                            { name: "入门", color: "green" },
                            { name: "进阶", color: "yellow" },
                            { name: "深度", color: "red" }
                        ]
                    }
                },
                "Status": {
                    select: {
                        options: [
                            { name: "未开始", color: "default" },
                            { name: "进行中", color: "blue" },
                            { name: "已完成", color: "green" }
                        ]
                    }
                }
            }
        }, { headers });

        const dbId = dbRes.data.id;
        const dbTitle = dbRes.data.title?.[0]?.plain_text || 'Capture OS';
        console.log(`[自动创建] ✅ 数据库创建成功: ${dbTitle} (${dbId})`);
        return { id: dbId, title: dbTitle };

    } catch (err) {
        console.error(`[自动创建] ❌ 创建失败:`, err.response?.data || err.message);
        return null;
    }
}

// 3. 处理 Notion 回调（带重试 + 自动轮询兜底）
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const licenseKey = req.query.state;
    const error = req.query.error;

    if (error) return res.send(`授权失败: ${error}`);

    try {
        const rawClientId = process.env.NOTION_CLIENT_ID || "";
        const rawClientSecret = process.env.NOTION_CLIENT_SECRET || "";

        const authKey = `${rawClientId.trim()}:${rawClientSecret.trim()}`;
        const encodedAuth = Buffer.from(authKey).toString('base64');

        console.log(`[Callback] 正在用 Code 换 Token...`);

        const response = await axios.post('https://api.notion.com/v1/oauth/token', {
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: `${BASE_URL}/callback`
        }, {
            headers: {
                'Authorization': `Basic ${encodedAuth}`,
                'Content-Type': 'application/json'
            }
        });

        const accessToken = response.data.access_token;

        // 保存 Token
        userRepo.updateToken(licenseKey, accessToken);
        console.log(`[Callback] Token 已保存: ${licenseKey}`);

        // 先尝试检测已有数据库（2 次快速重试）
        let dbResult = await searchDatabaseWithRetry(accessToken, 2, 2000);

        // 检测不到？自动创建一个！
        if (!dbResult) {
            console.log(`[Callback] 未检测到已有数据库，自动为用户创建...`);
            dbResult = await createDatabaseForUser(accessToken);
        }

        if (dbResult) {
            // ✅ 重试成功，直接显示成功页
            userRepo.updateDatabaseId(licenseKey, dbResult.id);
            res.send(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>配置成功 | Capture OS</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
                    .card { background: white; border-radius: 24px; padding: 48px 32px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
                    .icon { font-size: 56px; margin-bottom: 16px; }
                    h2 { color: #111; font-size: 22px; margin-bottom: 8px; }
                    .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
                    .db-info { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin-bottom: 24px; }
                    .db-info .label { color: #6b7280; font-size: 12px; margin-bottom: 4px; }
                    .db-info .value { color: #059669; font-size: 15px; font-weight: 600; }
                    .key-badge { display: inline-block; background: #f1f5f9; color: #475569; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-family: monospace; margin-bottom: 24px; }
                    .hint { color: #9ca3af; font-size: 13px; line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="icon">🎉</div>
                    <h2>配置成功！</h2>
                    <p class="subtitle">Notion 授权已完成，数据库已自动绑定</p>
                    <div class="db-info">
                        <div class="label">已绑定数据库</div>
                        <div class="value">📗 ${dbResult.title}</div>
                    </div>
                    <div class="key-badge">${licenseKey}</div>
                    <p class="hint">现在可以在快捷指令中使用此 Key<br>所有内容将自动保存到上方数据库</p>
                </div>
            </body>
            </html>
            `);
        } else {
            // ❌ 重试都失败了 → 返回自动轮询页面，前端继续等待
            console.log(`[Callback] 重试 5 次均未检测到数据库，启动前端轮询`);
            res.send(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>正在绑定数据库... | Capture OS</title>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
                    .card { background: white; border-radius: 24px; padding: 48px 32px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
                    .spinner { width: 48px; height: 48px; border: 4px solid #e5e7eb; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
                    @keyframes spin { to { transform: rotate(360deg); } }
                    h2 { color: #111; font-size: 20px; margin-bottom: 8px; }
                    .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
                    #status { color: #9ca3af; font-size: 13px; margin-top: 16px; }
                    .success-icon { font-size: 56px; margin-bottom: 16px; display: none; }
                    .db-info { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin: 20px 0; display: none; }
                    .db-info .label { color: #6b7280; font-size: 12px; margin-bottom: 4px; }
                    .db-info .value { color: #059669; font-size: 15px; font-weight: 600; }
                    .hint { color: #9ca3af; font-size: 13px; line-height: 1.6; display: none; }
                    .key-badge { display: inline-block; background: #f1f5f9; color: #475569; padding: 6px 14px; border-radius: 8px; font-size: 13px; font-family: monospace; margin-bottom: 16px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="spinner" id="spinner"></div>
                    <div class="success-icon" id="successIcon">🎉</div>
                    <h2 id="title">正在绑定数据库...</h2>
                    <p class="subtitle" id="subtitle">Notion 授权成功，正在检测您选择的数据库</p>
                    <div class="key-badge">${licenseKey}</div>
                    <div class="db-info" id="dbInfo">
                        <div class="label">已绑定数据库</div>
                        <div class="value" id="dbName"></div>
                    </div>
                    <p class="hint" id="hint">现在可以在快捷指令中使用此 Key<br>所有内容将自动保存到上方数据库</p>
                    <div id="status">第 1 次检测中...</div>
                </div>
                <script>
                    const key = "${licenseKey}";
                    let attempt = 0;
                    const maxAttempts = 30;

                    async function checkDatabase() {
                        attempt++;
                        document.getElementById('status').textContent = '第 ' + attempt + ' 次检测中...';

                        try {
                            const res = await fetch('/check-database?key=' + encodeURIComponent(key) + '&attempt=' + attempt);
                            const data = await res.json();

                            if (data.found) {
                                // 成功！切换到成功状态
                                document.getElementById('spinner').style.display = 'none';
                                document.getElementById('successIcon').style.display = 'block';
                                document.getElementById('title').textContent = '配置成功！';
                                document.getElementById('subtitle').textContent = 'Notion 授权已完成，数据库已自动绑定';
                                document.getElementById('dbName').textContent = '📗 ' + data.title;
                                document.getElementById('dbInfo').style.display = 'block';
                                document.getElementById('hint').style.display = 'block';
                                document.getElementById('status').style.display = 'none';
                                return;
                            }
                        } catch (e) {
                            console.error('检测失败:', e);
                        }

                        if (attempt < maxAttempts) {
                            setTimeout(checkDatabase, 3000);
                        } else {
                            document.getElementById('status').textContent = '检测超时，请关闭页面后重新访问 /setup 进行授权';
                            document.getElementById('spinner').style.display = 'none';
                        }
                    }

                    // 3 秒后开始第一次轮询
                    setTimeout(checkDatabase, 3000);
                </script>
            </body>
            </html>
            `);
        }

    } catch (err) {
        console.error("Auth Error:", err.response?.data || err.message);
        res.send(`授权过程中发生错误: ${JSON.stringify(err.response?.data || err.message)}`);
    }
});

// 3.5 数据库检测轮询接口（供前端页面调用）
app.get('/check-database', async (req, res) => {
    const licenseKey = req.query.key;
    if (!licenseKey) return res.json({ found: false, error: 'missing key' });

    const user = userRepo.findByKey(licenseKey);
    if (!user || !user.notion_token) return res.json({ found: false, error: 'no token' });

    // 如果已有 database_id，直接返回成功
    if (user.database_id) {
        return res.json({ found: true, title: '已绑定', database_id: user.database_id });
    }

    // 使用完整的搜索策略（单次不重试，轮询本身就是重试）
    let dbResult = await searchDatabaseWithRetry(user.notion_token, 1, 0);

    // 轮询第 5 次以上还没找到？直接自动创建
    const attempt = parseInt(req.query.attempt) || 0;
    if (!dbResult && attempt >= 5) {
        console.log(`[轮询检测] 第 ${attempt} 次仍未找到，自动创建数据库...`);
        dbResult = await createDatabaseForUser(user.notion_token);
    }

    if (dbResult) {
        userRepo.updateDatabaseId(licenseKey, dbResult.id);
        console.log(`[轮询检测] ✅ 数据库就绪: ${dbResult.title} (${dbResult.id})`);
        return res.json({ found: true, title: dbResult.title, database_id: dbResult.id });
    }

    res.json({ found: false });
});

// 4. 手动设置数据库 ID（当 OAuth 未自动检测到时使用）
app.post('/set-database', (req, res) => {
    const licenseKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
    const { database_id } = req.body;

    if (!licenseKey || !database_id) {
        return res.status(400).json({ error: "需要 Authorization header (Bearer key) 和 body 中的 database_id" });
    }

    const user = userRepo.findByKey(licenseKey);
    if (!user) return res.status(404).json({ error: "License Key 不存在" });

    userRepo.updateDatabaseId(licenseKey, database_id);
    console.log(`[设置数据库] Key: ${licenseKey} → DB: ${database_id}`);
    res.json({ msg: "数据库 ID 已保存", database_id });
});


// ==================================================
// 模块 2：核心业务接口
// ==================================================
app.post('/capture', captureLimiter, async (req, res) => {
    const authHeader = req.headers['authorization'];
    const licenseKey = authHeader ? authHeader.replace('Bearer ', '').trim() : null;

    // 从数据库查询用户
    const user = userRepo.findByKey(licenseKey);

    if (!user) return res.status(401).json({ error: "License Key 无效" });

    // 检查是否过期（管理员跳过）
    if (!userRepo.isAdmin(user) && userRepo.isExpired(user)) {
        return res.status(403).json({ error: "License Key 已过期，请续费" });
    }

    // 每日限额检查（管理员跳过）
    if (!userRepo.isAdmin(user)) {
        const used = getDailyUsage(licenseKey);
        if (used >= DAILY_LIMIT) {
            return res.status(429).json({
                error: "今日额度已用完",
                used: used,
                limit: DAILY_LIMIT,
                tip: "每日额度将在次日零点重置"
            });
        }
    }

    if (!user.notion_token) return res.status(403).json({ error: "尚未绑定 Notion，请访问 /setup 页面进行配置" });

    // 检查是否有实际内容
    const { url, text } = req.body || {};
    if (!url && !text) {
        return res.status(400).json({
            error: "未收到任何内容",
            tip: "请从浏览器或 App 的「分享」菜单中使用快捷指令，而不是直接打开运行。",
            usage: "在 Safari / 微信 / 小红书等 App 中 → 点击分享按钮 → 选择 Capture OS 快捷指令"
        });
    }

    // 计入每日用量
    incrementDailyUsage(licenseKey);

    res.status(200).json({ msg: "Capture OS Pro 已接收，正在后台处理..." });

    (async () => {
        try {
            const payload = req.body;
            console.log(`[任务启动] Key: ${licenseKey} | URL: ${payload.url}`);

            let targetDbId = payload.database_id;

            // 优先使用已保存的 database_id
            if (!targetDbId && user.database_id) {
                targetDbId = user.database_id;
                console.log(`[使用已保存数据库] ID: ${targetDbId}`);
            }

            // 最后才尝试 API 搜索（可能因 OAuth 未勾选数据库而失败）
            if (!targetDbId) {
                try {
                    const searchRes = await axios.post('https://api.notion.com/v1/search', {
                        filter: { value: 'database', property: 'object' },
                        page_size: 1
                    }, {
                        headers: {
                            'Authorization': `Bearer ${user.notion_token}`,
                            'Notion-Version': '2022-06-28'
                        }
                    });

                    if (searchRes.data.results.length > 0) {
                        targetDbId = searchRes.data.results[0].id;
                        // 找到了就保存，下次直接用
                        userRepo.updateDatabaseId(licenseKey, targetDbId);
                        console.log(`[自动匹配数据库] ID: ${targetDbId}`);
                    } else {
                        console.error("[错误] 用户授权了，但没找到任何数据库。请使用 /set-database 手动设置。");
                        return;
                    }
                } catch (searchErr) {
                    console.error("[搜索数据库失败]", searchErr.message);
                    return;
                }
            }

            // ===== 关卡 3：URL 去重（防连点） =====
            if (payload.url && targetDbId) {
                try {
                    const dupCheck = await axios.post('https://api.notion.com/v1/databases/' + targetDbId + '/query', {
                        filter: {
                            property: 'URL',
                            url: { equals: payload.url }
                        },
                        page_size: 1
                    }, {
                        headers: {
                            'Authorization': `Bearer ${user.notion_token}`,
                            'Notion-Version': '2022-06-28',
                            'Content-Type': 'application/json'
                        }
                    });

                    if (dupCheck.data.results.length > 0) {
                        console.log(`[去重] URL 已存在，跳过: ${payload.url}`);
                        return;
                    }
                } catch (dupErr) {
                    console.log(`[去重检查跳过] ${dupErr.message}`);
                    // 去重失败不阻塞主流程
                }
            }

            let contentToProcess = payload.text || '';
            let rawOriginalText = ''; // 保存原文用于 Notion 展示

            // ===== D6：短链解析 =====
            if (payload.url) {
                try {
                    const resolved = await axios.head(payload.url, {
                        maxRedirects: 5,
                        timeout: 5000,
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    const finalUrl = resolved.request?.res?.responseUrl || resolved.request?._redirectable?._currentUrl || payload.url;
                    if (finalUrl !== payload.url) {
                        console.log(`[短链解析] ${payload.url} -> ${finalUrl}`);
                        payload.url = finalUrl;
                    }
                } catch (e) {
                    console.log(`[短链解析跳过] ${e.message}`);
                }
            }

            // 识别来源平台
            let platform = '其他';
            if (payload.url) {
                const u = payload.url.toLowerCase();
                if (u.includes('weixin') || u.includes('mp.weixin') || u.includes('wechat')) platform = '微信公众号';
                else if (u.includes('xiaohongshu') || u.includes('xhslink') || u.includes('xhs')) platform = '小红书';
                else if (u.includes('douyin') || u.includes('tiktok')) platform = '抖音';
                else if (u.includes('zhihu')) platform = '知乎';
            }

            if (payload.url) {
                try {
                    const pageRes = await axios.get(payload.url, {
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                        }
                    });

                    // 使用 cheerio 提取纯文本正文
                    const $ = cheerio.load(pageRes.data);

                    // 移除无关标签
                    $('script, style, nav, footer, header, aside, iframe, noscript, svg, .ad, .ads, .advertisement, .sidebar, .menu, .navigation').remove();

                    // 优先从 article/main 中提取，否则从 body
                    let mainContent = $('article').text() || $('main').text() || $('[role="main"]').text() || $('body').text();

                    // 清理多余空白
                    mainContent = mainContent.replace(/\s+/g, ' ').trim();

                    // ===== 关卡 2：字数阈值熔断 =====
                    if (mainContent.length < 50) {
                        console.log(`[熔断] 内容仅 ${mainContent.length} 字符，疑似被反爬/付费墙拦截`);
                        // 不调用 AI，直接写入降级记录到 Notion
                        await axios.post('https://api.notion.com/v1/pages', {
                            parent: { database_id: targetDbId },
                            icon: { type: 'emoji', emoji: '⚠️' },
                            properties: {
                                "Name": { title: [{ text: { content: "⚠️ 内容被平台拦截" } }] },
                                "URL": { url: payload.url },
                                "Type": { select: { name: "资源" } },
                                "Tags": { multi_select: [{ name: "抓取失败" }] },
                                "Summary": { rich_text: [{ text: { content: "该链接的正文无法抓取（可能是反爬、付费墙或需要登录），请手动阅读原文。" } }] },
                                "Status": { select: { name: "未开始" } }
                            }
                        }, {
                            headers: {
                                'Authorization': `Bearer ${user.notion_token}`,
                                'Notion-Version': '2022-06-28',
                                'Content-Type': 'application/json'
                            }
                        });
                        console.log(`[熔断写入成功] 已保存降级记录: ${payload.url}`);
                        return;
                    }

                    // 截取前 6000 字符（纯文本信息密度远高于 HTML）
                    contentToProcess = `[URL]: ${payload.url}\n[正文内容]:\n${mainContent.substring(0, 6000)}`;
                    rawOriginalText = mainContent.substring(0, 3000); // 保存原文前 3000 字
                    console.log(`[抓取成功] 提取纯文本 ${mainContent.length} 字符`);
                } catch (e) {
                    console.error("抓取失败:", e.message);
                    contentToProcess = `[URL]: ${payload.url}\n(网页抓取失败，请根据 URL 地址推测内容进行分析)`;
                }
            }

            const startTime = Date.now();

            const client = new OpenAI({
                apiKey: ZHIPU_API_KEY,
                baseURL: 'https://open.bigmodel.cn/api/paas/v4/'
            });

            const completion = await client.chat.completions.create({
                model: "glm-4.6v",
                messages: [
                    {
                        role: "system",
                        content: `你是一个顶级知识管理专家和内容策展人。请深度分析用户输入的内容，提取结构化知识。

请返回以下 JSON 字段：

1. "Title": 简短有力的中文标题（10-20字，要有吸引力）
2. "Author": 内容作者/来源（从正文中提取，找不到写"未知"）
3. "Summary": 深度中文摘要（200-400字），要涵盖：核心论点、关键数据、主要结论、方法论框架。如果是学术论文或期刊文章，还应包含研究方法和数据支撑
4. "Tags": 3-5 个精准标签（数组格式，中文）
5. "Category": 从 ["文章", "工具", "灵感", "资源", "观点", "教程", "视觉"] 中选择最匹配的一个
6. "KeyInsight": 最核心的一句话洞察/金句（20-40字）
7. "Difficulty": 从 ["入门", "进阶", "深度"] 中选择。判断标准：入门=科普新闻、基础教程；进阶=需行业背景、涉及专业框架；深度=学术研究、技术底层、期刊论文、含参考文献
8. "ActionItems": 2-3 个可执行的行动要点（数组格式，每条 15-30 字，以动词开头）
9. "Emoji": 选择 1 个最能代表内容主题的 emoji

请务必只返回纯 JSON 格式数据，不要包含 Markdown 代码块标记。`
                    },
                    { role: "user", content: contentToProcess }
                ],
                response_format: undefined  // glm-4.6v 视觉模型不支持 json_object 模式
            });

            const aiTime = Date.now() - startTime;

            const rawContent = completion.choices[0].message.content;
            console.log(`[AI 原始返回] ${rawContent.substring(0, 200)}...`);
            const jsonStr = rawContent.replace(/```json|```/g, '').trim();
            const aiResult = JSON.parse(jsonStr);

            // 构建 Notion 页面正文 blocks
            const pageBlocks = [];

            // 📌 核心洞察 Callout
            if (aiResult.KeyInsight) {
                pageBlocks.push({
                    object: 'block',
                    type: 'callout',
                    callout: {
                        rich_text: [{ type: 'text', text: { content: aiResult.KeyInsight } }],
                        icon: { type: 'emoji', emoji: '💡' },
                        color: 'blue_background'
                    }
                });
            }

            // 空行分隔
            pageBlocks.push({ object: 'block', type: 'divider', divider: {} });

            // 📖 AI 摘要标题
            pageBlocks.push({
                object: 'block',
                type: 'heading_2',
                heading_2: {
                    rich_text: [{ type: 'text', text: { content: '📖 摘要' } }]
                }
            });

            // 摘要正文
            if (aiResult.Summary) {
                pageBlocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: aiResult.Summary } }]
                    }
                });
            }

            // ☑️ 行动要点
            if (aiResult.ActionItems && aiResult.ActionItems.length > 0) {
                pageBlocks.push({ object: 'block', type: 'divider', divider: {} });
                pageBlocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '✅ 行动要点' } }]
                    }
                });

                for (const item of aiResult.ActionItems) {
                    pageBlocks.push({
                        object: 'block',
                        type: 'to_do',
                        to_do: {
                            rich_text: [{ type: 'text', text: { content: item } }],
                            checked: false
                        }
                    });
                }
            }

            // 📎 原文链接
            if (payload.url) {
                pageBlocks.push({ object: 'block', type: 'divider', divider: {} });
                pageBlocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: '📎 原文链接' } }]
                    }
                });
                pageBlocks.push({
                    object: 'block',
                    type: 'bookmark',
                    bookmark: { url: payload.url }
                });
            }

            // 📄 原文内容（可折叠）
            if (rawOriginalText && rawOriginalText.length > 50) {
                pageBlocks.push({ object: 'block', type: 'divider', divider: {} });
                // Notion toggle block 内嵌段落
                const textChunks = [];
                // Notion rich_text 每段最多 2000 字符
                for (let i = 0; i < rawOriginalText.length; i += 2000) {
                    textChunks.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: {
                            rich_text: [{ type: 'text', text: { content: rawOriginalText.substring(i, i + 2000) } }]
                        }
                    });
                }
                pageBlocks.push({
                    object: 'block',
                    type: 'toggle',
                    toggle: {
                        rich_text: [{ type: 'text', text: { content: '📄 展开原文内容' } }],
                        children: textChunks
                    }
                });
            }

            // 选择页面 icon emoji
            const pageEmoji = aiResult.Emoji || '📝';

            await axios.post('https://api.notion.com/v1/pages', {
                parent: { database_id: targetDbId },
                icon: { type: 'emoji', emoji: pageEmoji },
                properties: {
                    "Name": {
                        title: [{ text: { content: aiResult.Title || "无标题" } }]
                    },
                    "URL": {
                        url: payload.url || null
                    },
                    "Type": {
                        select: { name: aiResult.Category || "资源" }
                    },
                    "Tags": {
                        multi_select: (aiResult.Tags || []).map(t => ({ name: t }))
                    },
                    "Summary": {
                        rich_text: [{ text: { content: (aiResult.Summary || "").substring(0, 2000) } }]
                    },
                    "Author": {
                        rich_text: [{ text: { content: (aiResult.Author || "未知").substring(0, 100) } }]
                    },
                    "Platform": {
                        select: { name: platform }
                    },
                    "Difficulty": {
                        select: { name: aiResult.Difficulty || "入门" }
                    },
                    "Status": {
                        select: { name: "未开始" }
                    }
                },
                children: pageBlocks
            }, {
                headers: {
                    'Authorization': `Bearer ${user.notion_token}`,
                    'Notion-Version': '2022-06-28',
                    'Content-Type': 'application/json'
                }
            });

            console.log(`[任务成功] 已写入笔记: ${pageEmoji} ${aiResult.Title} | AI耗时: ${aiTime}ms | 平台: ${platform}`);

        } catch (err) {
            const errMsg = err.response?.data?.message || err.response?.data || err.message;
            console.error("[后台处理错误]", errMsg);

            // ===== 关卡 4：AI 敏感词降级 =====
            if (err.response?.status === 400 && targetDbId) {
                try {
                    await axios.post('https://api.notion.com/v1/pages', {
                        parent: { database_id: targetDbId },
                        icon: { type: 'emoji', emoji: '🚫' },
                        properties: {
                            "Name": { title: [{ text: { content: "🚫 AI 拒绝处理此内容" } }] },
                            "URL": { url: payload.url || null },
                            "Type": { select: { name: "资源" } },
                            "Tags": { multi_select: [{ name: "审核拦截" }] },
                            "Summary": { rich_text: [{ text: { content: "内容可能涉及敏感话题，AI 审核未通过。请手动阅读原文。" } }] },
                            "Status": { select: { name: "未开始" } }
                        }
                    }, {
                        headers: {
                            'Authorization': `Bearer ${user.notion_token}`,
                            'Notion-Version': '2022-06-28',
                            'Content-Type': 'application/json'
                        }
                    });
                    console.log(`[降级写入] AI 拒绝处理，已保存降级记录`);
                } catch (notionErr) {
                    console.error(`[降级写入失败]`, notionErr.message);
                }
            }
        }
    })();
});

// ==================================================
// 模块 3：用户面板 API（D2）
// ==================================================
app.get('/api/usage', (req, res) => {
    const licenseKey = req.query.key ? req.query.key.trim() : null;
    if (!licenseKey) {
        return res.status(400).json({ error: '请提供密钥参数 ?key=YOUR_KEY' });
    }

    const user = userRepo.findByKey(licenseKey);
    if (!user) {
        return res.status(404).json({ error: '密钥无效' });
    }

    const isVip = userRepo.isAdmin(user);
    const todayUsed = getDailyUsage(licenseKey);

    res.json({
        key: licenseKey.substring(0, 8) + '****', // 脱敏
        status: user.status,
        role: isVip ? '管理员' : '普通用户',
        notion_bound: user.connected,
        database_id: user.database_id ? user.database_id.substring(0, 8) + '...' : null,
        today: {
            used: todayUsed,
            limit: isVip ? '无限制' : DAILY_LIMIT,
            remaining: isVip ? '无限制' : Math.max(0, DAILY_LIMIT - todayUsed)
        },
        created_at: user.created_at
    });
});

app.listen(PORT, () => {
    console.log(`Capture OS Pro Server running on port ${PORT}`);
    console.log(`[Database] 当前用户数: ${userRepo.count()}`);
});
