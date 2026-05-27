#!/bin/bash
# 启动 Chrome 调试模式 + 打开所有 LLM 平台

detect_chrome() {
  [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && return
  for p in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

CHROME_PATH=$(detect_chrome)
USER_DATA_DIR="$HOME/.config/chrome-myzt-debug"

[ -z "$CHROME_PATH" ] && echo "✗ 未找到 Chrome" && exit 1

# 关闭已有的调试 Chrome
pgrep -f "chrome.*remote-debugging-port=9222" >/dev/null 2>&1 && pkill -f "chrome.*remote-debugging-port=9222" 2>/dev/null && sleep 2

# 启动调试 Chrome（单实例）
"$CHROME_PATH" \
  --remote-debugging-port=9222 \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --remote-allow-origins=* \
  > /tmp/chrome-debug.log 2>&1 &

echo "启动 Chrome 调试模式..."

for i in $(seq 1 15); do
  if curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    echo "✓ Chrome 启动成功！"
    echo ""

    PLATFORMS=(
      "https://chat.deepseek.com/"
      "https://claude.ai/new"
      "https://chatgpt.com"
      "https://www.kimi.com"
      "https://chatglm.cn"
      "https://grok.com"
      "https://www.qianwen.com/chat/"
      "https://chat.qwen.ai"
      "https://www.doubao.com/chat/"
      "https://www.perplexity.ai"
      "https://gemini.google.com/app"
    )
    echo "正在打开 ${#PLATFORMS[@]} 个标签页..."
    for url in "${PLATFORMS[@]}"; do
      # 用相同 user-data-dir 打开标签页（复用已有调试 Chrome 实例）
      "$CHROME_PATH" --user-data-dir="$USER_DATA_DIR" "$url" >/dev/null 2>&1 &
      sleep 0.3
    done
    echo "✓ 已全部打开"
    exit 0
  fi
  sleep 1
done

echo "✗ Chrome 启动失败"
exit 1
