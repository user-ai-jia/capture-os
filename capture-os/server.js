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
    if (key) {
        const user = userRepo.findByKey(key);
        if (user && user.is_admin) {
            return true; // 管理员跳过限速
        }
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
    max: 30, // 每 IP 最多 30 次
    message: { error: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipIfAdmin, // 管理员跳过
});

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

// 3. 处理 Notion 回调
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const licenseKey = req.query.state;
    const error = req.query.error;

    if (error) return res.send(`授权失败: ${error}`);

    try {
        // 【关键修复】Secret 也进行清洗
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

        // 使用数据库更新 Token
        userRepo.updateToken(licenseKey, accessToken);

        // 自动检测并保存用户的 Notion 数据库 ID
        let detectedDbId = null;
        try {
            const searchRes = await axios.post('https://api.notion.com/v1/search', {
                filter: { value: 'database', property: 'object' },
                page_size: 1
            }, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Notion-Version': '2022-06-28'
                }
            });

            if (searchRes.data.results.length > 0) {
                detectedDbId = searchRes.data.results[0].id;
                userRepo.updateDatabaseId(licenseKey, detectedDbId);
                console.log(`[Callback] 自动检测到数据库: ${detectedDbId}`);
            } else {
                console.log(`[Callback] 未检测到数据库，用户需手动设置`);
            }
        } catch (dbErr) {
            console.log(`[Callback] 检测数据库失败: ${dbErr.message}`);
        }

        const dbMsg = detectedDbId
            ? `<p style="color:#059669;">✅ 已自动绑定 Notion 数据库</p>`
            : `<p style="color:#f59e0b;">⚠️ 未检测到数据库，请手动设置：<br><code>POST /set-database</code> 传入 <code>database_id</code></p>`;

        res.send(`
            <div style="text-align:center; padding-top:50px; font-family:sans-serif;">
                <h1 style="color:#10b981; font-size:40px;">🎉</h1>
                <h2>配置成功！</h2>
                <p>您的 Key: <b>${licenseKey}</b> 已成功绑定 Notion。</p>
                ${dbMsg}
                <p>现在，您可以在快捷指令中直接使用此 Key，无需再填写 Token。</p>
            </div>
        `);

    } catch (err) {
        console.error("Auth Error:", err.response?.data || err.message);
        res.send(`授权过程中发生错误: ${JSON.stringify(err.response?.data || err.message)}`);
    }
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

    if (!user.notion_token) return res.status(403).json({ error: "尚未绑定 Notion，请访问 /setup 页面进行配置" });

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

            let contentToProcess = payload.text || '';
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

                    // 截取前 6000 字符（纯文本信息密度远高于 HTML）
                    contentToProcess = `[URL]: ${payload.url}\n[正文内容]:\n${mainContent.substring(0, 6000)}`;
                    console.log(`[抓取成功] 提取纯文本 ${mainContent.length} 字符`);
                } catch (e) {
                    console.error("抓取失败:", e.message);
                    contentToProcess = `[URL]: ${payload.url}\n(网页抓取失败，请根据 URL 地址推测内容进行分析)`;
                }
            }

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
2. "Summary": 深度中文摘要（100-200字），要涵盖核心论点、关键数据和主要结论
3. "Tags": 3-5 个精准标签（数组格式，中文）
4. "Category": 从 ["文章", "工具", "灵感", "资源", "观点", "教程", "视觉"] 中选择最匹配的一个
5. "KeyInsight": 最核心的一句话洞察/金句（20-40字，一句话说清这篇内容最有价值的点）
6. "Difficulty": 从 ["入门", "进阶", "专业"] 中选择内容的难度等级
7. "ActionItems": 2-3 个可执行的行动要点（数组格式，每条 15-30 字，以动词开头）
8. "Emoji": 选择 1 个最能代表这篇内容主题的 emoji 符号

请务必只返回纯 JSON 格式数据，不要包含 Markdown 代码块标记。`
                    },
                    { role: "user", content: contentToProcess }
                ],
                response_format: undefined  // glm-4.6v 视觉模型不支持 json_object 模式
            });

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
                    "Difficulty": {
                        select: { name: aiResult.Difficulty || "入门" }
                    },
                    "Status": {
                        status: { name: "未开始" }
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

            console.log(`[任务成功] 已写入笔记: ${pageEmoji} ${aiResult.Title}`);

        } catch (err) {
            console.error("[后台处理严重错误]", err.response?.data || err.message);
        }
    })();
});

app.listen(PORT, () => {
    console.log(`Capture OS Pro Server running on port ${PORT}`);
    console.log(`[Database] 当前用户数: ${userRepo.count()}`);
});
