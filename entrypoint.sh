#!/bin/bash

# Capture OS Pro - 启动脚本 (Sealos 专用)
# 方案：puppeteer-core + 系统 Chromium（避免 npm install OOM）

APP_DIR="capture-os"

echo "================================================"
echo "  Capture OS Pro - 启动检测"
echo "================================================"

# ── 1. 安装系统 Chromium + 所有运行依赖 ──────────────────────
echo "[启动] 检查系统 Chromium..."
if ! command -v chromium-browser &>/dev/null && ! command -v chromium &>/dev/null; then
    echo "[启动] 安装 Chromium 及依赖库..."
    apt-get update -qq && apt-get install -y -qq \
        chromium \
        libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
        libasound2 libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
        libxdamage1 libxrandr2 libxfixes3 libcups2 libpango-1.0-0 \
        libcairo2 libatspi2.0-0 fonts-wqy-zenhei \
        2>/dev/null || echo "[启动] 部分依赖安装失败，继续启动..."
    echo "[启动] Chromium 安装完成"
else
    echo "[启动] 系统 Chromium 已存在，跳过安装"
fi

# ── 2. 导出 Chromium 路径供 puppeteer-core 使用 ──────────────
CHROMIUM_PATH=$(command -v chromium-browser || command -v chromium || echo "")
if [ -n "$CHROMIUM_PATH" ]; then
    export CHROMIUM_EXECUTABLE_PATH="$CHROMIUM_PATH"
    echo "[启动] Chromium 路径: $CHROMIUM_PATH"
else
    echo "[启动] ⚠️  未找到系统 Chromium，视频提取功能将不可用"
fi

# ── 3. 安装 npm 依赖（puppeteer-core 无 Chromium 下载，极快）──
echo "[启动] 安装 npm 依赖..."
cd "$APP_DIR"
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --production 2>/dev/null \
    || echo "[启动] npm install 警告（非致命）"
echo "[启动] npm 依赖就绪"

# ── 4. 启动 Node.js 服务 ─────────────────────────────────────
echo "[启动] 启动 Capture OS Pro..."
NODE_ENV=production node server.js
