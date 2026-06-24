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
  curl -s "${CDP_URL}/json/version" >/dev/null 2>&1
}

# Whether a debug Chrome process is running (any port, any user-dir).
# macOS pgrep is case-sensitive, so match both "chrome" and "Chrome".
is_debug_chrome_running() {
  pgrep -fi "chrome.*remote-debugging-port" >/dev/null 2>&1
}

# Kill any existing debug Chrome to get a clean slate.
kill_debug_chrome() {
  if is_debug_chrome_running; then
    pkill -fi "chrome.*remote-debugging-port" 2>/dev/null || true
    # Also try to free the CDP port in case Chrome didn't shut down cleanly
    local occupant
    occupant=$(lsof -ti ":${CDP_PORT}" 2>/dev/null | head -1 || true)
    [ -n "$occupant" ] && kill "$occupant" 2>/dev/null || true
    sleep 2
  fi
  # Double-check: if CDP is still up, Chrome is still running
  if is_cdp_ready; then
    echo "⚠ 无法关闭旧的 Chrome，端口 ${CDP_PORT} 仍被占用" >&2
    return 1
  fi
  return 0
}
