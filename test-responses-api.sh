#!/bin/bash
# OpenAI Responses API Compliance Test — Zero Token
# Usage: ./test-responses-api.sh [base_url] [api_key]
# Default: http://127.0.0.1:3001, no auth

BASE="${1:-http://127.0.0.1:3001}"
KEY="${2:-}"
MODEL="${3:-deepseek-web/deepseek-chat}"

H="Content-Type: application/json"
[ -n "$KEY" ] && AUTH="Authorization: Bearer $KEY" || AUTH=""

pass=0 fail=0

check() {
  local label="$1" expect="$2" actual="$3"
  if [[ "$actual" == *"$expect"* ]]; then
    echo "  ✓ $label"
    ((pass++))
  else
    echo "  ✗ $label (expected '$expect', got '${actual:0:120}')"
    ((fail++))
  fi
}

echo "╔══════════════════════════════════════╗"
echo "║  OpenAI Responses API Compliance     ║"
echo "║  $BASE"
echo "╚══════════════════════════════════════╝"

# ─── 1. Health ─────────────────────────────────
echo ""
echo "─── 1. GET /health ───"
r=$(curl -s "$BASE/health")
check "status ok" '"status":"ok"' "$r"

# ─── 2. Non-streaming, string input ────────────
echo ""
echo "─── 2. POST /v1/responses (non-stream, string input) ───"
r=$(curl -s --max-time 120 -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$MODEL\",\"input\":\"1+1等于几？只回答阿拉伯数字。\"}")
check "object=response" '"object":"response"' "$r"
check "status completed" '"status":"completed"' "$r"
check "has id resp_" '"id":"resp_' "$r"
check "output array" '"output":[' "$r"
check "message item" '"type":"message"' "$r"
check "output_text part" '"type":"output_text"' "$r"
check "usage is null (never faked zeros)" '"usage":null' "$r"
check "store false" '"store":false' "$r"
check "error null" '"error":null' "$r"

# ─── 3. Function call: dual identities ─────────
echo ""
echo "─── 3. Function call (id vs call_id) ───"
r=$(curl -s --max-time 120 -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$MODEL\",\"input\":\"北京今天天气怎么样？请调用 get_weather 工具，不要直接回答。\",\"tools\":[{\"type\":\"function\",\"name\":\"get_weather\",\"description\":\"Get weather for a city\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}],\"store\":true}")
check "function_call item" '"type":"function_call"' "$r"
check "item id fc_ prefix" '"id":"fc_' "$r"
check "call_id present" '"call_id":"' "$r"
check "tool name" '"name":"get_weather"' "$r"
check "arguments contain city" '\"city\"' "$r"
check "store:true request still returns store:false" '"store":false' "$r"

# The Responses item id and call_id must be two different values
fcid=$(echo "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);fc=next(i for i in d['output'] if i['type']=='function_call');print(fc['id'])")
clid=$(echo "$r" | python3 -c "import json,sys;d=json.load(sys.stdin);fc=next(i for i in d['output'] if i['type']=='function_call');print(fc['call_id'])")
if [ -n "$fcid" ] && [ "$fcid" != "$clid" ]; then
  echo "  ✓ item id ($fcid) != call_id ($clid)"; ((pass++))
else
  echo "  ✗ id/call_id identity mismatch ($fcid vs $clid)"; ((fail++))
fi

# ─── 4. Full tool roundtrip ────────────────────
echo ""
echo "─── 4. function_call_output roundtrip ───"
r=$(curl -s --max-time 120 -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$MODEL\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"北京天气怎样？用工具结果回答。\"}]},{\"type\":\"function_call\",\"call_id\":\"ct_rt_1\",\"name\":\"get_weather\",\"arguments\":\"{\\\"city\\\":\\\"北京\\\"}\"},{\"type\":\"function_call_output\",\"call_id\":\"ct_rt_1\",\"output\":\"{\\\"city\\\":\\\"北京\\\",\\\"temp_c\\\":-3,\\\"condition\\\":\\\"晴\\\"}\"}]}")
temp_used=$(echo "$r" | python3 -c "
import json, sys
t = json.load(sys.stdin)['output'][0]['content'][0]['text']
print('ok' if any(x in t for x in ('-3', '零下3', '负3')) else 'no')
")
check "model used tool result (temp)" "ok" "$temp_used"
check "model used tool result (condition)" "晴" "$r"
# Final answer should be text only — no new function_call item.
if [[ "$r" != *'"function_call"'* ]]; then
  echo "  ✓ final answer contains no new function_call"; ((pass++))
else
  echo "  ✗ final answer unexpectedly contains function_call"; ((fail++))
fi

# ─── 5. Hosted tools silently stripped ─────────
echo ""
echo "─── 5. Hosted tools (web_search) stripped, no 400 ───"
r=$(curl -s --max-time 120 -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$MODEL\",\"input\":\"只回答两个字：可以\",\"tools\":[{\"type\":\"web_search\"},{\"type\":\"function\",\"name\":\"noop\",\"description\":\"x\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}]}")
check "request accepted with hosted tool" '"object":"response"' "$r"
check "status completed" '"status":"completed"' "$r"

# ─── 6. Streaming ──────────────────────────────
echo ""
echo "─── 6. POST /v1/responses (stream) ───"
r=$(curl -s --max-time 120 -N -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"input\":\"用一句话介绍你自己\"}")
check "SSE created" "event: response.created" "$r"
check "SSE in_progress" "event: response.in_progress" "$r"
check "SSE output_item.added" "event: response.output_item.added" "$r"
check "SSE content_part.added" "event: response.content_part.added" "$r"
check "SSE output_text.delta" "event: response.output_text.delta" "$r"
check "SSE output_text.done" "event: response.output_text.done" "$r"
check "SSE content_part.done" "event: response.content_part.done" "$r"
check "SSE output_item.done" "event: response.output_item.done" "$r"
check "SSE completed" "event: response.completed" "$r"
check "has sequence_number" '"sequence_number":' "$r"
check "completed usage null" '"usage":null' "$r"

seq_ok=$(echo "$r" | python3 -c "
import sys, json
seqs = []
for line in sys.stdin:
    if line.startswith('data:'):
        seqs.append(json.loads(line[5:].strip())['sequence_number'])
print('ok' if seqs == list(range(len(seqs))) else 'bad')
" 2>/dev/null)
check "sequence_number strictly 0..N" "ok" "$seq_ok"

# ─── 7. Error handling ─────────────────────────
echo ""
echo "─── 7. Error handling ───"
r=$(curl -s -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" -d '{"input":"hi"}')
check "missing model code" '"code":"missing_model"' "$r"

r=$(curl -s -X POST "$BASE/v1/responses" -H "$H" -H "$AUTH" -d '{"model":"nonexistent/x","input":"hi"}')
check "unknown model code" '"code":"invalid_model"' "$r"

if [ -n "$KEY" ]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/responses" -H "$H" -d '{"model":"x/y","input":"hi"}')
  check "no key → 401" "401" "$code"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v1/responses" -H "$H" -H "Authorization: Bearer wrong" -d '{"model":"x/y","input":"hi"}')
  check "wrong key → 401" "401" "$code"
fi

# ─── Results ───────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  Passed: $pass  Failed: $fail"
echo "═══════════════════════════════════════"
[ $fail -eq 0 ] && exit 0 || exit 1
