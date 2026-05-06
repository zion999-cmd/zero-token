#!/bin/bash
# My Zero Token — Gateway 服务管理脚本
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/.gateway.pid"
LOG_FILE="$SCRIPT_DIR/.gateway.log"
PORT="${MYZT_PORT:-3001}"
HOST="${MYZT_HOST:-127.0.0.1}"

is_running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

cmd_start() {
  if is_running; then
    echo "✓ Gateway 已在运行 (PID $(cat "$PID_FILE"), port $PORT)"
    echo "  http://$HOST:$PORT"
    return 0
  fi

  # 占用端口则清理
  local occupant
  occupant=$(lsof -ti ":$PORT" 2>/dev/null | head -1 || true)
  [ -n "$occupant" ] && kill "$occupant" 2>/dev/null && sleep 1

  echo "启动 Gateway..."
  cd "$SCRIPT_DIR"
  nohup node --import tsx src/index.ts > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "http://$HOST:$PORT/health" &>/dev/null; then
      echo "✓ Gateway 已启动 (PID $(cat "$PID_FILE"), port $PORT)"
      echo "  http://$HOST:$PORT"
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
  if is_running; then
    echo "✓ Gateway 运行中 (PID $(cat "$PID_FILE"), port $PORT)"
    echo "  地址: http://$HOST:$PORT"
    echo ""
    echo "可用模型:"
    curl -sf "http://$HOST:$PORT/v1/models" 2>/dev/null \
      | python3 -c "
import json, sys
d = json.load(sys.stdin)
for m in d.get('data', []):
    auth = ' ✓' if m.get('authorized') else ''
    print(f'  {m[\"id\"]}{auth}')
" 2>/dev/null || echo "  (无法获取模型列表)"
  else
    echo "✗ Gateway 未运行"
    [ -f "$LOG_FILE" ] && echo "" && echo "最近日志:" && tail -5 "$LOG_FILE" | sed 's/^/  /'
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
    echo "环境变量: MYZT_PORT=$PORT  MYZT_HOST=$HOST"
    ;;
esac