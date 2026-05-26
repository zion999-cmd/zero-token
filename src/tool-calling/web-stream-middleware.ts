/**
 * Web Stream Middleware — unified input/output processing for all web models.
 *
 * Input:  extract last user message → strip metadata → inject tool prompt
 * Output: parse tool calls from response → emit ToolCall events
 *
 * This middleware replaces the per-stream prompt manipulation that was
 * previously duplicated across 13 stream files.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { stripInboundMeta } from "../streams/strip-inbound-meta.js";
import { extractToolCall } from "./web-tool-parser.js";
import { shouldInjectToolPrompt, getToolPrompt, getUserToolPrompt, type UserToolDef } from "./web-tool-prompt.js";
import { debugLog } from "../debug-log.js";

/**
 * Quick keyword check: does this message likely need tool use?
 * Only inject tool prompt when keywords suggest a tool action,
 * keeping normal chat messages short to reduce ban risk.
 */
function needsToolInjection(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = [
    // File operations
    "文件",
    "file",
    "read",
    "write",
    "创建",
    "写入",
    "读取",
    "打开",
    "保存",
    "桌面",
    "desktop",
    "目录",
    "directory",
    "folder",
    "文件夹",
    // Command execution
    "执行",
    "运行",
    "命令",
    "command",
    "run",
    "exec",
    "terminal",
    "终端",
    "shell",
    // Web operations
    "搜索",
    "search",
    "查找",
    "查询",
    "fetch",
    "抓取",
    "网页",
    "url",
    "http",
    "天气",
    "weather",
    "新闻",
    "news",
    // Message
    "发送",
    "send",
    "消息",
    "message",
    "通知",
    "notify",
    // General tool hints
    "帮我",
    "help me",
    "查看",
    "check",
    "look",
    "看看",
    "show",
    "下载",
    "download",
    "安装",
    "install",
    "更新",
    "update",
  ];
  return keywords.some((kw) => lower.includes(kw));
}

/**
 * Wrap a web stream function with tool calling middleware.
 * - Rewrites context: only sends last user message + optional tool prompt
 * - Parses response: extracts tool_call JSON → emits ToolCall events
 */
export function wrapWithToolCalling(streamFn: StreamFn, api: string): StreamFn {
  return (model, context, options) => {
    // --- Input rewriting ---
    const messages = context.messages || [];

    // Stateless mode (tool / chatroom) — skip history building
    const ctxMode = (context as any).mode;
    if (ctxMode === 'tool' || ctxMode === 'chatroom') {
      const systemPrompt = (context as any).systemPrompt || '';
      const msgList = [...messages];
      if (systemPrompt && msgList.length > 0 && msgList[0].role === 'user') {
        msgList[0] = { ...msgList[0], content: `${systemPrompt}\n\n${msgList[0].content}` };
      }
      return streamFn(model, Object.assign({}, context, {
        messages: msgList,
        tools: [],
        systemPrompt: '',
      }), options);
    }

    // GLM web chat uses page.evaluate (collects full response before returning).
    // Cap context and system prompt to avoid 120s timeout on large CCC prompts.
    // kimi-web uses Node.js streaming fetch and supports 256K context — excluded from slow list.
    const isSlowProvider = api === "glm-web" || api === "glm-intl-web";

    // Build conversation from recent messages (respecting 1M context window)
    // Web models benefit from having context, not just the last message
    const MAX_CONTEXT_CHARS = isSlowProvider ? 40_000 : 800_000;
    const recentMessages = [...messages].slice(-50); // at most 50 messages
    // Collect lines from newest → oldest (to respect size limit), then reverse to chronological order
    const contextLines: string[] = [];
    let totalChars = 0;
    for (const m of [...recentMessages].reverse()) {
      let content = "";
      if (m.role === "toolResult") {
        // pi-ai ToolResultMessage format
        const tr = m as unknown as { toolName?: string; toolCallId?: string; content?: Array<{ type: string; text?: string }> };
        let resultText = "";
        if (Array.isArray(tr.content)) {
          for (const part of tr.content) {
            if (part.type === "text" && part.text) resultText += part.text;
          }
        }
        content = `<tool_result name="${tr.toolName || "unknown"}">\n${resultText}\n</tool_result>`;
      } else if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        // Handle mixed content blocks: text, tool_use, tool_result, thinking
        type ContentPart = {
          type: string;
          text?: string;
          name?: string;
          id?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
        };
        const parts = m.content as ContentPart[];
        const toolUses = parts.filter(p => p.type === "tool_use");
        const toolResults = parts.filter(p => p.type === "tool_result");
        const textParts = parts.filter(p => p.type === "text");

        if (toolUses.length > 0) {
          // Assistant called a tool — include the call so DS knows it already happened
          content = toolUses
            .map(tc => `<tool_call name="${tc.name}">${JSON.stringify(tc.input)}</tool_call>`)
            .join("\n");
          if (textParts.length > 0) {
            const txt = textParts.map(p => p.text).join("");
            if (txt) content = txt + "\n" + content;
          }
        } else if (toolResults.length > 0) {
          // User message containing tool results (Anthropic API format)
          content = toolResults
            .map(tr => {
              let resultText = "";
              if (typeof tr.content === "string") {
                resultText = tr.content;
              } else if (Array.isArray(tr.content)) {
                resultText = (tr.content as Array<{ type: string; text?: string }>)
                  .filter(p => p.type === "text")
                  .map(p => p.text)
                  .join("");
              }
              return `<tool_result tool_use_id="${tr.tool_use_id || ""}">\n${resultText}\n</tool_result>`;
            })
            .join("\n");
        } else {
          content = textParts.map(p => p.text).join("");
        }
      }
      if (!content) continue;
      content = stripInboundMeta(content);
      // toolResult appears on the "user" side of the conversation turn
      const role = (m as { role: string }).role;
      const label = role === "user" || role === "toolResult" ? "User" : role === "assistant" ? "Assistant" : role;
      const line = `${label}: ${content}\n`;
      if (totalChars + line.length > MAX_CONTEXT_CHARS) break;
      contextLines.unshift(line); // insert at front to maintain chronological order
      totalChars += line.length;
    }
    const contextText = contextLines.join("");
    // If there's conversation history, instruct model to respond to the latest message
    const hasHistory = contextText.includes('\nAssistant:');

    // Detect whether the LAST message is a tool_result.
    // When it is, append a strong hint to prevent DS from re-running the tool.
    // Must check only the final message — searching backwards would incorrectly
    // match tool_results buried in history when a new user task follows them.
    const lastRecentMsg = recentMessages[recentMessages.length - 1];
    const endsWithToolResult = !!lastRecentMsg && (
      lastRecentMsg.role === "toolResult" ||
      (lastRecentMsg.role === "user" && Array.isArray(lastRecentMsg.content) &&
        (lastRecentMsg.content as Array<{type: string}>).some(p => p.type === "tool_result"))
    );

    // Build the history portion of the user message first (no hint yet)
    const historyText = contextText || "Hi";

    if (!historyText) {
      return streamFn(model, context, options);
    }

    // Only inject tool prompt when the message likely needs tool use.
    // This reduces ban risk by keeping most messages short and natural.
    const hasAgentTools = (context.tools?.length ?? 0) > 0;
    // Always inject+parse when tools are explicitly passed via API
    const explicitToolRequest = hasAgentTools;
    const injectTools = explicitToolRequest ||
      (shouldInjectToolPrompt(api) && hasAgentTools && needsToolInjection(historyText));

    // Build the prompt
    let toolSection = "";
    // Only inject built-in tools when no user tools requested
    if (injectTools && !explicitToolRequest) {
      toolSection = getToolPrompt(api);
    }
    // Append user-defined tools with provider-specific prompt format
    if (explicitToolRequest) {
      const userTools = (context.tools || []) as unknown as Array<{
        type: string;
        function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
      }>;
      const defs: UserToolDef[] = userTools
        .filter(t => t.type === "function" && t.function?.name)
        .map(t => ({
          name: t.function!.name!,
          description: t.function!.description || "",
          parameters: (t.function!.parameters || {}) as Record<string, unknown>,
        }));
      if (defs.length > 0) {
        toolSection += getUserToolPrompt(api, defs);
      }
    }

    // Build the final instruction appended AFTER the conversation history.
    // Placing it here (not before the history) keeps it as the last thing the model reads
    // before generating a response — preventing it from "forgetting" the tool format
    // or entering suggestion mode (predicting the next user message).
    // CN models need Chinese instructions — English instructions are often ignored.
    const isCnModel = api === "kimi-web" || api === "glm-web" || api === "glm-intl-web"
      || api === "qwen-cn-web" || api === "deepseek-web" || api === "xiaomimo-web";
    const continuationHint = endsWithToolResult
      ? (isCnModel
        ? `\n\n[指令]: 工具已执行，结果见上。如任务未完成，只输出下一个工具调用XML，禁止任何解释文字。如已全部完成，用简洁文字总结成果。禁止重复刚执行过的工具。`
        : `\n\n[INSTRUCTION]: A tool has just executed and the result is above. If the overall task is NOT yet complete, output the NEXT tool call needed. If ALL steps are done, write a concise text reply summarizing what was accomplished. Do NOT repeat a tool call that was just executed.`)
      : injectTools
        ? (isCnModel
          ? `\n\n[指令]: 如果需要调用工具，立即只输出工具调用XML，不得有任何解释或描述文字。格式：<tool_call name="工具名">{"参数":"值"}</tool_call>。如需推理请放在<think>...</think>内，</think>后只输出工具调用XML。不需要工具则直接回答。`
          : `\n\n[INSTRUCTION]: You are the AI assistant replying to the latest User message above. If a tool call is needed, output ONLY the tool call XML (e.g. <tool_call name="Bash">{"command":"..."}</tool_call>). Do NOT predict or write what the user might say next.`)
        : `\n\n[INSTRUCTION]: You are the AI assistant. Reply to the latest User message above.`;

    const userMessage = `${historyText}${continuationHint}`;

    // Prepend system prompt so web model follows language/behavioral instructions.
    // toolSection is placed AFTER the history so it stays in "working memory"
    // when DS generates its response.
    const rawSystem = (context as unknown as { systemPrompt?: string }).systemPrompt || "";

    // Log full rawSystem tail so we can inspect what CCC sends.
    debugLog('middleware', { layer: 'system-prompt', rawSystemLen: rawSystem.length, rawSystemTail: rawSystem.slice(-800) });

    // CCC's system prompt alone can be 60KB+; truncate to 1000 chars for slow providers
    // (GLM/Kimi) so total prompt stays under their timeout budget.
    const effectiveSystem = isSlowProvider ? rawSystem.slice(0, 1000) : rawSystem;
    const systemSection = effectiveSystem
      ? `[System]: ${effectiveSystem}\n\n`
      : "";
    // Structure: system → history → toolSection → instruction
    // Tool section comes AFTER history so DS sees it last (closest to response generation)
    const prompt = systemSection + historyText + (injectTools ? "\n\n" + toolSection : "") + continuationHint;

    console.log(
      `[WebStreamMiddleware] api=${api} injectTools=${injectTools} promptLen=${prompt.length} historyLen=${historyText.length} hasSystem=${!!systemSection}`,
    );
    debugLog('middleware', {
      layer: 'prompt', api, injectTools,
      promptLen: prompt.length,
      endsWithToolResult,
      promptHead: prompt.slice(0, 600),
      promptTail: prompt.slice(-600),
    });

    // Preserve image_url parts from the last user message so multimodal
    // content survives the text-only history assembly.
    const lastOrigMsg = [...messages].toReversed().find((m) => m.role === "user");
    const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
    if (lastOrigMsg && Array.isArray(lastOrigMsg.content)) {
      for (const part of lastOrigMsg.content as Array<{ type: string; image_url?: { url: string } }>) {
        if (part.type === "image_url" && part.image_url?.url) {
          imageParts.push({ type: "image_url", image_url: { url: part.image_url.url } });
        }
      }
    }

    // Create modified context with just the user message.
    // Spread the original context to preserve the full type, then override.
    const modifiedContext = Object.assign({}, context, {
      messages: imageParts.length > 0
        ? [{ role: "user" as const, content: [...imageParts, { type: "text" as const, text: prompt }] }]
        : [{ role: "user" as const, content: prompt }],
      tools: [] as typeof context.tools,
      systemPrompt: "",
    });

    if (!injectTools) {
      // No tool calling — just pass through with cleaned context
      return streamFn(model, modifiedContext, options);
    }


    // --- With tool calling: wrap the output stream ---
    const originalStreamOrPromise = streamFn(model, modifiedContext, options);
    const wrappedStream = createAssistantMessageEventStream();

    // Process events from original stream
    const processEvents = async () => {
      try {
        const originalStream = await Promise.resolve(originalStreamOrPromise);
        let accumulatedText = "";
        let toolCallEmitted = false;
        // Track whether upstream stream already emitted a toolcall_end event.
        // If it did, the tool call has already been forwarded and we must NOT run
        // extractToolCall again on the done event — that would emit a second,
        // duplicate tool call (e.g. double Write → overwrite prompt in Claude Code).
        let upstreamToolCallForwarded = false;

        for await (const event of originalStream) {
          debugLog('middleware', { layer: 'upstream-event', api, evtType: event.type, deltaLen: (event as {delta?: string}).delta?.length ?? 0, deltaPreview: (event as {delta?: string}).delta?.slice(0, 80) });
          // On stream completion, check final message for tool calls
          if (event.type === "done") {
            // Use final message content (already deduplicated by stream parser)
            // instead of accumulating text_delta events which may contain duplicates
            const finalMsg = event.message;
            if (finalMsg && Array.isArray(finalMsg.content)) {
              for (const part of finalMsg.content) {
                if (part.type === "text" && part.text) {
                  accumulatedText = part.text;
                }
              }
            }

            // If upstream already emitted a toolcall_end (plain-text tool call parsed by
            // the provider stream), skip extractToolCall to avoid emitting a duplicate.
            if (upstreamToolCallForwarded) {
              wrappedStream.push(event);
              break;
            }

            console.log(`[WebStreamMiddleware] extractToolCall textLen=${accumulatedText.length} preview=${accumulatedText.substring(0,200)}`);
            const toolCall = extractToolCall(accumulatedText);

            if (toolCall) {
              toolCallEmitted = true;
              const toolId = `web_tool_${Date.now()}`;

              // Emit tool call events
              const toolCallPart: ToolCall = {
                type: "toolCall",
                id: toolId,
                name: toolCall.tool,
                arguments: toolCall.parameters,
              };

              const toolMsg: AssistantMessage = {
                role: "assistant",
                content: [toolCallPart],
                stopReason: "toolUse",
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: finalMsg?.usage ?? {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                timestamp: Date.now(),
              };

              wrappedStream.push({
                type: "toolcall_start",
                contentIndex: 0,
                partial: toolMsg,
              });
              wrappedStream.push({
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: toolCallPart,
                partial: toolMsg,
              });
              wrappedStream.push({
                type: "done",
                reason: "toolUse",
                message: toolMsg,
              });
            } else {
              // No tool call — forward the done event as-is
              wrappedStream.push(event);
            }
          } else {
            // Forward non-done events as-is.
            // Track upstream toolcall_end to avoid re-parsing in extractToolCall at done.
            // IMPORTANT: Do NOT set toolCallEmitted=true here — DS often emits multiple
            // tool calls in one response. We must forward ALL of them so the gateway can
            // emit all tool_use blocks and CCC can execute each one.
            if (event.type === "toolcall_end") {
              upstreamToolCallForwarded = true;
            }
            wrappedStream.push(event);
          }
        }
      } catch (err) {
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        } as AssistantMessageEvent);
      } finally {
        wrappedStream.end();
      }
    };

    queueMicrotask(() => void processEvents());
    return wrappedStream;
  };
}
