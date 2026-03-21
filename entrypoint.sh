#!/bin/bash

# Capture OS Pro - 启动脚本 (Sealos 专用)
# 方案：运行时库走 apt（无 systemd 依赖）+ Chrome 二进制下载到持久化存储卷

set -e

APP_DIR="capture-os"
CHROME_CACHE_DIR="/home/node/.puppeteer-cache"

echo "================================================"
echo "  Capture OS Pro - 启动检测"
echo "================================================"

# ── 1. 安装 Chrome 运行时共享库（不装 chromium 包，避免 systemd 依赖链）──
echo "[启动] 安装 Chrome 运行时依赖库..."
apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    libnss3 libnspr4 \
    libgbm1 \
    libatk1.0-0 libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
    libxkbcommon0 \
    libx11-xcb1 \
    libpango-1.0-0 libcairo2 \
    libatspi2.0-0 \
    libcups2 \
    libglib2.0-0 \
    libasound2 \
    fonts-wqy-zenhei \
    wget ca-certificates \
    2>/dev/null || echo "[启动] 部分依赖安装失败，继续..."
echo "[启动] 运行时库安装完成"

# ── 2. 检查是否已有 Chrome 二进制（持久化存储卷，重启不丢失）──────────
CHROME_BIN=$(find "$CHROME_CACHE_DIR" -name "chrome" -type f 2>/dev/null | head -1)

if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
    echo "[启动] 已有 Chrome 二进制: $CHROME_BIN"
else
    echo "[启动] 下载 Chrome for Testing 到持久化存储卷..."
    mkdir -p "$CHROME_CACHE_DIR"

    cd /tmp

    # 获取最新稳定版本号
    CHROME_VERSION=$(wget -qO- "https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE" 2>/dev/null || echo "")

    if [ -z "$CHROME_VERSION" ]; then
        echo "[启动] ⚠️ 无法获取 Chrome 版本，使用 @puppeteer/browsers 安装..."
        cd /home/node/capture-os/capture-os
        npx --yes @puppeteer/browsers install chrome@stable --path "$CHROME_CACHE_DIR"
    else
        echo "[启动] Chrome 版本: $CHROME_VERSION"
        CHROME_URL="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"
        echo "[启动] 下载: $CHROME_URL"

        # ⚡ 关键：下载到持久化存储卷（/tmp 是 tmpfs/内存文件系统，170MB 会 OOM）
        wget -q -O "$CHROME_CACHE_DIR/chrome-linux64.zip" "$CHROME_URL"
        echo "[启动] 解压中..."
        unzip -q "$CHROME_CACHE_DIR/chrome-linux64.zip" -d "$CHROME_CACHE_DIR/"
        # 立即删除 zip，释放磁盘空间
        rm -f "$CHROME_CACHE_DIR/chrome-linux64.zip"

        chmod +x "$CHROME_CACHE_DIR/chrome-linux64/chrome"
    fi

    CHROME_BIN=$(find "$CHROME_CACHE_DIR" -name "chrome" -type f 2>/dev/null | head -1)
    echo "[启动] Chrome 已安装: $CHROME_BIN"
fi

# ── 3. 导出 Chrome 路径 ────────────────────────────────────────────────
if [ -n "$CHROME_BIN" ]; then
    export CHROMIUM_EXECUTABLE_PATH="$CHROME_BIN"
    echo "[启动] CHROMIUM_EXECUTABLE_PATH=$CHROMIUM_EXECUTABLE_PATH"
else
    echo "[启动] ⚠️ Chrome 未找到，视频提取功能不可用"
fi

# ── 4. 安装 npm 依赖────────────────────────────────────────────────────
echo "[启动] 安装 npm 依赖..."
cd "/home/node/capture-os/$APP_DIR"
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install --omit=dev --silent
echo "[启动] npm 依赖就绪"

# ── 5. 启动 Node.js 服务 ───────────────────────────────────────────────
echo "[启动] 启动 Capture OS Pro..."
NODE_ENV=production node server.js
