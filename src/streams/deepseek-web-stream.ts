import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { debugLog } from "../debug-log.js";
import {
  DeepSeekWebClient,
  type DeepSeekWebClientOptions,
} from "../providers/deepseek-web-client.js";
import { LruMap } from "../utils/lru-map.js";

// Helper to strip messages for web providers
function stripForWebProvider(prompt: string): string {
  return prompt;
}

// Keep track of session IDs per session key to avoid creating too many web chat sessions
const sessionMap = new LruMap<string, string>(500);
const parentMessageMap = new LruMap<string, string | number>(500);

type MessageContentPart = {
  type: string;
  text?: string;
  name?: string;
  arguments?: string;
  index?: number;
  id?: string;
};

export function createDeepseekWebStreamFn(cookieOrJson: string): StreamFn {
  let options: string | DeepSeekWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    if (typeof parsed === "string") {
      options = { cookie: parsed };
    } else {
      options = parsed;
    }
  } catch {
    options = { cookie: cookieOrJson };
  }
  const client = new DeepSeekWebClient(options);

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        let dsSessionId = sessionMap.get(sessionKey);
        let parentId = parentMessageMap.get(sessionKey);

        // Each session key (bucket) gets its own independent DS web chat session.
        // Cross-bucket fallback was removed because reusing an earlier-bucket session
        // causes DS to conflate different tasks (e.g. /init session memory leaks into
        // algorithm-writing turns). Middleware always sends full history in the prompt,
        // so a fresh DS session has complete context without needing prior session memory.
        if (!dsSessionId) {
          const session = await client.createChatSession();
          dsSessionId = session.chat_session_id || "";
          sessionMap.set(sessionKey, dsSessionId);
          parentId = undefined; // New session starts fresh
        }

        const messages = context.messages || [];
        const systemPrompt = (context as unknown as { systemPrompt?: string }).systemPrompt || "";
        console.log(
          `[DeepseekWebStream] Context messages count: ${messages.length}, hasSystemPrompt: ${!!systemPrompt}`,
        );
        let prompt = "";

        if (!parentId) {
          // First turn or new session: Aggregate all history including System Prompt
          const historyParts: string[] = [];

          const tools = context.tools || [];
          let systemPromptContent = systemPrompt;

          if (tools.length > 0) {
            let toolPrompt = "\n## Available Tools\n";
            for (const tool of tools) {
              toolPrompt += `- ${tool.name}: ${tool.description}\n`;
            }
            systemPromptContent += toolPrompt;
          }

          if (systemPromptContent && !messages.some((m) => (m.role as string) === "system")) {
            console.log(
              `[DeepseekWebStream] Prepending separate systemPrompt (length=${systemPromptContent.length})`,
            );
            historyParts.push(`System: ${systemPromptContent}`);
          }

          for (const m of messages) {
            const role =
              (m.role as string) === "user" || (m.role as string) === "toolResult"
                ? "User"
                : "Assistant";
            let content = "";

            if (m.role === "toolResult") {
              const tr = m as unknown as ToolResultMessage;
              let resultText = "";
              if (Array.isArray(tr.content)) {
                for (const part of tr.content) {
                  if (part.type === "text") {
                    resultText += part.text;
                  }
                }
              }
              content = `\n<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>\n`;
            } else if (Array.isArray(m.content)) {
              for (const part of m.content) {
                if (part.type === "text") {
                  content += part.text;
                } else if (part.type === "thinking") {
                  content += `<think>\n${part.thinking}\n</think>\n`;
                } else if (part.type === "toolCall") {
                  const tc = part;
                  content += `<tool_call id="${tc.id}" name="${tc.name}">${JSON.stringify(tc.arguments)}</tool_call>`;
                }
              }
            } else {
              content = String(m.content);
            }

            if ((m.role as string) === "user" && content) {
              content = stripForWebProvider(content) || content;
            }

            console.log(
              `[DeepseekWebStream] Message[${messages.indexOf(m)}] role=${m.role} length=${content.length} preview=${content.slice(0, 50).replace(/\n/g, " ")}`,
            );
            historyParts.push(`${role}: ${content}`);
          }

          prompt = historyParts.join("\n\n");

          // If the last message in context is from the assistant, DS has nothing to respond to.
          // Add an implicit continuation to ensure DS generates the next response.
          const lastCtxMsg = messages[messages.length - 1];
          if (lastCtxMsg && lastCtxMsg.role === 'assistant') {
            prompt += "\n\nUser: Please continue with the task.";
            console.log(`[DeepseekWebStream] Added implicit continuation prompt (last msg was assistant)`);
          }
        } else {
          // Continuing turn: Check if the last record is a ToolResult or User message
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === "toolResult") {
            const tr = lastMsg as unknown as ToolResultMessage;
            let resultText = "";
            if (Array.isArray(tr.content)) {
              for (const part of tr.content) {
                if (part.type === "text") {
                  resultText += part.text;
                }
              }
            }
            prompt = `\n<tool_response id="${tr.toolCallId}" name="${tr.toolName}">\n${resultText}\n</tool_response>\n\nPlease proceed based on this tool result.`;
          } else if (lastMsg.role === 'assistant') {
            // Last message is assistant - DS should continue executing
            prompt = "Please continue with the task.";
            console.log(`[DeepseekWebStream] Continuation with assistant-last: sending implicit continue prompt`);
          } else {
            // Standard user message logic
            const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
            if (lastUserMessage) {
              if (typeof lastUserMessage.content === "string") {
                prompt = stripForWebProvider(lastUserMessage.content) || lastUserMessage.content;
              } else if (Array.isArray(lastUserMessage.content)) {
                const raw = (lastUserMessage.content as MessageContentPart[])
                  .filter((part) => part.type === "text")
                  .map((part) => (part as TextContent).text)
                  .join("");
                prompt = stripForWebProvider(raw) || raw;
              }
            }
          }
        }

        console.log(
          `[DeepseekWebStream] Starting run for session: ${sessionKey}. DS session: ${dsSessionId}. Parent: ${parentId}. Prompt length: ${prompt.length}`,
        );
        console.log(`[DeepseekWebStream] Full Prompt Preview: ${prompt.slice(0, 500)}...`);

        if (!prompt) {
          console.error(`[DeepseekWebStream] No prompt to send:`, JSON.stringify(messages));
          throw new Error("No message found to send to DeepSeek web API");
        }

        const searchEnabled =
          (options as unknown as { searchEnabled?: boolean })?.searchEnabled ?? true;
        const preempt = (options as unknown as { preempt?: boolean })?.preempt ?? false;

        // ── 图片检测 & 上传 ──────────────────────────────────
        let modelType: string | undefined;
        let fileIds: string[] =
          (options as unknown as { fileIds?: string[] })?.fileIds || [];

        // 从消息中提取图片 URL 并上传到 DeepSeek
        const imageUrls: string[] = [];
        for (const m of messages) {
          const content = m.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === "image" && "image" in part) {
                const img = part as { image: string };
                imageUrls.push(img.image);
              }
            }
          }
        }

        if (imageUrls.length > 0) {
          console.log(
            `[DeepseekWebStream] Detected ${imageUrls.length} image(s), uploading to DeepSeek...`,
          );
          for (const url of imageUrls) {
            try {
              // 支持 data: URL 和 http(s) URL
              let fileBuffer: Buffer;
              let fileName: string;
              if (url.startsWith("data:")) {
                const [header, b64] = url.split(",", 2);
                const mimeMatch = header.match(/data:([^;]+)/);
                const mime = mimeMatch ? mimeMatch[1] : "image/png";
                fileBuffer = Buffer.from(b64, "base64");
                const ext = mime.split("/")[1] || "png";
                fileName = `image.${ext}`;
              } else {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                fileBuffer = Buffer.from(await resp.arrayBuffer());
                const contentType = resp.headers.get("content-type") || "";
                const ext = contentType.includes("png")
                  ? "png"
                  : contentType.includes("jpeg") || contentType.includes("jpg")
                    ? "jpg"
                    : contentType.includes("webp")
                      ? "webp"
                      : "png";
                fileName = `image.${ext}`;
              }
              const fileId = await client.uploadFile(fileBuffer, fileName);
              fileIds.push(fileId);
              console.log(
                `[DeepseekWebStream] Image uploaded: ${fileName} → ${fileId}`,
              );
            } catch (err) {
              console.error(
                `[DeepseekWebStream] Failed to upload image from ${url.substring(0, 80)}:`,
                err instanceof Error ? err.message : String(err),
              );
              throw new Error(
                `Failed to upload image to DeepSeek: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          // 图片模式下使用 vision 模型类型
          modelType = "vision";
        }

        const responseStream = await client.chatCompletions({
          sessionId: dsSessionId,
          parentMessageId: parentId,
          message: prompt,
          model: model.id,
          modelType,
          searchEnabled,
          preempt,
          fileIds,
          signal: options?.signal,
        });

        if (!responseStream) {
          throw new Error("DeepSeek Web API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let accumulatedContent = "";
        let accumulatedReasoning = "";
        const accumulatedToolCalls: MessageContentPart[] = [];
        let buffer = "";

        // Sequential indexing for pi-ai AssistantMessage events
        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];

        const createPartial = (): AssistantMessage => {
          const msg: AssistantMessage = {
            role: "assistant",
            content: [...contentParts],
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
            stopReason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
            timestamp: Date.now(),
          };
          (msg as unknown as { thinking_enabled: boolean }).thinking_enabled =
            !!accumulatedReasoning;
          return msg;
        };

        // Stateful parser for tags in the text stream
        let currentMode: "text" | "thinking" | "tool_call" = "text";
        let currentFragmentType: "THINK" | "RESPONSE" | "OTHER" = "OTHER"; // tracks DeepSeek fragment type
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";
        const PLAIN_TOOL_NAMES = new Set([
          "Write",
          "Read",
          "Glob",
          "Bash",
          "Edit",
          "MultiEdit",
          "LS",
          "Grep",
          "WebSearch",
          "WebFetch",
        ]);
        // DS-internal tools that should NOT be forwarded to CCC as tool_use blocks.
        // These are handled transparently by DS and must be suppressed before reaching the gateway.
        const INTERNAL_TOOLS = new Set(["web_search"]);

        const emitDelta = (
          type: "text" | "thinking" | "toolcall",
          delta: string,
          forceId?: string,
        ) => {
          if (delta === "" && type !== "toolcall") {
            return;
          }
          // Suppress internal DS tools (e.g. web_search) from being forwarded upstream.
          // These are DS-internal tool calls that CCC cannot execute. If we forward them,
          // CCC receives an unknown tool_use with wrong stop_reason (end_turn instead of
          // tool_use, because INTERNAL_TOOLS are filtered from finalContent). Suppressing
          // here prevents gateway/CCC confusion. DS search results are incorporated
          // invisibly into DS's subsequent response text.
          if (type === "toolcall" && INTERNAL_TOOLS.has(currentToolName)) {
            return;
          }

          const key = type === "toolcall" ? `tool_${currentToolIndex}` : type;
          if (!indexMap.has(key)) {
            const index = nextIndex++;
            indexMap.set(key, index);

            if (type === "text") {
              contentParts[index] = { type: "text", text: "" };
              stream.push({ type: "text_start", contentIndex: index, partial: createPartial() });
            } else if (type === "thinking") {
              contentParts[index] = { type: "thinking", thinking: "" };
              stream.push({
                type: "thinking_start",
                contentIndex: index,
                partial: createPartial(),
              });
            } else if (type === "toolcall") {
              const toolId = forceId || `call_${Date.now()}_${index}`;
              contentParts[index] = {
                type: "toolCall",
                id: toolId,
                name: currentToolName,
                arguments: {},
              };
              accumulatedToolCalls[currentToolIndex] = {
                type: "tool_call",
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
                id: toolId,
              };
              stream.push({
                type: "toolcall_start",
                contentIndex: index,
                partial: createPartial(),
              });
            }
          }

          const index = indexMap.get(key)!;
          if (type === "text") {
            (contentParts[index] as TextContent).text += delta;
            accumulatedContent += delta;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
            accumulatedReasoning += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "toolcall") {
            accumulatedToolCalls[currentToolIndex].arguments += delta;
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          }
        };

        let seenResponseMarker = false;

        const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
          if (!delta) {
            return;
          }

          // " response" is DeepSeek V3 thinking->response boundary marker
          if (delta === " response") {
            console.log(`[DeepseekWebStream] Detected response boundary marker`);
            seenResponseMarker = true;
            return;
          }

          // Junk token filtering (Unicode variants of end_of_thinking)
          const JUNK_TOKENS = [
            "<|end\u2581of\u2581thinking|>",
            "<\uff5cend_of_thinking\uff5c>",
            "<|end_of_thinking|>",
            "<|endoftext|>",
          ];
          if (JUNK_TOKENS.includes(delta)) {
            console.log(`[DeepseekWebStream] Filtering junk token: ${delta}`);
            return;
          }

          // After seeing the response marker, content should be text
          if (seenResponseMarker && !forceType) {
            forceType = "text";
          }
          if (forceType === "thinking") {
            emitDelta("thinking", delta);
            return;
          }

          tagBuffer += delta;

          const checkTags = () => {
            const closeCurrentToolCall = () => {
              const key = `tool_${currentToolIndex}`;
              const index = indexMap.get(key);
              if (index !== undefined) {
                const part = contentParts[index] as ToolCall;
                const argStr = accumulatedToolCalls[currentToolIndex].arguments || "{}";
                try {
                  part.arguments = JSON.parse(argStr);
                } catch {
                  // Fallback: parse XML-style arguments like <path>...</path><content>...</content>
                  const xmlArgs: Record<string, unknown> = {};
                  const xmlTagPattern = /<([a-zA-Z_][a-zA-Z0-9_]*)\s*[^>]*>([\s\S]*?)<\/\1>/g;
                  let xmlMatch;
                  while ((xmlMatch = xmlTagPattern.exec(argStr)) !== null) {
                    const xmlKey = xmlMatch[1];
                    const xmlValue = xmlMatch[2].trim();
                    try {
                      xmlArgs[xmlKey] = JSON.parse(xmlValue);
                    } catch {
                      xmlArgs[xmlKey] = xmlValue;
                    }
                  }
                  part.arguments = Object.keys(xmlArgs).length > 0 ? xmlArgs : { raw: argStr };
                }
                stream.push({
                  type: "toolcall_end",
                  contentIndex: index,
                  toolCall: part,
                  partial: createPartial(),
                });
              }
              currentMode = "text";
              currentToolIndex++;
              currentToolName = "";
            };

            const thinkStartMatch = tagBuffer.match(/<(?:think(?:ing)?|thought)\b[^<>]*>/i);
            const thinkEndMatch = tagBuffer.match(/<\/(?:think(?:ing)?|thought)\b[^<>]*>/i);
            const finalStartMatch = tagBuffer.match(/<final\b[^<>]*>/i);
            const finalEndMatch = tagBuffer.match(/<\/final\b[^<>]*>/i);
            // Support both <tool_call id="x" name="y"> and <tool_call name="y" id="x"> orders,
            // as well as id-only or name-only variants from DeepSeek
            const toolCallStartMatch =
              tagBuffer.match(
                /<tool_call\s+(?:id=['"]?([^'"]+)['"]?\s+)?name=['"]?([^'"]+)['"]?(?:\s+id=['"]?([^'"]+)['"]?)?\s*>/i,
              ) || tagBuffer.match(/<tool_call\s+id=['"]?([^'"]+)['"]?\s*>/i);
            // Match </tool_call> or </ToolName> (DS sometimes closes with the tool name, e.g. </Write>)
            const toolCallEndMatch = tagBuffer.match(/<\/tool_call\b[^<>]*>/i) ||
              (currentMode === "tool_call" && currentToolName
                ? tagBuffer.match(new RegExp(`<\\/${currentToolName}\\b[^<>]*>`, "i"))
                : null);
            // Plain-text tool calls emitted by some web models.
            // Format 1: Write({"key":"value"}) — JSON object args
            // Format 2: Glob(pattern="**/*", path="...") — Python kwargs (possibly with nested parens/triple-quotes)
            // Uses balanced-paren finder to handle content with nested ()
            const findPlainToolCall = (text: string) => {
              // Pattern 1: ToolName(kwargs) — Python function-call style
              const re = /\b([A-Z][A-Za-z_]+)\(/g;
              let m: RegExpExecArray | null;
              while ((m = re.exec(text)) !== null) {
                const name = m[1];
                if (!PLAIN_TOOL_NAMES.has(name)) continue;
                let depth = 1, i = m.index + m[0].length;
                let inDouble = false, inSingle = false, inTripleDouble = false, inTripleSingle = false;
                while (i < text.length && depth > 0) {
                  if (inTripleDouble) {
                    if (text.slice(i, i+3) === '"""') { inTripleDouble = false; i += 2; }
                    else if (text[i] === '\\') i++;
                  } else if (inTripleSingle) {
                    if (text.slice(i, i+3) === "'''") { inTripleSingle = false; i += 2; }
                    else if (text[i] === '\\') i++;
                  } else if (inDouble) {
                    if (text[i] === '\\') i++;
                    else if (text[i] === '"') inDouble = false;
                  } else if (inSingle) {
                    if (text[i] === '\\') i++;
                    else if (text[i] === "'") inSingle = false;
                  } else {
                    if (text.slice(i, i+3) === '"""') { inTripleDouble = true; i += 2; }
                    else if (text.slice(i, i+3) === "'''") { inTripleSingle = true; i += 2; }
                    else if (text[i] === '"') inDouble = true;
                    else if (text[i] === "'") inSingle = true;
                    else if (text[i] === '(') depth++;
                    else if (text[i] === ')') { depth--; if (depth === 0) { i++; break; } }
                  }
                  i++;
                }
                if (depth === 0) {
                  return { index: m.index, len: i - m.index, name, argsStr: text.slice(m.index + m[0].length, i - 1) };
                }
              }
              // Pattern 2: "Tool call: ToolName\nArguments: {json}" — text description style
              const tcRe = /Tool\s+call:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n+\s*Arguments?:\s*(\{)/i;
              const tcM = tcRe.exec(text);
              if (tcM) {
                const tcName = tcM[1];
                if (PLAIN_TOOL_NAMES.has(tcName)) {
                  const jsonStart = text.indexOf('{', tcM.index + tcM[0].length - 1);
                  if (jsonStart !== -1) {
                    let depth2 = 1, jj = jsonStart + 1;
                    while (jj < text.length && depth2 > 0) {
                      if (text[jj] === '{') depth2++;
                      else if (text[jj] === '}') { depth2--; if (depth2 === 0) { jj++; break; } }
                      else if (text[jj] === '"') { jj++; while (jj < text.length && text[jj] !== '"') { if (text[jj] === '\\') jj++; jj++; } }
                      jj++;
                    }
                    if (depth2 === 0) {
                      return { index: tcM.index, len: jj - tcM.index, name: tcName, argsStr: text.slice(jsonStart, jj) };
                    }
                  }
                }
              }
              return null;
            };
            const plainToolCallMatch = findPlainToolCall(tagBuffer);

            // Helper: convert Python kwargs string to JSON (handles triple-quoted strings)
            const kwargsToJson = (kwargsStr: string): string => {
              if (kwargsStr.trimStart().startsWith('{')) return kwargsStr;
              const result: Record<string, unknown> = {};
              let pos = 0;
              const skipWs = () => { while (pos < kwargsStr.length && /[\s,]/.test(kwargsStr[pos])) pos++; };
              while (pos < kwargsStr.length) {
                skipWs();
                if (pos >= kwargsStr.length) break;
                const keyMatch = kwargsStr.slice(pos).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*/);
                if (!keyMatch) break;
                const key = keyMatch[1];
                pos += keyMatch[0].length;
                let val: string;
                if (kwargsStr.startsWith('"""', pos) || kwargsStr.startsWith("'''", pos)) {
                  const q = kwargsStr.slice(pos, pos + 3);
                  pos += 3;
                  const end = kwargsStr.indexOf(q, pos);
                  val = end >= 0 ? kwargsStr.slice(pos, end) : kwargsStr.slice(pos);
                  if (end >= 0) pos = end + 3;
                } else if (kwargsStr[pos] === '"' || kwargsStr[pos] === "'") {
                  const q = kwargsStr[pos++];
                  let s = '';
                  while (pos < kwargsStr.length && kwargsStr[pos] !== q) {
                    if (kwargsStr[pos] === '\\') { pos++; s += kwargsStr[pos] ?? ''; }
                    else s += kwargsStr[pos];
                    pos++;
                  }
                  val = s;
                  if (pos < kwargsStr.length) pos++;
                } else {
                  const bareMatch = kwargsStr.slice(pos).match(/^[^,\s)]+/);
                  val = bareMatch ? bareMatch[0] : '';
                  pos += val.length;
                }
                result[key] = val;
                const key2 = key; void key2; // suppress unused warning
              }
              return JSON.stringify(result);
            };
            const replyMatch = tagBuffer.match(/\[\[reply_to_current\]\]/i);
            const malformedThinkMatch = tagBuffer.match(/\n?think\s*>/i);

            // Priority: find the first occurring tag
            const indices = [
              {
                type: "think_start",
                idx: thinkStartMatch ? thinkStartMatch.index! : -1,
                len: thinkStartMatch ? thinkStartMatch[0].length : 0,
              },
              {
                type: "think_end",
                idx: thinkEndMatch ? thinkEndMatch.index! : -1,
                len: thinkEndMatch ? thinkEndMatch[0].length : 0,
              },
              {
                type: "final_start",
                idx: finalStartMatch ? finalStartMatch.index! : -1,
                len: finalStartMatch ? finalStartMatch[0].length : 0,
              },
              {
                type: "final_end",
                idx: finalEndMatch ? finalEndMatch.index! : -1,
                len: finalEndMatch ? finalEndMatch[0].length : 0,
              },
              {
                type: "tool_call_start",
                idx: toolCallStartMatch ? toolCallStartMatch.index! : -1,
                len: toolCallStartMatch ? toolCallStartMatch[0].length : 0,
                id: toolCallStartMatch ? toolCallStartMatch[3] || toolCallStartMatch[1] : null,
                name: toolCallStartMatch
                  ? toolCallStartMatch[2] || toolCallStartMatch[1] || ""
                  : "",
              },
              {
                type: "tool_call_end",
                idx: toolCallEndMatch ? toolCallEndMatch.index! : -1,
                len: toolCallEndMatch ? toolCallEndMatch[0].length : 0,
              },
              {
                type: "plain_tool_call",
                idx: plainToolCallMatch ? plainToolCallMatch.index : -1,
                len: plainToolCallMatch ? plainToolCallMatch.len : 0,
                name: plainToolCallMatch ? plainToolCallMatch.name : "",
                args: plainToolCallMatch
                  ? (plainToolCallMatch.argsStr.trimStart().startsWith('{')
                    ? plainToolCallMatch.argsStr
                    : kwargsToJson(plainToolCallMatch.argsStr))
                  : "{}",
              },
              {
                type: "reply_marker",
                idx: replyMatch ? replyMatch.index! : -1,
                len: replyMatch ? replyMatch[0].length : 0,
              },
              {
                type: "think_start", // Treat malformed think> as start
                idx: malformedThinkMatch ? malformedThinkMatch.index! : -1,
                len: malformedThinkMatch ? malformedThinkMatch[0].length : 0,
              },
            ]
              .filter((tag) => tag.idx !== -1)
              .toSorted((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
              console.log(`[DeepseekWebStream] Tag detected: ${first.type} at ${first.idx}`);
              const before = tagBuffer.slice(0, first.idx);

              if (before) {
                if (currentMode === "thinking") {
                  emitDelta("thinking", before);
                } else if (currentMode === "tool_call") {
                  emitDelta("toolcall", before);
                } else {
                  emitDelta("text", before);
                }
              }

              if (first.type === "think_start") {
                currentMode = "thinking";
              } else if (first.type === "think_end") {
                currentMode = "text";
              } else if (first.type === "final_start") {
                currentMode = "text";
              } else if (first.type === "final_end") {
                currentMode = "text";
              } else if (first.type === "reply_marker") {
                currentMode = "text";
              } else if (first.type === "tool_call_start") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                const toolId = first.id || `call_${Date.now()}_${currentToolIndex}`;
                emitDelta("toolcall", "", toolId); // Trigger start event with specific ID
              } else if (first.type === "plain_tool_call") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                const toolId = `call_${Date.now()}_${currentToolIndex}`;
                emitDelta("toolcall", "", toolId); // toolcall_start
                emitDelta("toolcall", first.args || "{}");
                closeCurrentToolCall();
              } else if (first.type === "tool_call_end") {
                closeCurrentToolCall();
              }

              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              // No complete tags. Emit "safe" part of buffer.
              // Safe part is anything before the last '<'
              const lastAngle = tagBuffer.lastIndexOf("<");
              let holdFromIdx = lastAngle;

              // In text mode, also hold back partial plain-text tool calls so they can
              // accumulate fully before being matched. This prevents Glob({...}) from
              // being split across tiny SSE chunks and emitted as text prematurely.
              if (currentMode === "text") {
                // Case 1: buffer has an open ToolName( with unbalanced parens
                // Find if any known tool name has an open paren that's not yet closed
                const toolOpenRe = /\b([A-Z][A-Za-z_]+)\(/g;
                let toolOpenMatch: RegExpExecArray | null;
                while ((toolOpenMatch = toolOpenRe.exec(tagBuffer)) !== null) {
                  if (!PLAIN_TOOL_NAMES.has(toolOpenMatch[1])) continue;
                  // Count paren depth from this position
                  let depth = 1, j = toolOpenMatch.index + toolOpenMatch[0].length;
                  let inD = false, inS = false, inTD = false, inTS = false;
                  while (j < tagBuffer.length && depth > 0) {
                    if (inTD) { if (tagBuffer.slice(j,j+3) === '"""') { inTD = false; j+=2; } else if (tagBuffer[j]==='\\') j++; }
                    else if (inTS) { if (tagBuffer.slice(j,j+3) === "'''") { inTS = false; j+=2; } else if (tagBuffer[j]==='\\') j++; }
                    else if (inD) { if (tagBuffer[j]==='\\') j++; else if (tagBuffer[j]==='"') inD = false; }
                    else if (inS) { if (tagBuffer[j]==='\\') j++; else if (tagBuffer[j]==="'") inS = false; }
                    else {
                      if (tagBuffer.slice(j,j+3)==='"""') { inTD=true; j+=2; }
                      else if (tagBuffer.slice(j,j+3)==="'''") { inTS=true; j+=2; }
                      else if (tagBuffer[j]==='"') inD=true;
                      else if (tagBuffer[j]==="'") inS=true;
                      else if (tagBuffer[j]==='(') depth++;
                      else if (tagBuffer[j]===')') { depth--; if (depth===0) { j++; break; } }
                    }
                    j++;
                  }
                  if (depth > 0) {
                    // Unclosed paren — hold from the tool name
                    holdFromIdx = holdFromIdx === -1 ? toolOpenMatch.index : Math.min(holdFromIdx, toolOpenMatch.index);
                  }
                }

                // Case 2b: buffer has "Tool call: ToolName" (multi-line format DS sometimes emits)
                // Hold from the "Tool" keyword until the Arguments JSON is complete
                const tcTextRe = /Tool\s+call:\s*([A-Za-z_][A-Za-z0-9_]*)/i;
                const tcTextHold = tcTextRe.exec(tagBuffer);
                if (tcTextHold && PLAIN_TOOL_NAMES.has(tcTextHold[1])) {
                  // Only hold if the JSON part hasn't fully closed yet
                  const jsonStart = tagBuffer.indexOf('{', tcTextHold.index + tcTextHold[0].length);
                  if (jsonStart === -1) {
                    // No '{' yet — hold from the "Tool call" keyword
                    holdFromIdx = holdFromIdx === -1 ? tcTextHold.index : Math.min(holdFromIdx, tcTextHold.index);
                  } else {
                    let depth = 1, jj = jsonStart + 1;
                    while (jj < tagBuffer.length && depth > 0) {
                      if (tagBuffer[jj] === '{') depth++;
                      else if (tagBuffer[jj] === '}') { depth--; if (depth === 0) { jj++; break; } }
                      else if (tagBuffer[jj] === '"') { jj++; while (jj < tagBuffer.length && tagBuffer[jj] !== '"') { if (tagBuffer[jj] === '\\') jj++; jj++; } }
                      jj++;
                    }
                    if (depth > 0) {
                      // JSON still open — hold from "Tool call"
                      holdFromIdx = holdFromIdx === -1 ? tcTextHold.index : Math.min(holdFromIdx, tcTextHold.index);
                    }
                    // depth===0 means the full pattern is in the buffer; checkTags() will handle it via findPlainToolCall
                  }
                }

                // Case 2: buffer ends with a prefix of a known tool name (e.g. "Glo" → Glob)
                if (holdFromIdx === -1) {
                  const maxPfx = 12; // longer than the longest tool name
                  const tail = tagBuffer.slice(-maxPfx);
                  for (const toolName of PLAIN_TOOL_NAMES) {
                    for (let len = Math.min(toolName.length, tail.length); len >= 1; len--) {
                      if (tail.endsWith(toolName.slice(0, len))) {
                        const ptIdx = tagBuffer.length - len;
                        holdFromIdx = holdFromIdx === -1 ? ptIdx : Math.min(holdFromIdx, ptIdx);
                        break;
                      }
                    }
                  }
                }

                // Case 3: buffer ends with an open code fence (``` without closing ```)
                // DS often wraps tool calls in ```python\nWrite(...)\n```
                const openFenceMatch = tagBuffer.match(/```[^\n`]*$/);
                if (openFenceMatch) {
                  holdFromIdx = holdFromIdx === -1 ? openFenceMatch.index! : Math.min(holdFromIdx, openFenceMatch.index!);
                }
              }

              const emitMode = currentMode === "thinking" ? "thinking" : currentMode === "tool_call" ? "toolcall" : "text";
              if (holdFromIdx === -1) {
                emitDelta(emitMode, tagBuffer);
                tagBuffer = "";
              } else {
                const safe = tagBuffer.slice(0, holdFromIdx);
                if (safe) emitDelta(emitMode, safe);
                tagBuffer = tagBuffer.slice(holdFromIdx);
              }
              // If holdFromIdx is 0 we keep the entire buffer to accumulate more data
            }
          };

          checkTags();
        };

        const processLine = (line: string) => {
          if (!line) {
            return;
          }

          if (line.startsWith("event: ")) {
            return; // We don't strictly need currentEvent if we trust the data structure
          }

          if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              return;
            }
            if (!dataStr) {
              return;
            }

            try {
              const data = JSON.parse(dataStr);
              // Verbose SSE debug logging — log full raw dataStr for structure analysis
              if (dataStr && dataStr !== '[DONE]') {
                debugLog('sse-raw', { p: data.p, type: data.type, vType: typeof data.v, vPreview: typeof data.v === 'string' ? data.v.slice(0, 80) : JSON.stringify(data.v)?.slice(0, 200), raw: dataStr.slice(0, 500) });
              }

              // Capture session/message continuity
              if (data.response_message_id) {
                if (data.response_message_id !== parentMessageMap.get(sessionKey)) {
                  console.log(
                    `[DeepseekWebStream] New parentMessageId: ${data.response_message_id}`,
                  );
                  parentMessageMap.set(sessionKey, data.response_message_id);
                }
              }

              // 1. Path update or explicit type for reasoning
              if (
                (data.p?.includes("reasoning") || data.type === "thinking") &&
                typeof data.v === "string"
              ) {
                pushDelta(data.v, "thinking");
                return;
              }
              if (data.type === "thinking" && typeof data.content === "string") {
                pushDelta(data.content, "thinking");
                return;
              }

              // 1.5 Fragment APPEND — signals switch between THINK and RESPONSE blocks
              // e.g. {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"写",...}]}
              if (data.p === "response/fragments" && Array.isArray(data.v)) {
                for (const frag of data.v) {
                  const fragType = frag.type as string;
                  if (fragType === "THINK") {
                    currentFragmentType = "THINK";
                    currentMode = "thinking";
                    if (frag.content) pushDelta(frag.content, "thinking");
                  } else if (fragType === "RESPONSE") {
                    currentFragmentType = "RESPONSE";
                    currentMode = "text";
                    if (frag.content) pushDelta(frag.content, "text");
                  } else if (frag.content) {
                    pushDelta(frag.content);
                  }
                }
                return;
              }

              // 2. Incremental content — route based on current fragment type
              if (
                typeof data.v === "string" &&
                (!data.p || data.p.includes("content") || data.p.includes("choices"))
              ) {
                if (currentFragmentType === "THINK") {
                  pushDelta(data.v, "thinking");
                } else {
                  pushDelta(data.v);
                }
                return;
              }
              if (data.type === "text" && typeof data.content === "string") {
                pushDelta(data.content);
                return;
              }

              // 2.5 search results (if enabled)
              if (data.type === "search_result" || data.p?.includes("search_results")) {
                const searchData = data.v || data.content;
                const query =
                  typeof searchData === "string"
                    ? searchData
                    : (searchData as { query?: string })?.query;
                if (query) {
                  const searchMsg = `\n> [Researching: ${query}...]\n`;
                  if (currentMode === "thinking") {
                    emitDelta("thinking", searchMsg);
                  } else {
                    emitDelta("text", searchMsg);
                  }
                }
                return;
              }

              // 2.8 data.v as direct array (DeepSeek sometimes returns this format)
              if (Array.isArray(data.v)) {
                for (const frag of data.v) {
                  if (frag.type === "THINK" || frag.type === "THINKING" || frag.type === "reasoning") {
                    pushDelta(frag.content || "", "thinking");
                  } else if (
                    frag.p === "quasi_status" &&
                    frag.v === "FINISHED" &&
                    currentMode === "tool_call"
                  ) {
                    // DeepSeek may omit </tool_call> end tag; synthesize it on FINISHED signal
                    pushDelta(`</${currentToolName || "tool_call"}>`);
                  } else if (frag.content) {
                    pushDelta(frag.content);
                  }
                }
                return;
              }

              // 3. Nested fragments (init)
              const fragments = data.v?.response?.fragments;
              if (Array.isArray(fragments)) {
                for (const frag of fragments) {
                  if (frag.type === "THINK" || frag.type === "THINKING" || frag.type === "reasoning") {
                    currentFragmentType = "THINK";
                    currentMode = "thinking";
                    pushDelta(frag.content || "", "thinking");
                  } else if (frag.type === "RESPONSE") {
                    currentFragmentType = "RESPONSE";
                    currentMode = "text";
                    if (frag.content) pushDelta(frag.content);
                  } else if (frag.content) {
                    pushDelta(frag.content);
                  }
                }
                return;
              }

              // 4. Standard OpenAI-like choices (just in case)
              const choice = data.choices?.[0];
              if (choice) {
                if (choice.delta?.reasoning_content) {
                  pushDelta(choice.delta.reasoning_content, "thinking");
                }
                if (choice.delta?.content) {
                  pushDelta(choice.delta.content);
                }
              }
            } catch {
              // Ignore partial JSON
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }

            // Flush any remaining tag buffer
            // Flush any remaining tag buffer
            if (tagBuffer) {
              const mode = currentMode as unknown as string;
              if (mode === "thinking") {
                emitDelta("thinking", tagBuffer);
              } else if (mode === "tool_call") {
                emitDelta("toolcall", tagBuffer);
              } else {
                emitDelta("text", tagBuffer);
              }
              tagBuffer = "";
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || ""; // Save partial line

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        console.log(
          `[DeepseekWebStream] Stream completed. Content: ${accumulatedContent.length}, reasoning: ${accumulatedReasoning.length}, toolCalls: ${accumulatedToolCalls.length}`,
        );

        // Filter internal tools from final message (already suppressed in stream events above).
        const finalContent = contentParts.filter((part) => {
          if (part.type === "toolCall") {
            return !INTERNAL_TOOLS.has(part.name);
          }
          // Filter out empty thinking/text if they are totally empty to keep final message clean
          if (part.type === "thinking" && !part.thinking) {
            return false;
          }
          if (part.type === "text" && !part.text) {
            return false;
          }
          return true;
        });

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: finalContent,
          stopReason: finalContent.some((p) => p.type === "toolCall") ? "toolUse" : "stop",
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
        };
        (assistantMessage as unknown as { thinking_enabled: boolean }).thinking_enabled =
          !!accumulatedReasoning;

        stream.push({
          type: "done",
          reason: assistantMessage.stopReason as "stop" | "length" | "toolUse",
          message: assistantMessage,
        });
        // Log summary at stream end so we can diagnose DS decisions without joining
        // hundreds of delta records. thinkingTail lets us see why DS chose silence/text.
        debugLog('upstream', {
          layer: 'upstream', id: messageId,
          evtType: 'done',
          stopReason: assistantMessage.stopReason,
          textLen: accumulatedContent.length,
          thinkingLen: accumulatedReasoning.length,
          textPreview: accumulatedContent.slice(0, 200),
          thinkingTail: accumulatedReasoning.slice(-400),
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
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
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
