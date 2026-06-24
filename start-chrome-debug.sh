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
  # 如果 Chrome 进程存在但 CDP 暂不可达，可能正在启动中——先等一等
  if is_debug_chrome_running; then
    echo "  Chrome 进程已存在，等待 CDP 就绪..."
    for i in $(seq 1 10); do
      if is_cdp_ready; then
        echo "✓ Chrome 调试模式已就绪 (${CDP_URL})"
        break 2  # 跳出外层 if-else，继续后面的标签页打开
      fi
      sleep 1
    done
    echo "  CDP 仍未就绪，重新启动 Chrome..."
  fi

  # 尝试杀掉旧进程再启动
  kill_debug_chrome

  # 清理僵死的 SingletonLock（Chrome 崩溃残留会导致启动卡住）
  _lock="$USER_DATA_DIR/SingletonLock"
  if [ -L "$_lock" ]; then
    _target=$(readlink "$_lock" 2>/dev/null || true)
    if [ -n "$_target" ]; then
      # 提取 PID 检查是否存活
      _lock_pid="${_target##*-}"
      if ! kill -0 "$_lock_pid" 2>/dev/null; then
        rm -f "$_lock" && echo "  已清理僵死 SingletonLock ($_target)"
      fi
    fi
  fi

  echo "启动 Chrome 调试模式..."
  "$CHROME_PATH" \
    --remote-debugging-port="$CDP_PORT" \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --disable-background-networking \
    --disable-background-mode \
    --disable-sync \
    --disable-features=MediaRouter \
    --remote-allow-origins=* \
    > /tmp/chrome-debug.log 2>&1 &

  # 等待 CDP 就绪（最多 60 秒）
  started=0
  for i in $(seq 1 60); do
    if is_cdp_ready; then
      echo "✓ Chrome 启动成功！"
      started=1
      break
    fi
    [ $((i % 10)) -eq 0 ] && echo "  等待中... (${i}s)"
    sleep 1
  done
  if [ "$started" = "0" ]; then
    echo "✗ Chrome 启动失败（${CDP_URL} 不可达，已等待 60s）"
    echo "  Chrome 进程: $(pgrep -fli 'chrome.*remote-debugging' 2>/dev/null | head -1 || echo '无')"
    echo "  查看日志: /tmp/chrome-debug.log"
    exit 1
  fi
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
  # 用 CDP API 打开标签页，比 spawn Chrome 进程可靠得多
  curl -sf "${CDP_URL}/json/new?${url}" >/dev/null 2>&1
  sleep 0.15
done
echo "✓ 已全部打开"
