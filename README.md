# Capture OS Pro

> 📱 连接 iPhone 快捷指令、Notion 和 AI 的智能知识管理系统

## 🚀 功能特性

- **一键捕获** — iPhone 快捷指令分享即存，自动处理
- **智能解析** — Cheerio 提取网页纯文本，精准分析
- **AI 深度分析** — 智谱 GLM-4.6V 自动生成标题、摘要、标签、核心洞察、行动要点
- **精美笔记** — Notion 页面自动排版：💡 洞察 Callout + 📖 摘要 + ✅ 行动清单 + 📎 原文链接
- **智能数据库发现** — Notion 数据库 ID 三层自动解析（已保存 → OAuth 检测 → 手动设置）
- **商业就绪** — License Key 激活码系统 + SQLite 数据库 + API 限速防护

---

## 📋 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| AI | 智谱 AI (GLM-4.6V) |
| 网页解析 | Cheerio |
| 视频处理 | Puppeteer-core + 系统 Chromium |
| 语音转录 | 讯飞 ASR |
| 数据库 | SQLite (better-sqlite3) |
| 存储 | Notion API |
| 授权 | OAuth 2.0 |

---

## 📂 项目结构

```
project/
├── entrypoint.sh          # Sealos 容器启动脚本（安装系统依赖 → 启动服务）
├── capture-os/
│   ├── server.js          # 主服务（API + OAuth + AI + Notion）
│   ├── db/
│   │   ├── database.js    # SQLite 连接和初始化
│   │   └── userRepo.js    # 用户数据操作
│   ├── lib/
│   │   └── videoHandler.js  # 视频 URL 提取 + 下载 + ASR 转录
│   ├── public/
│   │   └── index.html     # 激活页面（毛玻璃设计）
│   ├── keygen.js          # 激活码批量生成器
│   ├── migrate.js         # JSON → SQLite 迁移工具
│   ├── set-admin.js       # 管理员设置工具
│   └── .env               # 环境变量配置（不提交 Git）
└── VPS_MIGRATION_GUIDE.md # VPS 迁移参考文档（备用方案）
```

---

## 🌐 当前部署

| 项目 | 信息 |
|------|------|
| **部署平台** | [Sealos](https://sealos.io)（容器云平台） |
| **服务地址** | `https://lwsqdvsktvbg.cloud.sealos.io` |
| 启动脚本 | `entrypoint.sh` |
| 端口 | 3000 |
| AI 模型 | GLM-4.6V（视觉/文本） |
| 最后更新 | 2026-03-21 |

---

## ☁️ Sealos 部署说明

### 平台配置

| 配置项 | 值 |
|--------|----|
| 平台 | Sealos Cloud |
| 运行时 | Node.js 容器 |
| 启动脚本 | `entrypoint.sh`（项目根目录） |
| 应用目录 | `capture-os/` |
| 端口 | 3000 |

### 必须配置的环境变量

在 **Sealos 控制台 → 应用配置 → 环境变量** 中设置：

```env
PORT=3000
ZHIPU_API_KEY=你的智谱API密钥
NOTION_CLIENT_ID=你的Notion应用ID
NOTION_CLIENT_SECRET=你的Notion应用密钥
BASE_URL=https://lwsqdvsktvbg.cloud.sealos.io
```

> ⚠️ `.env` 文件**不要提交到 Git**，敏感信息统一在 Sealos 控制台配置

### 启动流程

Sealos 容器启动时自动执行根目录的 `entrypoint.sh`，该脚本会：

1. 安装 Puppeteer / Chromium 所需系统依赖（libatk、libnss3、libgbm 等）
2. 安装中文字体（`fonts-wqy-zenhei`）
3. 进入 `capture-os/` 目录，以 `NODE_ENV=production` 启动 `server.js`

---

## 🔄 更新部署步骤（Sealos）

每次修改代码后，按以下步骤重新部署到 Sealos：

### 方式一：通过 Sealos 控制台文件上传

1. 在本地修改 `capture-os/` 下的代码文件
2. 登录 [Sealos 控制台](https://cloud.sealos.io)
3. 进入应用 → **文件管理器**，上传修改的文件
4. 在控制台重启应用（或等待自动重启）
5. 查看**应用日志**确认启动无报错

### 方式二：通过 Sealos Terminal（推荐）

1. 登录 Sealos 控制台 → 打开 **Terminal**
2. 进入应用目录，更新代码后重启：

```bash
# 停止旧进程
pkill -f "node server.js"

# 重新安装依赖（如 package.json 有变化）
cd /app/capture-os && npm install --production

# 手动重启（或让容器自动重启）
node server.js
```

### 验证部署

```
访问: https://lwsqdvsktvbg.cloud.sealos.io/setup
确认: 页面正常加载
检查: Sealos 控制台日志无 ERROR
```

---

## 🔧 本地快速启动（开发调试）

```bash
cd capture-os
npm install
# 编辑 .env 填入 API Key
node server.js
```

---

## ⚠️ 注意事项

1. **Puppeteer** — Sealos 上使用 `puppeteer-core` + 系统 Chromium，避免 OOM
2. **用户数据** — SQLite 数据库在 `data/capture-os.db`，重新部署时注意数据持久化
3. **Notion OAuth** — 回调地址必须与 `BASE_URL` 一致，更新地址后需同步更新 [Notion Developers](https://www.notion.so/my-integrations)
4. **VPS 迁移** — 若计划迁移到独立 VPS，参考 `VPS_MIGRATION_GUIDE.md`