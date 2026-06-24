#!/bin/bash
# Shared Chrome detection & CDP helpers.
# Source this file: source "$(dirname "$0")/lib/chrome.sh"

detect_chrome() {
  [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && return
  for p in /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -f "$p" ] && echo "$p" && return
  done
  echo ""
}

CDP_PORT="${MYZT_CDP_PORT:-9222}"
CDP_URL="http://127.0.0.1:${CDP_PORT}"
USER_DATA_DIR="${HOME}/.config/chrome-myzt-debug"

# Whether Chrome debug (CDP) is reachable right now.
is_cdp_ready() {
  curl -sf --connect-timeout 2 "${CDP_URL}/json/version" >/dev/null 2>&1
}

# Whether a debug Chrome process is running on our CDP port.
is_debug_chrome_running() {
  pgrep -f "chrome.*remote-debugging-port=${CDP_PORT}" >/dev/null 2>&1
}

# Kill any existing debug Chrome (matching the specific CDP port) to get a clean slate.
kill_debug_chrome() {
  # 精确匹配端口号，避免误杀普通 Chrome（参考原始脚本）
  local pattern="chrome.*remote-debugging-port=${CDP_PORT}"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -f "$pattern" 2>/dev/null || true
    sleep 2

    # 如果普通关闭失败，强制关闭
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      pkill -9 -f "$pattern" 2>/dev/null || true
      sleep 1
    fi
  fi
  # Double-check: if CDP is still up, Chrome is still running
  if is_cdp_ready; then
    echo "⚠ 无法关闭旧的 Chrome，端口 ${CDP_PORT} 仍被占用" >&2
    return 1
  fi
  return 0
}
