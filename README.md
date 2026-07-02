# My Zero Token

免 API Key 使用多种 LLM 的网关服务。通过 Chrome 调试模式获取浏览器登录态，将 Web LLM 平台封装为 **OpenAI / Anthropic 兼容的 API**。

> **状态：** 7 个供应商可用。OpenAI API 稳定。Anthropic API（`/v1/messages`）**已稳定支持 Claude Code**——工具调用、思考块、多轮对话、多步文件写入均可正常工作。DeepSeek 作为后端经过大量测试，是目前最推荐的 Claude Code 后端。
> 
> `express.json({limit:'50mb'})` 是必须的——Claude Code 的请求体可达 160KB+。

## 支持的供应商

| 供应商 | 聊天 | 工具调用 | 图片识别 | 方式 |
|--------|------|---------|---------|------|
| DeepSeek | ✅ | ✅ | ✅ | 纯 HTTP API (含 PoW 解题), 图片通过 vision 模式 |
| Claude | ✅ | ✅ | — | 浏览器内 API (绕过 Cloudflare) |
| Kimi | ✅ | ✅ | ✅ | 浏览器客户端 (attach), 图片通过 Node.js 直传 |
| ChatGLM | ✅ | ✅ | — | 浏览器客户端 (attach) |
| Qwen 国内版 | ✅ | ✅ | ✅ | 浏览器客户端 (attach), 图片通过 CDP 上传至 OSS |
| Qwen 国际版 | ✅ | ✅ | ⚠️ | 浏览器客户端 (page.evaluate), chat.qwen.ai, 文件上传可用，chat 端图片格式待适配 |
| Grok | ✅ | ⚠️ | — | DOM 交互 (anti-bot 绕过) |
| Doubao | ✅ | ⚠️ | — | 浏览器客户端 (间歇可用) |
| ChatGPT | ⚠️ | — | — | 需先登录 |
| Gemini | ❌ | — | — | 地区限制 |
| 其他 | ⚠️ | — | — | 待测试 |

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

> **Cookie 过期处理：** 运行 `./onboard.sh` 重新授权时，会自动通过 CDP 精确清除该提供商的过期 cookie 和 localStorage（不影响其他网站）。解决了部分平台（如 GLM）cookie 过期后页面无法退出/刷新的问题。

## 访问控制

创建 `config/config.json` 来启用 API 认证（OpenAI 兼容）：

```json
{ "api_key": "sk-my-secret-key" }
```

参考 `config/config.json.example`。支持两种方式传递 key：

```bash
# Bearer token (OpenAI SDK 默认)
Authorization: Bearer sk-my-secret-key

# 或 x-api-key header
x-api-key: sk-my-secret-key
```

## 管理命令

```bash
./server.sh start     # 启动网关
./server.sh stop      # 停止网关
./server.sh restart   # 重启网关
./server.sh status    # 查看状态和可用模型列表

./start-chrome-debug.sh  # 启动 Chrome 调试模式（精确杀旧实例，不影响普通 Chrome）
./onboard.sh             # Web 模型授权向导（自动清除过期 cookie）
```

## API

同时支持 **OpenAI** 和 **Anthropic** 两种 API 范式。

### 快速连接

```python
# OpenAI SDK
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3001/v1", api_key="not-needed")

# Anthropic SDK (Claude Code, OpenClaw 等使用此接口)
ANTHROPIC_BASE_URL="http://127.0.0.1:3001/v1"
ANTHROPIC_API_KEY="not-needed"
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

### 多模态输入 (图片识别)

Kimi 和 Qwen 国内版支持 OpenAI Vision API 格式的图片输入（Qwen 国际版暂不支持）：

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-web/moonshot-v1-32k",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "描述这张图片"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo..."}}
      ]
    }]
  }'
```

实现细节：
- **Kimi**：图片通过 Node.js `fetch()` 直接上传到 `/apiv2-files/file/upload`（multipart/form-data），无需浏览器介入
- **Qwen 国内版**：图片通过浏览器 CDP 上传到 OSS，再由 `chat-side.qianwen.com` 注册文件，浏览器仅用于绕过上传鉴权
- 浏览器实例在整个会话中复用，不会为每张图片单独启动浏览器

供应商 Prompt 策略：

| 供应商 | 策略 | 说明 |
|--------|------|------|
| DeepSeek/Kimi/GLM/Qwen/Qwen Intl | `<tool_call>` XML | Hermes 风格，模型原生支持 |
| Grok/Claude | `function_call` JSON | OpenAI 兼容格式 |
| Doubao | `<tool_call>` XML | 间歇可用 |

### `POST /v1/messages` (Anthropic Messages API)

Claude Code、OpenClaw 等工具使用的 Anthropic 兼容接口。

- 支持 `thinking` content block（带 fake `signature_delta`，与 Claude SDK 兼容）
- 支持 `tool_choice`（`auto`/`any`/`none`/`tool`）
- 支持 Anthropic `input_schema` 工具格式（自动转换为 OpenAI `parameters`）
- 支持 `system` 参数（字符串或 ContentBlock 数组）
- **完整工具调用循环**：`tool_use` → `tool_result` → 最终回答，全部正确透传
- **多工具调用支持**：DS 单次响应可输出多个工具调用（Read + mkdir + Write×N），全部按序转发给 CCC 执行，文件真实写入磁盘
- **DeepSeek 专用**：会话分桶（`_a`/`_b`/`_c`）独立隔离，防止跨对话上下文污染

```bash
# 非流式
curl -X POST http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-web/claude-chat",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Hello"}],
    "system": "You are a helpful assistant"
  }'

# 流式 (SSE)
curl -X POST http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web/deepseek-chat",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

响应格式：

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hello!"}],
  "model": "claude-web/claude-chat",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
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

client = OpenAI(base_url="http://127.0.0.1:3001/v1", api_key="sk-my-secret-key")
response = client.chat.completions.create(
    model="claude-web/claude-chat",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

## 架构

```
Claude Code / OpenAI SDK
        ↓ POST /v1/messages  (Anthropic API)
        ↓ POST /v1/chat/completions  (OpenAI API)
   src/index.ts  (Express 网关，Anthropic/OpenAI 格式转换，会话 key 推导)
        ↓ wrapWithToolCalling()  [web-stream-middleware.ts]
        │   ├─ 完整历史序列化 → 单条 user 消息发给 Web Chat
        │   ├─ tool_use 块 → <tool_call name="X">{json}</tool_call>
        │   ├─ tool_result 块 → <tool_result tool_use_id="...">...</tool_result>
        │   ├─ [INSTRUCTION] 追加在最后（防止长 system prompt 稀释工具指令）
        │   ├─ endsWithToolResult 只检查最后一条消息（防止历史中的旧 tool_result 误触发）
        │   └─ 所有上游 toolcall 事件全量透传（不截断多工具调用序列）
        ↓ createXxxWebStreamFn()  [streams/xxx-web-stream.ts]
        │   ├─ DeepSeek → 纯 HTTP + PoW (WebAssembly)
        │   │   ├─ INTERNAL_TOOLS (web_search) 在 emitDelta 层过滤，不暴露给 CCC
        │   │   └─ 支持 </ToolName> 关闭标签（DS 有时省略 </tool_call>）
        │   ├─ Claude   → 浏览器内 fetch (绕过 Cloudflare)
        │   ├─ Kimi/GLM/Qwen/Doubao → 浏览器 CDP attach
│   ├─ Qwen Intl → 浏览器 page.evaluate (chat.qwen.ai)
        │   └─ Grok     → DOM 交互 (绕过 anti-bot)
        ↓ 工具调用解析（流式 inline + done 后 fallback）
            支持格式：
            1. <tool_call name="X">{json}</tool_call>  (XML)
            2. ToolName(kwarg="val", ...)              (Python kwargs, 平衡括号解析)
            3. ```tool_json\n{...}\n```                (fenced JSON)
            4. Tool call: X\nArguments: {json}         (文字描述)
            5. ReAct: Action: X\nAction Input: {json}

浏览器 (Chrome Debug, port 9222)
    └─ Playwright CDP 附加模式，复用已登录页面

auth-profiles.json → 网关自动加载 cookie/token
```

### DeepSeek 会话系统

- `sessionMap`: `sessionKey → DS chat_session_id`
- `parentMessageMap`: `sessionKey → DS 最后一条消息 id`（保证流式上下文连续性）
- **Key 格式**: `conv_${hash(firstUserMsg)}_${bucket}`
  - bucket `a`：≤2 条消息（初始化/短对话）
  - bucket `b`：3-6 条消息
  - bucket `c`：7+ 条消息
- 每个 bucket 是**独立的 DS 会话**，不跨 bucket 复用（防止 `/init` 等短对话污染后续长对话的 DS 记忆）
- 完整历史通过 prompt 注入，DS 会话仅用于保持 HTTP 连接上下文

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
# Provider 通过 ../../../extensions/ 导入，需在项目父目录创建符号链接
ln -sf $PWD/extensions "$(dirname $PWD)/extensions"
```

## 关键技术细节

### 多工具调用透传

DS 在一次响应中可能输出多个工具调用（例如 `Read` + `Bash(mkdir)` + `Write(file1)` + `Write(file2)`）。
中间件会将所有 `toolcall_start/delta/end` 事件全量转发给 gateway，gateway 再逐一封装成 Anthropic `content_block`（`tool_use`）发给 CCC。
CCC 会依次执行每个工具调用，并将结果以 `tool_result` 返回。

> **曾踩过的坑**：中间件曾在第一个 `toolcall_end` 后设置 `toolCallEmitted=true`，导致后续工具调用事件被 `else if (!toolCallEmitted)` 静默丢弃。结果 CCC 只执行了第一个工具，文件从未被写入磁盘，DS 却输出了假的完成总结。

### endsWithToolResult 检测

当对话历史的**最后一条消息**是 `tool_result` 时，说明 DS 刚执行完一个工具调用，需要决策下一步。
中间件只检查 `recentMessages[recentMessages.length - 1]`，不扫描全部历史——否则，用户发了新任务后，历史中的旧 `tool_result` 会被误识别，导致 DS 被强制跳到"写总结"阶段而跳过实际任务执行。

### DS 内部工具过滤

DS 有自己的 `web_search` 内部工具调用。如果把它转发给 CCC，CCC 会收到一个无法执行的 `tool_use`，造成协议错误。
`INTERNAL_TOOLS = new Set(["web_search"])` 在 `emitDelta` 入口处过滤，确保这类事件不进入事件流。

### XML 工具调用解析

DS 以 `<tool_call name="Write">{...}</tool_call>` 格式输出工具调用。
解析时工具名取自 `name=` 属性（不是 JSON body 里的 `"tool"` 字段），args JSON 是标签内容。
此外 DS 有时用 `</Write>` 代替 `</tool_call>` 作为关闭标签，流解析器同样支持。

## 要求

- Node.js >= 22
- Google Chrome
- pnpm

## License

MIT
