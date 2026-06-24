#!/bin/bash
# 启动 Chrome 调试模式（用于 My Zero Token 连接）
# 兼容 macOS / Linux (含 Deepin) / Windows (Git Bash / WSL)
# 单实例：若已有调试 Chrome 则先关闭再重启

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/chrome.sh"

CHROME_PATH=$(detect_chrome)
[ -z "$CHROME_PATH" ] && echo "✗ 未找到 Chrome" && exit 1

echo "Chrome: $CHROME_PATH"
echo "端口: ${CDP_PORT}"
echo "用户数据目录: ${USER_DATA_DIR}"
echo ""

# ─── 单实例：关闭已有调试 Chrome（精确匹配端口号，避免误伤普通 Chrome）───
if pgrep -f "chrome.*remote-debugging-port=${CDP_PORT}" > /dev/null 2>&1; then
  echo "检测到已有调试 Chrome，正在关闭..."
  pkill -f "chrome.*remote-debugging-port=${CDP_PORT}" 2>/dev/null
  sleep 2

  if pgrep -f "chrome.*remote-debugging-port=${CDP_PORT}" > /dev/null 2>&1; then
    echo "普通关闭失败，尝试强制关闭..."
    pkill -9 -f "chrome.*remote-debugging-port=${CDP_PORT}" 2>/dev/null
    sleep 1
  fi

  if pgrep -f "chrome.*remote-debugging-port=${CDP_PORT}" > /dev/null 2>&1; then
    echo "✗ 无法关闭现有 Chrome，请手动执行: pkill -9 -f 'chrome.*remote-debugging-port=${CDP_PORT}'"
    exit 1
  fi
  echo "✓ 已关闭"
  echo ""
fi

# ─── 启动 Chrome ─────────────────────────────────────────────
TMP_LOG="/tmp/chrome-debug.log"

echo "正在启动 Chrome 调试模式..."
echo ""

"$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --disable-features=TranslateUI \
  '--remote-allow-origins=*' \
  > "$TMP_LOG" 2>&1 &

CHROME_PID=$!
echo "Chrome 日志: $TMP_LOG"

# ─── 等待启动 ────────────────────────────────────────────────
echo "等待 Chrome 启动..."
for i in {1..30}; do
  if curl -s "${CDP_URL}/json/version" > /dev/null 2>&1; then
    break
  fi
  echo -n "."
  sleep 1
done
echo ""
echo ""

# ─── 检查结果 ────────────────────────────────────────────────
if curl -s "${CDP_URL}/json/version" > /dev/null 2>&1; then
  VERSION_INFO=$(curl -s "${CDP_URL}/json/version" | jq -r '.Browser' 2>/dev/null || echo "未知版本")

  echo "✓ Chrome 调试模式启动成功！"
  echo ""
  echo "Chrome PID: $CHROME_PID"
  echo "Chrome 版本: $VERSION_INFO"
  echo "调试端口: ${CDP_URL}"
  echo "用户数据目录: $USER_DATA_DIR"
  echo ""
  echo "正在打开各 Web 平台登录页（便于授权）..."

  PLATFORMS=(
    "https://claude.ai/new"
    "https://chatgpt.com"
    "https://www.doubao.com/chat/"
    "https://chat.qwen.ai"
    "https://www.kimi.com"
    "https://gemini.google.com/app"
    "https://grok.com"
    "https://chat.deepseek.com/"
    "https://chatglm.cn"
    "https://www.qianwen.com/chat/"   # Qwen CN (domestic)
    "https://www.perplexity.ai"
  )
  for url in "${PLATFORMS[@]}"; do
    "$CHROME_PATH" --remote-debugging-port="$CDP_PORT" --user-data-dir="$USER_DATA_DIR" "$url" > /dev/null 2>&1 &
    sleep 0.5
  done

  echo "✓ 已打开 ${#PLATFORMS[@]} 个标签页"
  echo ""
  echo "=========================================="
  echo "下一步操作："
  echo "=========================================="
  echo "1. 在各标签页中登录需要使用的平台"
  echo "2. 确保 config 中 browser.attachOnly=true 且 browser.cdpUrl=${CDP_URL}"
  echo "3. 运行 ./onboard.sh 完成授权（将复用此浏览器）"
  echo ""
  echo "停止调试模式："
  echo "  pkill -f 'chrome.*remote-debugging-port=${CDP_PORT}'"
  echo "=========================================="
else
  echo "✗ Chrome 启动失败"
  echo ""
  echo "请检查："
  echo "  1. Chrome 路径: $CHROME_PATH"
  echo "  2. 端口 ${CDP_PORT} 是否被占用: lsof -i:${CDP_PORT}"
  echo "  3. 用户数据目录权限: $USER_DATA_DIR"
  echo "  4. 启动日志: $TMP_LOG"
  echo ""
  echo "尝试手动启动："
  echo "  \"$CHROME_PATH\" --remote-debugging-port=${CDP_PORT} --user-data-dir=\"$USER_DATA_DIR\""
  exit 1
fi
