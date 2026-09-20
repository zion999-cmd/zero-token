#!/bin/bash
# State-semantics compliance tests (proposal §11, Tests A–F)
#
# Verifies the Gateway's stateless API contract:
#   - the standard API path must not depend on upstream WebChat session state
#   - the non-contract mode hint "chat" DOES depend on it, and must fail loudly
#     rather than silently restart the conversation
#
# Usage: ./test-state-semantics.sh [base_url] [api_key] [model]

BASE="${1:-http://127.0.0.1:3001}"
KEY="${2:-}"
MODEL="${3:-deepseek-web/deepseek-chat}"
GATEWAY_LOG="$(cd "$(dirname "$0")" && pwd)/.gateway.log"

H="Content-Type: application/json"
[ -n "$KEY" ] && AUTH="Authorization: Bearer $KEY" || AUTH=""

pass=0 fail=0

check() {
  local label="$1" expect="$2" actual="$3"
  if [[ "$actual" == *"$expect"* ]]; then
    echo "  ✓ $label"; ((pass++))
  else
    echo "  ✗ $label (expected '$expect', got '${actual:0:100}')"; ((fail++))
  fi
}

check_not() {
  local label="$1" needle="$2" actual="$3"
  if [[ "$actual" != *"$needle"* ]]; then
    echo "  ✓ $label"; ((pass++))
  else
    echo "  ✗ $label (should not contain '$needle')"; ((fail++))
  fi
}

post() { # post <json-body> [extra-header...]
  local body="$1"; shift
  curl -s --max-time 150 -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" "$@" -d "$body"
}

content_of() {
  python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(''); raise SystemExit
print((d.get('choices',[{}])[0].get('message',{}).get('content') or ''))" 2>/dev/null
}

# Live WebChat backends intermittently return an empty completion (observed
# rate ~30% while the upstream is busy). Retry the LLM-dependent assertions so
# upstream flakiness is not reported as a semantics failure. Deterministic
# assertions (E, C/D) do NOT use this — they never depend on generated text.
#
# Note: mode="chat" intentionally does NOT self-heal on an upstream miss (that
# is the behaviour under test in Test C), so its assertions can still flake
# when the upstream is having a bad minute; re-run the suite in that case.
fetch_content() { # fetch_content <body> [attempts]
  local body="$1" attempts="${2:-4}" out=""
  for _ in $(seq 1 "$attempts"); do
    out=$(post "$body" | content_of)
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    sleep 2
  done
  printf '%s' "$out"
}

echo "╔══════════════════════════════════════════╗"
echo "║  State Semantics Compliance              ║"
echo "║  $BASE"
echo "╚══════════════════════════════════════════╝"

# ─── Test E: chat mode + tools must be rejected explicitly ───────────────────
echo ""
echo "─── Test E: mode=chat + tools → explicit unsupported ───"
r=$(post "{\"model\":\"$MODEL\",\"mode\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"算 3*7\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"calc_zz\",\"description\":\"math\",\"parameters\":{\"type\":\"object\",\"properties\":{\"expr\":{\"type\":\"string\"}}}}}]}")
check "returns tools_unsupported_in_mode" '"code":"tools_unsupported_in_mode"' "$r"
check_not "does not silently answer without tools" '"choices"' "$r"

echo ""
echo "─── Test E': default path still supports tools ───"
r=""
for _ in $(seq 1 4); do
  r=$(post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"算 3*7\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"calc_zz\",\"description\":\"math\",\"parameters\":{\"type\":\"object\",\"properties\":{\"expr\":{\"type\":\"string\"}}}}}]}")
  [[ "$r" == *'"tool_calls"'* ]] && break
  sleep 2
done
check "produces a structured tool call" '"tool_calls"' "$r"

# ─── Test B: chat mode depends on upstream session state ─────────────────────
echo ""
echo "─── Test B: mode=chat depends on upstream session history ───"
SECRET="紫色"
# The nonce forces a fresh session key each run. mode="chat" deliberately never
# evicts a failing session (see Test C), so reusing the previous run's key would
# keep hitting the same stuck upstream conversation and could never recover.
NONCE="run$RANDOM$RANDOM"
TURN1="请记住暗号是${SECRET}。只回复：好的。（会话编号 ${NONCE}）"
# Establish the session first. Note this mode deliberately does NOT self-heal
# on a transient upstream miss (that is the semantics under test in C), so the
# setup itself must be retried until it actually lands.
SETUP=$(fetch_content "{\"model\":\"$MODEL\",\"mode\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"$TURN1\"}]}")
[ -n "$SETUP" ] || echo "      ⚠ turn-1 setup got no reply; recall assertion may fail upstream-side"
# Same first message → same session key (both fall in the ≤2-message bucket),
# so turn 2 continues the same upstream conversation. Only the LAST message is
# transmitted, so any knowledge of the code word must come from upstream state.
r=$(fetch_content "{\"model\":\"$MODEL\",\"mode\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"$TURN1\"},{\"role\":\"user\",\"content\":\"暗号是什么颜色？只答颜色\"}]}")
check "recalls the code word from upstream session state" "$SECRET" "$r"

# Control: the same question as a fresh upstream session (different first message).
r=$(fetch_content "{\"model\":\"$MODEL\",\"mode\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"暗号是什么颜色？只答颜色\"}]}")
check_not "fresh upstream session does not know the code word" "$SECRET" "$r"

# ─── Tests C/D: session eviction only where the request carries context ──────
echo ""
echo "─── Tests C/D: eviction policy is mode-dependent ───"
if [ -f "$GATEWAY_LOG" ]; then
  MARK=$(wc -l < "$GATEWAY_LOG")
  # A bogus cookie makes the run fail deterministically inside the stream.
  post "{\"model\":\"$MODEL\",\"mode\":\"chat\",\"messages\":[{\"role\":\"user\",\"content\":\"STATEVICTIONCHAT\"}]}" -H "x-cookie: invalid-for-test" >/dev/null
  post "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"STATEVICTIONDEFAULT\"}]}" -H "x-cookie: invalid-for-test" >/dev/null
  NEW=$(tail -n +$((MARK+1)) "$GATEWAY_LOG")
  CHAT_KEY=$(echo "$NEW" | grep -oE "conv_[a-f0-9]+_[abc]" | sed -n 1p)
  DEFAULT_KEY=$(echo "$NEW" | grep -oE "conv_[a-f0-9]+_[abc]" | sed -n 2p)
  echo "      chat-mode key=$CHAT_KEY  default-mode key=$DEFAULT_KEY"
  check "Test D: context-carrying mode may evict on failure" "evicted upstream session for $DEFAULT_KEY" "$NEW"
  check_not "Test C: stateful chat mode must NOT evict on failure" "evicted upstream session for $CHAT_KEY" "$NEW"
else
  echo "  ⚠ $GATEWAY_LOG not found — skipping C/D (run from the gateway host)"
  fail=$((fail+2))
fi

# ─── Test A: default path is reproducible on any upstream session ────────────
echo ""
echo "─── Test A: default path carries its own context ───"
HIST='[{"role":"user","content":"我的幸运数字是 7，请记住"},{"role":"assistant","content":"好的，记住了"},{"role":"user","content":"我的幸运数字是多少？只回答数字"}]'
r1=$(fetch_content "{\"model\":\"$MODEL\",\"session_id\":\"audit_A1\",\"messages\":$HIST}")
r2=$(fetch_content "{\"model\":\"$MODEL\",\"session_id\":\"audit_A2\",\"messages\":$HIST}")
echo "      session A1 → $(echo "$r1" | head -c 30) | session A2 → $(echo "$r2" | head -c 30)"
check "session A1 answers from the request" "7" "$r1"
check "session A2 (different upstream session) answers identically" "7" "$r2"

# ─── Test F: chatroom carries the room history in the request ────────────────
echo ""
echo "─── Test F: chatroom room history is caller-owned ───"
# Single line on purpose: raw newlines inside a JSON string literal are invalid.
ROOM="[房间记录] 小明: 我们决定的方案代号是 ORION。小红: 收到，ORION。小明: 请复述方案代号，只回答代号本身"
r=$(fetch_content "{\"model\":\"$MODEL\",\"mode\":\"chatroom\",\"session_id\":\"audit_F1\",\"messages\":[{\"role\":\"user\",\"content\":\"$ROOM\"}]}")
check "recovers room state on a fresh upstream session" "ORION" "$r"

echo ""
echo "═══════════════════════════════════════"
echo "  Passed: $pass  Failed: $fail"
echo "═══════════════════════════════════════"
[ $fail -eq 0 ] && exit 0 || exit 1
