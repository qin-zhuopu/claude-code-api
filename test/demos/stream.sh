#!/bin/bash

# 流式输出 Demo - 自动启动/关闭测试服务器（随机端口）

PROMPT="请写一篇关于 Claude Code 的中文介绍，字数控制在 1000 到 2000 字（汉字）之间。

内容应包括：
1. Claude Code 是什么及其核心目标
2. 主要功能和特性
3. 工作原理（架构概述）
4. 使用场景和目标用户
5. 与其他工具的集成
6. 与类似工具的对比
7. 快速入门指南
8. 使用技巧和最佳实践

请用清晰、信息丰富的风格撰写。"

echo "正在构建项目..."
npm run build --silent 2>/dev/null

if [ ! -d "dist" ]; then
  echo "❌ 构建失败，dist 目录不存在"
  exit 1
fi

echo "正在启动测试服务器..."

# 设置 PORT=0 让系统分配随机端口
PORT=0 node dist/main.js > /tmp/server-$$.log 2>&1 &
SERVER_PID=$!

# 等待服务器启动
sleep 3

# 从日志中解析端口
PORT=$(grep -o "Application is running on http://[^\:]*:\([0-9]*\)" /tmp/server-$$.log | head -1 | grep -o "[0-9]*$")

if [ -z "$PORT" ]; then
  # 尝试从最后一个监听的端口获取
  PORT=$(lsof -ti -iTCP -sTCP:LISTEN -a -c node 2>/dev/null | head -1)
fi

if [ -z "$PORT" ]; then
  echo "❌ 无法确定服务器端口"
  cat /tmp/server-$$.log
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo "✓ 服务器已启动: http://localhost:$PORT"
echo ""
echo "========== Claude Code 流式输出 Demo =========="
echo "=============================================="
echo ""

# 发送请求（流式输出）
curl -N -X POST "http://localhost:$PORT/api/query" \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"$PROMPT\",
    \"options\": {
      \"env\": {
        \"ANTHROPIC_AUTH_TOKEN\": \"$ANTHROPIC_AUTH_TOKEN\",
        \"ANTHROPIC_BASE_URL\": \"$ANTHROPIC_BASE_URL\",
        \"API_TIMEOUT_MS\": \"$API_TIMEOUT_MS\",
        \"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\": \"$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\"
      },
      \"tools\": [],
      \"skills\": []
    }
  }"

echo ""
echo ""
echo "=============================================="
echo "✅ 完成！正在关闭服务器..."
kill $SERVER_PID 2>/dev/null
rm -f /tmp/server-$$.log
