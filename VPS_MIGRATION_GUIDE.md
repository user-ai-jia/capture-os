# Capture OS Pro - VPS 迁移指南

> 📅 创建日期：2026-01-27  
> 🎯 目标：将 Capture OS Pro 从 Sealos 迁移到独立 VPS

---

## 📋 系统概述

**Capture OS Pro** 是一个连接 iPhone 快捷指令、Notion 和 AI 服务的智能知识管理系统。

### 核心组件

| 组件 | 技术 | 功能 |
|------|------|------|
| 后端服务器 | Node.js + Express | 处理 API 请求、OAuth 授权流程 |
| AI 服务 | 智谱 AI (GLM-4.6V) | 深度分析内容、生成标题/摘要/标签/洞察/行动要点 |
| 网页解析 | Cheerio | 从 HTML 中提取纯文本正文，提升分析准确性 |
| 数据存储 | Notion API | 将结构化笔记写入 Notion（含页面正文 blocks） |
| 用户授权 | OAuth 2.0 | Notion 第三方应用授权 |
| 客户端 | iPhone 快捷指令 | 捕获网页/内容并发送到服务器 |

### 当前配置

- **服务地址**: `https://lwsqdvsktvbg.cloud.sealos.io`
- **端口**: 3000
- **用户数据**: SQLite 数据库 (`data/capture-os.db`)
- **AI 模型**: GLM-4.6V（1000万 token 额度）
- **最后更新**: 2026-02-15

---

## 🛒 迁移前准备清单

### 必须购买/准备

| 项目 | 说明 | 预估成本 | 必要性 |
|------|------|----------|--------|
| **VPS 服务器** | 云服务器 | ¥30-100/月 | ✅ 必须 |
| **域名** | 固定访问地址 | ¥50-100/年 | ✅ 必须 |
| **SSL 证书** | Let's Encrypt | 免费 | ✅ 必须 |

### 为什么需要域名？

1. **Notion OAuth 回调** - 必须使用 HTTPS 的固定域名
2. **iPhone 快捷指令** - 需要稳定的 API 地址
3. **安全性** - IP 地址无法配置 HTTPS

---

## 💻 VPS 硬件配置建议

### 资源消耗分析

| 组件 | CPU | 内存 | 硬盘 |
|------|-----|------|------|
| Node.js 服务 | 极低 | ~50MB | 忽略 |
| 智谱 AI 调用 | 外部 API | - | - |
| Notion API 调用 | 外部 API | - | - |
| 用户数据 | - | - | <1MB |
| Nginx | 极低 | ~20MB | - |
| 操作系统 | - | ~300MB | ~2GB |

### 推荐配置

| 级别 | 配置 | 适用场景 | 月费参考 |
|------|------|----------|----------|
| **⭐ 入门款（推荐）** | 1核 1GB 内存 20GB SSD | 个人使用，少量用户 | ¥30-50/月 |
| 标准款 | 2核 2GB 内存 40GB SSD | 多用户，预留扩展 | ¥60-100/月 |

> 💡 **结论**：应用非常轻量，**1核1G 完全足够**！

---

## 🌍 VPS 服务商推荐

### 国内服务商（需备案，延迟低）

| 服务商 | 入门价格 | 优点 | 链接 |
|--------|----------|------|------|
| 阿里云 ECS | ~¥50/月 | 稳定，生态完善 | aliyun.com |
| 腾讯云轻量 | ~¥40/月 | 性价比高 | cloud.tencent.com |
| 华为云 | ~¥45/月 | 企业级稳定 | huaweicloud.com |

### 海外服务商（无需备案，更灵活）

| 服务商 | 入门价格 | 优点 | 推荐节点 |
|--------|----------|------|----------|
| **Vultr** | $6/月 (~¥45) | 按小时计费，灵活 | 日本/新加坡 |
| **DigitalOcean** | $6/月 | 简单易用 | 新加坡 |
| **Bandwagon** | $50/年 (~¥30/月) | 便宜，CN2 线路 | 香港/日本 |
| **Racknerd** | $20/年起 | 超便宜 | 洛杉矶 |

> 💡 **建议**：选择 **香港/新加坡/日本节点**，无需备案且延迟低。

---

## 🔧 域名购买推荐

### 国内注册商

| 注册商 | 特点 | .com 价格 |
|--------|------|-----------|
| 阿里云（万网） | 管理方便 | ~¥70/年 |
| 腾讯云 DNSPod | 与腾讯云集成好 | ~¥65/年 |

### 海外注册商（无需备案）

| 注册商 | 特点 | .com 价格 |
|--------|------|-----------|
| **Cloudflare** | 免费 CDN + DNS | ~$10/年 |
| **Namecheap** | 便宜，隐私保护免费 | ~$10/年 |
| **Porkbun** | 超便宜 | ~$9/年 |

---

## 📝 迁移实施步骤

### 第一阶段：准备工作

- [ ] 购买 VPS 服务器
- [ ] 购买域名
- [ ] 将域名 DNS 指向 VPS IP
- [ ] 备份当前 `users.json` 数据

### 第二阶段：VPS 环境配置

```bash
# 1. 更新系统
sudo apt update && sudo apt upgrade -y

# 2. 安装 Node.js (v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 3. 安装 Nginx
sudo apt install -y nginx

# 4. 安装 PM2 进程管理器
sudo npm install -g pm2

# 5. 安装 Certbot (SSL 证书)
sudo apt install -y certbot python3-certbot-nginx
```

### 第三阶段：部署应用

```bash
# 1. 创建应用目录
sudo mkdir -p /var/www/capture-os
cd /var/www/capture-os

# 2. 上传代码（使用 scp 或 git）
# scp -r ./capture-os/* user@your-vps-ip:/var/www/capture-os/

# 3. 安装依赖
npm install

# 4. 配置环境变量
# 编辑 .env 文件，更新 BASE_URL 为你的新域名

# 5. 使用 PM2 启动
pm2 start server.js --name capture-os
pm2 save
pm2 startup
```

### 第四阶段：配置 Nginx 反向代理

```nginx
# /etc/nginx/sites-available/capture-os

server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# 启用站点
sudo ln -s /etc/nginx/sites-available/capture-os /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 第五阶段：配置 HTTPS

```bash
# 自动获取并配置 SSL 证书
sudo certbot --nginx -d your-domain.com

# 设置自动续期
sudo systemctl enable certbot.timer
```

### 第六阶段：更新配置

1. **更新 `.env` 文件**
   ```
   BASE_URL=https://your-domain.com
   ```

2. **更新 Notion Integration**
   - 登录 [Notion Developers](https://www.notion.so/my-integrations)
   - 更新 OAuth redirect URI 为 `https://your-domain.com/callback`

3. **更新 iPhone 快捷指令**
   - 将 API 地址改为新域名

### 第七阶段：验证与测试

- [ ] 访问 `https://your-domain.com/setup` 确认页面正常
- [ ] 测试 Notion OAuth 授权流程
- [ ] 使用快捷指令测试 `/capture` 接口
- [ ] 检查 PM2 日志确认无错误

---

## 🔒 安全加固建议

```bash
# 1. 配置防火墙
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable

# 2. 禁用 root SSH 登录
# 编辑 /etc/ssh/sshd_config
# PermitRootLogin no

# 3. 配置 fail2ban 防暴力破解
sudo apt install -y fail2ban
sudo systemctl enable fail2ban
```

---

## 📁 需要迁移的文件

| 文件 | 路径 | 说明 |
|------|------|------|
| `server.js` | `/capture-os/server.js` | 主程序 |
| `package.json` | `/capture-os/package.json` | 依赖配置 |
| `.env` | `/capture-os/.env` | 环境变量（需更新 BASE_URL） |
| `users.json` | `/capture-os/users.json` | ⚠️ 用户数据（重要！） |
| `public/` | `/capture-os/public/` | 前端静态文件 |

---

## ⚠️ 注意事项

1. **迁移 `users.json`** - 这是用户的 License Key 和 Notion Token 数据，务必备份！
2. **更新 Notion Integration** - 回调 URL 必须与新域名一致
3. **API Key 安全** - 不要将 `.env` 文件提交到 Git
4. **定期备份** - 建议设置 cron 定时备份 `users.json`

---

## 📞 常用命令速查

```bash
# PM2 管理
pm2 status           # 查看状态
pm2 logs capture-os  # 查看日志
pm2 restart capture-os  # 重启服务

# Nginx 管理
sudo nginx -t        # 测试配置
sudo systemctl reload nginx  # 重载配置

# SSL 证书
sudo certbot renew --dry-run  # 测试续期
```

---

## 📊 费用估算

| 项目 | 费用 | 周期 |
|------|------|------|
| VPS (1核1G) | ¥30-50 | /月 |
| 域名 (.com) | ¥50-100 | /年 |
| SSL 证书 | 免费 | - |
| **总计** | **约¥400-700** | **/年** |

---

*祝迁移顺利！🚀*
