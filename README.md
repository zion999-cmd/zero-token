# My Zero Token

免 API Key 使用多种 LLM 的网关服务。通过 Chrome 调试模式获取浏览器登录态，将 Web LLM 平台封装为 **OpenAI 兼容的 API**。

## 支持的供应商

| 供应商 | 聊天 | 工具调用 | 方式 |
|--------|------|---------|------|
| DeepSeek | ✅ | ✅ | 纯 HTTP API (含 PoW 解题) |
| Claude | ✅ | ✅ | 浏览器内 API (绕过 Cloudflare) |
| Kimi | ✅ | ✅ | 浏览器客户端 (attach) |
| ChatGLM | ✅ | ✅ | 浏览器客户端 (attach) |
| Qwen | ✅ | ✅ | 浏览器客户端 (attach) |
| Grok | ✅ | ⚠️ | DOM 交互 (anti-bot 绕过) |
| Doubao | ✅ | ⚠️ | 浏览器客户端 (间歇可用) |
| ChatGPT | ⚠️ | — | 需先登录 |
| Gemini | ❌ | — | 地区限制 |
| 其他 | ⚠️ | — | 待测试 |

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

### Tool Calling (Function Calling)

支持标准 OpenAI `tools` 参数，返回 `tool_calls`。各供应商使用不同的 prompt 策略：

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web/deepseek-chat",
    "messages": [{"role": "user", "content": "计算 123*456"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "calculator",
        "description": "计算数学表达式",
        "parameters": {
          "type": "object",
          "properties": {"expression": {"type": "string"}},
          "required": ["expression"]
        }
      }
    }]
  }'
```

响应：

```json
{
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "function": {
          "name": "calculator",
          "arguments": "{\"expression\":\"123*456\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

供应商 Prompt 策略：

| 供应商 | 策略 | 说明 |
|--------|------|------|
| DeepSeek/Kimi/GLM/Qwen | `<tool_call>` XML | Hermes 风格，模型原生支持 |
| Grok/Claude | `function_call` JSON | OpenAI 兼容格式 |
| Doubao | `<tool_call>` XML | 间歇可用 |

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
用户请求 (OpenAI-compatible API)
    │
    ├─ /v1/models         → 模型列表 + 授权状态
    ├─ /v1/chat/completions → wrapWithToolCalling 中间件
    │   │
    │   ├─ 工具注入 (per-provider prompt strategy)
    │   ├─ 流式处理 (SSE → OpenAI chunks)
    │   └─ 工具调用解析 (extractToolCall)
    │
    └─ 供应商适配层
        │
        ├─ DeepSeek → 纯 HTTP + PoW (WebAssembly)
        ├─ Claude   → 浏览器内 fetch (绕过 Cloudflare)
        ├─ Kimi/GLM/Qwen/Doubao → 浏览器 CDP attach
        └─ Grok     → DOM 交互 (绕过 anti-bot)

浏览器 (Chrome Debug, port 9222)
    └─ Playwright CDP 附加模式，复用已登录页面

auth-profiles.json → 网关自动加载 cookie/token
```

## 项目结构

```
my-zero-token/
  extensions/browser/src/browser/  # CDP/Chrome 桩 (零外部依赖)
  src/
    index.ts                       # Express 网关 (OpenAI 兼容 API)
    onboard-webauth.ts             # Web 模型授权向导
    streams/                       # 流式响应处理 (延迟加载工厂)
    providers/                     # 供应商客户端 (HTTP + 浏览器)
    tool-calling/                  # 工具调用中间件 + 解析器 + prompt 策略
    config/                        # 配置 stub (attach-only)
  config/                          # 配置 stub (项目根)
  start-chrome-debug.sh            # 启动 Chrome 调试模式
  onboard.sh                       # Web 模型授权向导
  server.sh                        # 网关管理 (start/stop/restart/status)
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
