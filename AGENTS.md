# My Zero Token — Agent Instructions

免 API Key 的多 LLM 网关，将 Web 聊天平台封装为 OpenAI / Anthropic 兼容 API。

## 开发命令

```bash
pnpm install                  # 安装依赖
bash server.sh start          # 启动网关 (port 3001, 日志 → .gateway.log)
bash server.sh restart        # 重启（改代码后必须重启）
bash server.sh stop           # 停止
bash server.sh status         # 查看状态
curl http://127.0.0.1:3001/health  # 验证运行中

# 调试日志（实时）
tail -f .myzt-state/debug.log
tail -f .gateway.log
cat .myzt-state/requests.log  # 每次请求摘要
```

## 架构

```
Claude Code / OpenAI SDK
        ↓ POST /v1/messages  (Anthropic API)
        ↓ POST /v1/chat/completions  (OpenAI API)
   src/index.ts  (Express gateway)
        ↓ getConversationKey() → sessionId
        ↓ wrapWithToolCalling()  [web-stream-middleware.ts]
        ↓ createDeepseekWebStreamFn()  [deepseek-web-stream.ts]
   DeepSeek Web Chat (HTTP, PoW)
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | Express 路由、会话 key 推导、Anthropic/OpenAI 格式转换 |
| `src/tool-calling/web-stream-middleware.ts` | 工具调用包装：上下文历史构建 + 解析文本中的工具调用 |
| `src/streams/deepseek-web-stream.ts` | DS web SSE 解析、会话 ID 管理 |
| `src/streams/web-stream-factories.ts` | 动态加载各 provider stream 函数 |
| `.myzt-state/auth-profiles.json` | 已授权 provider 的 cookie/token（运行 `./onboard.sh` 生成） |
| `config/config.json` | API key 和 debug 标志 `{ "api_key": "sk-...", "debug": true }` |

## 会话系统（DeepSeek 专用）

- `sessionMap`: `sessionKey → DS chat_session_id`
- `parentMessageMap`: `sessionKey → DS last message id`
- **Key 格式**: `conv_${hash(firstUserMsg)}_${bucket}` (bucket: `a`≤2条, `b` 3-6条, `c` 7+)
- `sysHash` **已移除**：Claude Code 系统提示含动态字段（`cch=XXX`），每轮变化会破坏跨轮 session 查找
- 跨 bucket 降级：`_b`/`_c` 找不到 session 时，自动 fallback 到 `_a`

## DS 流解析约定

- `THINK` 片段 → `thinking_delta` 事件
- `RESPONSE` 片段 → 文本或纯文本工具调用（如 `Write(file_path="...", content="""...""")`）
- `findPlainToolCall(text)` 用带括号计数的 balanced-paren 解析器，支持：
  - JSON args: `Bash({"command":"node file.js"})`
  - Python kwargs: `Glob(pattern="**/*", path=".")`
  - 三重引号字符串（含嵌套括号的代码）
- 工具调用列表: `Write, Read, Glob, Bash, Edit, MultiEdit, LS, Grep, WebSearch, WebFetch`

## Anthropic 思考块

Claude Code SDK 要求 `signature_delta` 才接受 thinking 块。这里用固定 fake 签名：
```
ZmFrZV9zaWduYXR1cmVfZm9yX3dlYl9tb2RlbF9nYXRld2F5X3YxAAAAAAAAAAA=
```
见 `src/index.ts` 中 `fakeSignature` 常量和 `closeThinkingBlock()` 辅助函数。

## 工具调用中间件规则

`web-stream-middleware.ts` 中的 `wrapWithToolCalling` 总是把完整对话历史拼入单条 user 消息发给 DS：

- `tool_use` 内容块 → `<tool_call name="Bash">{"command":"..."}</tool_call>`
- `tool_result` 内容块（Anthropic 格式）→ `<tool_result tool_use_id="...">\n...\n</tool_result>`
- 最后一条消息是工具结果时，追加 **"do NOT call any more tools"** 以防 DS 循环执行工具
- upstream 已经 forward 了 `toolcall_end` 时，跳过 `extractToolCall()` 以防同一工具调用发出两次

## 常见陷阱

- **重启必须用 `bash server.sh restart`**，直接 kill 进程可能留下旧 PID 文件
- **`express.json({ limit: '50mb' })`** 是必须的，Claude Code 请求体可达 160KB+
- 修改任何 `src/` 文件后必须重启才生效（`tsx` 不会热更新）
- DS 会话 `parentId` 跨请求保存在内存中；服务重启后 parentId 丢失，会自动创建新 DS 会话
- 调试时启用 `"debug": true` 会写 `.myzt-state/debug.log`（JSONL 格式）

## 授权新 Provider

```bash
./start-chrome-debug.sh  # 以调试模式打开 Chrome
# 在各平台登录账号
./onboard.sh             # 交互式提取 cookie/token → 写入 auth-profiles.json
```
