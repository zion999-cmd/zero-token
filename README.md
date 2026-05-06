# My Zero Token

免 API Key 使用多种 LLM 的网关服务。通过 Chrome 调试模式获取浏览器登录态，将 Web LLM 平台封装为 **OpenAI 兼容的 API**。

## 支持的供应商

| 供应商 | 状态 | 方式 |
|--------|------|------|
| DeepSeek | ✅ | 纯 HTTP API (含 PoW 解题) |
| Claude | ✅ | 浏览器内 API 调用 |
| Kimi | ✅ | 浏览器客户端 (attach) |
| ChatGLM | ✅ | 浏览器客户端 (attach) |
| Doubao | ✅ | 浏览器客户端 (attach) |
| Qwen | ✅ | 浏览器客户端 (attach) |
| Grok | ✅ | DOM 交互 |
| ChatGPT | ⚠️ | 需先登录 chatgpt.com |
| Gemini | ❌ | 地区限制 |
| Perplexity | ⚠️ | 待测试 |
| Qwen CN | ⚠️ | 待测试 |
| GLM Intl | ⚠️ | 待测试 |
| Xiaomi MiMo | ⚠️ | 待测试 |

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动 Chrome 调试模式（打开所有平台页面）
./start-chrome-debug.sh

# 3. 在各平台页面中登录你的账号

# 4. 运行授权向导（自动检测登录状态，提取 cookie/token）
./onboard.sh

# 5. 按提示选择要授权的模型，等待自动检测

# 6. 启动网关
./server.sh start

# 7. 打开测试页面
open http://127.0.0.1:3001
```

首次使用后，已授权的模型 cookie 自动从 `.myzt-state/auth-profiles.json` 加载，无需手动输入。

## 管理命令

```bash
./server.sh start     # 启动网关
./server.sh stop      # 停止网关
./server.sh restart   # 重启网关
./server.sh status    # 查看状态和可用模型列表

./start-chrome-debug.sh  # 启动 Chrome 调试模式
./onboard.sh             # Web 模型授权向导
```

## API 端点

### `GET /v1/models`

列出所有可用模型及授权状态。

```bash
curl http://127.0.0.1:3001/v1/models
```

响应：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-web/deepseek-chat",
      "object": "model",
      "created": 1778083418,
      "owned_by": "deepseek-web",
      "authorized": true
    }
  ]
}
```

### `POST /v1/chat/completions`

OpenAI 兼容的聊天补全接口。`authorized` 为 true 的模型自动从 `auth-profiles.json` 加载凭证。

```bash
# 非流式
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web/deepseek-chat",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# 流式 (SSE)
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-web/claude-chat",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

非流式响应：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1778083350,
  "model": "deepseek-web/deepseek-chat",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "2" },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

流式 SSE 响应：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":...,"model":"...","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}

data: [DONE]
```

支持思考过程 (reasoning) 的模型（DeepSeek、Qwen 等）会返回 `reasoning_content`：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "2",
      "reasoning_content": "用户问 1+1=?，答案明显是 2。"
    }
  }]
}
```

也可以手动传入 cookie（覆盖自动加载）：

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-cookie: sessionKey=sk-ant-sid02-..." \
  -d '{"model": "claude-web/claude-chat", "messages": [...]}'
```

### `GET /health`

```bash
curl http://127.0.0.1:3001/health
# → {"status":"ok"}
```

## 错误格式

遵循 OpenAI 错误格式：

```json
{
  "error": {
    "message": "Unknown model: x",
    "type": "invalid_request_error",
    "code": "invalid_model"
  }
}
```

常见错误类型：`invalid_request_error`、`authentication_error`、`api_error`。

## OpenAI 兼容性

可直接配合任何支持自定义 `baseURL` 的 OpenAI 客户端使用：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3001/v1", api_key="not-needed")
response = client.chat.completions.create(
    model="claude-web/claude-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

## 架构

```
浏览器 (Chrome Debug, port 9222)
    │
    ├─ CDP 附加 ──→ 浏览器客户端 (Kimi, GLM, Doubao, Qwen)
    │               Playwright attach 模式，复用已登录页面
    │
    ├─ CDP 附加 ──→ DOM 交互 (Grok)
    │               绕过 anti-bot，直接操作输入框
    │
    ├─ page.evaluate ──→ 浏览器内 fetch (Claude)
    │                    页面上下文调用 API，绕过 Cloudflare
    │
    └─ cookie/token ──→ 纯 HTTP 客户端 (DeepSeek)
                        直接调用 API + WebAssembly PoW 解题

auth-profiles.json ──→ 网关自动加载 cookie
```

## 项目结构

```
my-zero-token/
  extensions/browser/src/browser/  # 浏览器扩展桩（cdp, chrome, config，零外部依赖）
  src/                             # 网关核心
  config/                          # 配置 stub（项目根，供 provider 导入）
  start-chrome-debug.sh            # 启动 Chrome 调试模式
  onboard.sh                       # Web 模型授权向导
  server.sh                        # 网关管理
  setup.sh                         # 一键初始化
```

初始化时创建一个符号链接（provider 通过 `../../../extensions/` 导入，指向项目内的 extensions）：

```bash
ln -sf $PWD/extensions /Users/bx/Workspace/extensions
```

## 要求

- Node.js >= 22
- Google Chrome
- pnpm

## License

MIT
