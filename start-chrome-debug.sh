#!/bin/bash
# 启动 Chrome 调试模式 + 打开所有 LLM 平台

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/chrome.sh"

CHROME_PATH=$(detect_chrome)
[ -z "$CHROME_PATH" ] && echo "✗ 未找到 Chrome" && exit 1

# 如果 CDP 已经是可达的，直接复用，不重启
if is_cdp_ready; then
  echo "✓ Chrome 调试模式已在运行 (${CDP_URL})"
else
  # 尝试杀掉旧进程再启动
  kill_debug_chrome

  echo "启动 Chrome 调试模式..."
  "$CHROME_PATH" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-sync \
    --remote-allow-origins=* \
    > /tmp/chrome-debug.log 2>&1 &

  # 等待 CDP 就绪（最多 30 秒）
  for i in $(seq 1 30); do
    if is_cdp_ready; then
      echo "✓ Chrome 启动成功！"
      break
    fi
    sleep 1
  done
fi

# 最终检查
if ! is_cdp_ready; then
  echo "✗ Chrome 启动失败（${CDP_URL} 不可达）"
  echo "  查看日志: /tmp/chrome-debug.log"
  exit 1
fi

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
