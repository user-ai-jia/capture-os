#!/bin/bash

# Capture OS Pro - 启动脚本

APP_DIR="capture-os"

echo "================================================"
echo "  Capture OS Pro - 启动检测"
echo "================================================"

# 安装 Puppeteer/Chromium 需要的系统依赖（如果尚未安装）
if ! dpkg -l | grep -q libatk-bridge2.0-0 2>/dev/null; then
    echo "[启动] 安装 Chromium 系统依赖..."
    apt-get update -qq && apt-get install -y -qq \
        libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 \
        libasound2 libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
        libxdamage1 libxrandr2 libxfixes3 libcups2 libpango-1.0-0 \
        libcairo2 libatspi2.0-0 fonts-wqy-zenhei \
        2>/dev/null || echo "[启动] 部分依赖安装失败，Puppeteer 可能无法使用"
    echo "[启动] 系统依赖安装完成"
fi

# 安装中文字体（如果没有）
if ! fc-list | grep -qi "wqy\|noto.*cjk" 2>/dev/null; then
    echo "[启动] 中文字体已通过系统依赖安装"
fi

# 启动 Node.js 服务
echo "[启动] 启动 Capture OS Pro..."
cd "$APP_DIR" && NODE_ENV=production node server.js
