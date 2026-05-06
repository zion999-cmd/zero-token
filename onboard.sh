#!/bin/bash
# My Zero Token 授权向导
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "My Zero Token — 启动 Web 模型授权向导..."
echo ""
exec node --import tsx src/onboard-webauth.ts
