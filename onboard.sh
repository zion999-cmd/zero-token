#!/bin/bash
# Zero Token 授权向导
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/lib/chrome.sh"

# Chrome 调试模式必须已启动
if ! is_cdp_ready; then
  if is_debug_chrome_running; then
    echo "✗ Chrome 进程已运行但 CDP (${CDP_URL}) 不可达"
    echo "  可能原因: 端口不是 ${CDP_PORT}，或 Chrome 正在启动中"
    echo "  尝试: ./start-chrome-debug.sh"
  else
    echo "✗ 未检测到 Chrome 调试模式"
    echo "  请先运行: ./start-chrome-debug.sh"
  fi
  exit 1
fi

echo "Zero Token — 启动 Web 模型授权向导..."
echo ""
exec node --import tsx src/onboard-webauth.ts
