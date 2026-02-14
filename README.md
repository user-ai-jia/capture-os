# Capture OS Pro

> 📱 连接 iPhone 快捷指令、Notion 和 AI 的智能知识管理系统

## 🚀 功能特性

- **一键捕获** — iPhone 快捷指令分享即存，自动处理
- **智能解析** — Cheerio 提取网页纯文本，精准分析
- **AI 深度分析** — 智谱 GLM-4 自动生成标题、摘要、标签、核心洞察、行动要点
- **精美笔记** — Notion 页面自动排版：💡 洞察 Callout + 📖 摘要 + ✅ 行动清单 + 📎 原文链接
- **商业就绪** — License Key 激活码系统 + SQLite 数据库 + API 限速防护

## 📋 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js + Express |
| AI | 智谱 AI (GLM-4) |
| 网页解析 | Cheerio |
| 数据库 | SQLite (better-sqlite3) |
| 存储 | Notion API |
| 授权 | OAuth 2.0 |

## 🔧 快速启动

```bash
cd capture-os
npm install
cp .env.example .env  # 编辑填入你的 API Key
node server.js
```

## 📂 项目结构

```
capture-os/
├── server.js          # 主服务（API + OAuth + AI + Notion）
├── db/
│   ├── database.js    # SQLite 连接和初始化
│   └── userRepo.js    # 用户数据操作
├── public/
│   └── index.html     # 激活页面（毛玻璃设计）
├── keygen.js          # 激活码批量生成器
├── migrate.js         # JSON → SQLite 迁移工具
├── set-admin.js       # 管理员设置工具
└── .env               # 环境变量配置
```