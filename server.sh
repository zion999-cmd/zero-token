#!/bin/bash
# Zero Token — Gateway 服务管理脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib/chrome.sh"

PID_FILE="$SCRIPT_DIR/.gateway.pid"
LOG_FILE="$SCRIPT_DIR/.gateway.log"
PORT="${MYZT_PORT:-3001}"
HOST="${MYZT_HOST:-127.0.0.1}"

is_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

# Reads the gateway access key from config/config.json (empty when unset).
read_api_key() {
  python3 -c "import json; d=json.load(open('$SCRIPT_DIR/config/config.json')); print(d.get('api_key',''))" 2>/dev/null || echo ""
}

# Prints the client-facing connection info. The key goes to stdout only —
# never to .gateway.log — so it stays out of the persisted log file.
print_access_info() {
  echo "  http://$HOST:$PORT"
  local api_key
  api_key=$(read_api_key)
  if [ -n "$api_key" ]; then
    echo "  API Key: $api_key"
  else
    echo "  API Key: (未设置 — 网关不校验鉴权)"
  fi
}

cmd_start() {
  if is_running; then
    echo "✓ Gateway 已在运行 (PID $(cat "$PID_FILE"), port $PORT)"
    print_access_info
    return 0
  fi

  # 提示 Chrome 状态
  if ! is_cdp_ready; then
    echo "⚠ Chrome 调试模式未启动——需要 Chrome 的模型 (Qwen/Kimi/GLM) 将不可用"
    echo "  启动 Chrome: ./start-chrome-debug.sh"
    echo ""
  fi

  # 占用端口则清理
  local occupant
  occupant=$(lsof -ti ":$PORT" 2>/dev/null | head -1 || true)
  [ -n "$occupant" ] && kill "$occupant" 2>/dev/null && sleep 1

  echo "启动 Gateway..."
  cd "$SCRIPT_DIR"
  nohup node --max-old-space-size=4096 --import tsx src/index.ts >> "$LOG_FILE" 2>&1 &
  echo "$(date '+%Y-%m-%d %H:%M:%S') Gateway started (PID $!)" >> "$LOG_FILE"
  echo $! > "$PID_FILE"

  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "http://$HOST:$PORT/health" &>/dev/null; then
      echo "✓ Gateway 已启动 (PID $(cat "$PID_FILE"), port $PORT)"
      print_access_info
      return 0
    fi
  done

  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "✓ Gateway 进程已启动 (PID $(cat "$PID_FILE"), port $PORT)"
  else
    echo "✗ 启动失败，查看日志: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

cmd_stop() {
  if ! is_running; then
    echo "Gateway 未运行"
    return 0
  fi
  local pid=$(cat "$PID_FILE")
  echo "停止 Gateway (PID $pid)..."
  kill "$pid" 2>/dev/null
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.3
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "✓ Gateway 已停止"
}

cmd_restart() { cmd_stop; sleep 0.5; cmd_start; }

cmd_status() {
  # Gateway 状态
  if is_running; then
    echo "✓ Gateway 运行中 (PID $(cat "$PID_FILE"), port $PORT)"
    echo "  地址: http://$HOST:$PORT"
    local api_key
    api_key=$(read_api_key)
    [ -n "$api_key" ] && echo "  API Key: $api_key"
  else
    echo "✗ Gateway 未运行"
    [ -f "$LOG_FILE" ] && echo "" && echo "最近日志:" && tail -5 "$LOG_FILE" | sed 's/^/  /'
  fi

  # Chrome CDP 状态
  echo ""
  if is_cdp_ready; then
    echo "✓ Chrome 调试模式: ${CDP_URL}"
    echo "  (Qwen/Kimi/GLM 等需要浏览器的模型可用)"
  else
    echo "✗ Chrome 调试模式不可达 (${CDP_URL})"
    if is_debug_chrome_running; then
      echo "  Chrome 进程存在但 CDP 端口不对——检查 \${MYZT_CDP_PORT}"
    else
      echo "  运行 ./start-chrome-debug.sh 启动"
    fi
  fi

  # 模型列表
  if is_running; then
    echo ""
    echo "可用模型:"
    API_KEY_VAL=$(read_api_key)
    curl -sf "http://$HOST:$PORT/v1/models" \
      ${API_KEY_VAL:+-H "Authorization: Bearer $API_KEY_VAL"} 2>/dev/null \
      | python3 -c "
import json, sys
d = json.load(sys.stdin)
for m in d.get('data', []):
    auth = ' ✓' if m.get('authorized') else ''
    print(f'  {m[\"id\"]}{auth}')
" 2>/dev/null || echo "  (无法获取模型列表)"
  fi
}

CMD="${1:-start}"
case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  *)
    echo "用法: $(basename "$0") {start|stop|restart|status}"
    echo ""
    echo "环境变量: MYZT_PORT=$PORT  MYZT_HOST=$HOST  MYZT_CDP_PORT=$CDP_PORT"
    ;;
esac
