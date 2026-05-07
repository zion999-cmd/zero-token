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

# 2. 创建状态目录
echo "→ 创建状态目录..."
mkdir -p .myzt-state/agents/main/agent

# 3. 创建父目录级符号链接
# Provider 通过 ../../../extensions/ 导入，解析到项目父目录
# 例: <project>/src/providers/ → ../../.. → <parent>/
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
echo "→ 创建符号链接: $PARENT_DIR/extensions → $SCRIPT_DIR/extensions"
ln -sf "$SCRIPT_DIR/extensions" "$PARENT_DIR/extensions"

echo ""
echo "✓ 初始化完成"
echo ""
echo "下一步:"
echo "  ./start-chrome-debug.sh   启动 Chrome 调试模式"
echo "  ./onboard.sh              授权 Web 模型"
echo "  ./server.sh start         启动网关"
