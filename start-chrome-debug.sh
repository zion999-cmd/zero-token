#!/bin/bash
# 启动 Chrome 调试模式 + 打开所有 LLM 平台

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/chrome.sh"

CHROME_PATH=$(detect_chrome)
[ -z "$CHROME_PATH" ] && echo "✗ 未找到 Chrome" && exit 1

kill_debug_chrome

# 启动调试 Chrome（单实例）
"$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --remote-allow-origins=* \
  > /tmp/chrome-debug.log 2>&1 &

echo "启动 Chrome 调试模式..."

for i in $(seq 1 15); do
  if is_cdp_ready; then
    echo "✓ Chrome 启动成功！"
    echo ""

    PLATFORMS=(
      "https://chat.deepseek.com/"
      "https://claude.ai/new"
      "https://chatgpt.com"
      "https://www.kimi.com"
      "https://chatglm.cn"
      "https://grok.com"
      "https://www.qianwen.com/chat/"   # Qwen CN (domestic)
      "https://chat.qwen.ai"           # Qwen Intl (international)
      "https://www.doubao.com/chat/"
      "https://www.perplexity.ai"
      "https://gemini.google.com/app"
    )
    echo "正在打开 ${#PLATFORMS[@]} 个标签页..."
    for url in "${PLATFORMS[@]}"; do
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
