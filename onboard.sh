#!/bin/bash
# My Zero Token 授权向导
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/lib/chrome.sh"

# Chrome 调试模式必须已启动
if ! is_cdp_ready; then
  if is_debug_chrome_running; then
    echo "✗ Chrome 已在运行但 CDP (${CDP_URL}) 不可达——端口可能不是 ${CDP_PORT}"
  else
    echo "✗ 未检测到 Chrome 调试模式——请先运行: ./start-chrome-debug.sh"
  fi
  exit 1
fi

echo "My Zero Token — 启动 Web 模型授权向导..."
echo ""
exec node --import tsx src/onboard-webauth.ts
