#!/bin/bash
# OpenAI API Compliance Test — Zero Token
# Usage: ./test-openai-api.sh [base_url] [api_key]
# Default: http://127.0.0.1:3001, no auth

BASE="${1:-http://127.0.0.1:3001}"
KEY="${2:-}"

H="Content-Type: application/json"
[ -n "$KEY" ] && AUTH="Authorization: Bearer $KEY" || AUTH=""

pass=0 fail=0

check() {
  local label="$1" expect="$2" actual="$3"
  if [[ "$actual" == *"$expect"* ]]; then
    echo "  ✓ $label"
    ((pass++))
  else
    echo "  ✗ $label (expected '$expect', got '${actual:0:80}')"
    ((fail++))
  fi
}

echo "╔══════════════════════════════════════╗"
echo "║  OpenAI API Compliance Test         ║"
echo "║  $BASE"
echo "╚══════════════════════════════════════╝"

# ─── 1. Health ─────────────────────────────────
echo ""
echo "─── 1. GET /health ───"
r=$(curl -s "$BASE/health")
check "status ok" '"status":"ok"' "$r"

# ─── 2. Models ─────────────────────────────────
echo ""
echo "─── 2. GET /v1/models ───"
r=$(curl -s "$BASE/v1/models" -H "$AUTH")
check "object=list" '"object":"list"' "$r"
check "has data array" '"data":[' "$r"
check "model has id" '"id":' "$r"
check "model has object" '"object":"model"' "$r"
check "model has created" '"created":' "$r"
check "model has owned_by" '"owned_by":' "$r"

# ─── 3. Chat completions (non-stream) ─────────
echo ""
echo "─── 3. POST /v1/chat/completions (non-stream) ───"
# Pick first authorized model
model=$(echo "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);m=next((x for x in d['data'] if x.get('authorized')),d['data'][0]);print(m['id'])" 2>/dev/null || echo "deepseek-web/deepseek-chat")

r=$(curl -s --max-time 60 -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"1+1=? Answer in one word\"}]}" 2>&1)

check "has id" '"id":"chatcmpl-' "$r"
check "object=chat.completion" '"object":"chat.completion"' "$r"
check "has created (unix ts)" '"created":' "$r"
check "has model" "\"model\":\"$model\"" "$r"
check "has system_fingerprint" '"system_fingerprint":"fp_zt_' "$r"
check "choices array" '"choices":[' "$r"
check "choices[0].index=0" '"index":0' "$r"
check "message.role=assistant" '"role":"assistant"' "$r"
check "message.content not null" '"content":"' "$r"
check "finish_reason=stop" '"finish_reason":"stop"' "$r"
check "has usage" '"usage":{' "$r"
check "usage.prompt_tokens" '"prompt_tokens":' "$r"
check "usage.completion_tokens" '"completion_tokens":' "$r"
check "usage.total_tokens" '"total_tokens":' "$r"

# SDK params
echo ""
echo "─── 3b. SDK default params ───"
r=$(curl -s --max-time 60 -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"temperature\":1,\"max_tokens\":1024,\"top_p\":1,\"n\":1}" 2>&1)
check "accepts temperature" '"id":"chatcmpl-' "$r"
check "accepts max_tokens" '"id":"chatcmpl-' "$r"

# ─── 4. Streaming ─────────────────────────────
echo ""
echo "─── 4. POST /v1/chat/completions (stream) ───"
r=$(curl -s --max-time 30 -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}],\"stream\":true}" 2>&1)

check "has data: lines" "data:" "$r"
check "chunk object" '"object":"chat.completion.chunk"' "$r"
check "chunk has id" '"id":"chatcmpl-' "$r"
check "delta role" '"role":"assistant"' "$r"
check "delta content" '"content":"' "$r"
check "[DONE] terminator" "[DONE]" "$r"

# ─── 5. Tool calling ──────────────────────────
echo ""
echo "─── 5. Tool calling ───"
r=$(curl -s --max-time 60 -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"calc 3*7\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"calculator\",\"description\":\"Math\",\"parameters\":{\"type\":\"object\",\"properties\":{\"expression\":{\"type\":\"string\"}},\"required\":[\"expression\"]}}}]}" 2>&1)

check "finish_reason=tool_calls" "tool_calls" "$r"
check "has tool_calls array" '"tool_calls":[' "$r"
check "tool_call type=function" '"type":"function"' "$r"
check "tool_call has name" '"name":"calculator"' "$r"
check "tool_call has arguments" '"arguments":"' "$r"

# ─── 6. Error handling ────────────────────────
echo ""
echo "─── 6. Error handling ───"
r=$(curl -s -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d '{"model":"nonexistent/model"}' 2>&1)
check "error has message" '"message":' "$r"
check "error has type" '"type":"invalid_request_error"' "$r"
check "error has param" '"param":"model"' "$r"
check "error has code" '"code":"invalid_model"' "$r"

# Missing model
r=$(curl -s -X POST "$BASE/v1/chat/completions" -H "$H" -H "$AUTH" \
  -d '{"messages":[]}' 2>&1)
check "missing model code" '"code":"missing_model"' "$r"

# Auth (if key configured)
if [ -n "$KEY" ]; then
  echo ""
  echo "─── 7. Authentication ───"
  r=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models")
  check "no key → 401" "401" "$r"

  r=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/models" -H "Authorization: Bearer wrong")
  check "wrong key → 401" "401" "$r"

  r=$(curl -s "$BASE/v1/models" -H "$AUTH")
  check "correct key → has data" '"data":[' "$r"
else
  echo ""
  echo "─── 7. Auth (skipped — no api_key set) ───"
fi

# ─── Results ──────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  Passed: $pass  Failed: $fail"
echo "═══════════════════════════════════════"
[ $fail -eq 0 ] && exit 0 || exit 1