#!/bin/bash
# My Zero Token — 初始化脚本
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "My Zero Token — 初始化"
echo "======================"
echo ""

# 1. 安装依赖
echo "→ 安装依赖..."
pnpm install

# 2. 创建浏览器扩展符号链接
echo "→ 创建 extensions 符号链接..."
rm -rf extensions
mkdir -p extensions/browser/src
ln -sf /Users/bx/Workspace/openclaw-zero-token/extensions/browser/src/browser extensions/browser/src/browser
echo "  ✓ extensions → openclaw-zero-token"

# 3. 创建 openclaw SDK 桩
echo "→ 创建 openclaw SDK 桩..."
mkdir -p node_modules/openclaw/plugin-sdk
cat > node_modules/openclaw/package.json << 'PKGJSON'
{
  "name": "openclaw",
  "version": "0.0.0-stub",
  "type": "module",
  "exports": { "./plugin-sdk/browser-support": "./plugin-sdk/browser-support.js" }
}
PKGJSON
cat > node_modules/openclaw/plugin-sdk/browser-support.js << 'STUB'
import { Buffer } from "node:buffer";
export function rawDataToString(data, encoding = "utf8") {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString(encoding);
  if (Array.isArray(data)) return Buffer.concat(data).toString(encoding);
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString(encoding);
  return Buffer.from(String(data)).toString(encoding);
}
STUB
echo "  ✓ openclaw stub created"

# 4. 创建 Workspace 级符号链接（供浏览器客户端跨项目导入）
echo "→ 创建 Workspace 级符号链接..."
mkdir -p /Users/bx/Workspace/node_modules
ln -sf "$SCRIPT_DIR/extensions" /Users/bx/Workspace/extensions
ln -sf "$SCRIPT_DIR/node_modules/openclaw" /Users/bx/Workspace/node_modules/openclaw
echo "  ✓ /Users/bx/Workspace/extensions"
echo "  ✓ /Users/bx/Workspace/node_modules/openclaw"

# 5. 创建状态目录
echo "→ 创建状态目录..."
mkdir -p .myzt-state/agents/main/agent

echo ""
echo "✓ 初始化完成"
echo ""
echo "下一步:"
echo "  ./start-chrome-debug.sh   启动 Chrome 调试模式"
echo "  ./onboard.sh              授权 Web 模型"
echo "  ./server.sh start         启动网关"
