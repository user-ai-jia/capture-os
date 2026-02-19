#!/bin/bash
# ============================================================
# Capture OS Pro - 一键启动脚本
# 
# 用法：bash start.sh
# 
# 解决 Sealos 终端断开后需要从头配置的问题
# 此脚本会自动完成所有初始化步骤并后台运行服务
# ============================================================

echo ""
echo "🚀 Capture OS Pro 一键启动"
echo "=========================="

# 停掉旧进程
pkill -f "node server.js" 2>/dev/null
sleep 1

# 确保在项目目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 确保 data 目录存在
mkdir -p data

# 检查 .env 是否存在
if [ ! -f ".env" ]; then
    echo "❌ 未找到 .env 文件！"
    echo "请先创建 .env 文件，包含以下内容："
    echo "  PORT=3000"
    echo "  ZHIPU_API_KEY=你的智谱API密钥"
    echo "  NOTION_CLIENT_ID=你的Notion客户端ID"
    echo "  NOTION_CLIENT_SECRET=你的Notion客户端密钥"
    echo "  BASE_URL=你的服务地址"
    exit 1
fi
echo "✅ .env 已加载"

# 初始化数据库
echo "📦 初始化数据库..."
node migrate.js 2>/dev/null
node set-admin.js 2>/dev/null

# 后台启动服务（使用 nohup，关闭终端也不会停）
echo "🔧 启动服务器（后台运行）..."
nohup node server.js > app.log 2>&1 &
SERVER_PID=$!

# 等待启动
sleep 2

# 检查是否启动成功
if kill -0 $SERVER_PID 2>/dev/null; then
    echo ""
    echo "=========================="
    echo "✅ 启动成功！PID: $SERVER_PID"
    echo "=========================="
    echo ""
    echo "📡 服务地址: https://lwsqdvsktvbg.cloud.sealos.io"
    echo "📋 查看日志: tail -f $SCRIPT_DIR/app.log"
    echo "🛑 停止服务: pkill -f 'node server.js'"
    echo ""
    echo "💡 关闭终端也不会影响服务运行"
    echo "   下次打开终端只需查看日志即可"
    echo "=========================="
    
    # 显示最新几行日志确认正常
    echo ""
    echo "📜 最新日志："
    tail -5 app.log
else
    echo "❌ 启动失败，查看错误日志："
    cat app.log
fi
