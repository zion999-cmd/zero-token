import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  QwenWebClientBrowser,
  type QwenWebClientOptions,
  type QwenSessionState,
} from "../providers/qwen-web-client-browser.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

const sessionStateMap = new Map<string, QwenSessionState>();

export function createQwenWebStreamFn(cookieOrJson: string): StreamFn {
  let options: QwenWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    // 支持完整选项或仅 cookie
    if (typeof parsed === "string") {
      options = { sessionToken: parsed, cookie: parsed, userAgent: "Mozilla/5.0" };
    } else {
      options = {
        sessionToken: parsed.sessionToken || parsed.cookie || "",
        cookie: parsed.cookie || parsed.sessionToken || "",
        userAgent: parsed.userAgent || "Mozilla/5.0",
      };
    }
  } catch {
    // 如果不是 JSON，直接作为 sessionToken/cookie 使用
    options = { sessionToken: cookieOrJson, cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new QwenWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        const messages = context.messages || [];

        // Qwen web uses DOM simulation — only send the last user message.
        // System prompts, tools, and full history would overwhelm the input.
        let prompt = "";
        const imageUrls: Array<{ url: string; mimeType: string }> = [];
        const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
        if (lastUserMessage) {
          if (typeof lastUserMessage.content === "string") {
            prompt = lastUserMessage.content;
          } else if (Array.isArray(lastUserMessage.content)) {
            const parts = lastUserMessage.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
            for (const part of parts) {
              if (part.type === "text" && part.text) {
                prompt += part.text;
              } else if (part.type === "image_url" && part.image_url?.url) {
                const url = part.image_url.url;
                const mimeMatch = url.match(/^data:([^;]+);/);
                imageUrls.push({ url, mimeType: mimeMatch?.[1] || "image/png" });
              }
            }
          }
        }

        prompt = stripInboundMeta(prompt);
        if (!prompt && imageUrls.length === 0) {
          throw new Error("No message found to send to Qwen API");
        }

        // Image requests share a single default session to avoid creating one per frame.
        // Text-only requests use the context sessionId (auto-derived or explicit).
        const ctx = context as unknown as { sessionId?: string; hasSessionId?: boolean };
        const hasImages = imageUrls.length > 0;
        const sessionKey = hasImages
          ? (ctx.hasSessionId ? (ctx.sessionId || "image-default") : "image-default")
          : (ctx.sessionId || "default");
        const savedState = sessionStateMap.get(sessionKey);

        // Upload images via the browser page
        const fileMetas: import("../providers/qwen-web-client-browser.js").QwenFileMeta[] = [];
        for (const img of imageUrls) {
          if (img.url.startsWith("data:")) {
            const base64 = img.url.split(",")[1];
            if (base64) {
              const buffer = Buffer.from(base64, "base64");
              const ext = img.mimeType.split("/")[1] || "png";
              console.log(`[QwenWebStream] Uploading image (${buffer.length} bytes, ${img.mimeType})...`);
              const meta = await client.uploadFile(buffer, `image.${ext}`, img.mimeType);
              fileMetas.push(meta);
              console.log(`[QwenWebStream] Image uploaded: fileUuid=${meta.fileUuid}`);
            }
          }
        }

        console.log(`[QwenWebStream] Starting run for sessionKey=${sessionKey}, saved=${savedState?.sessionId?.slice(0, 8) || "none"}`);
        console.log(`[QwenWebStream] Prompt length: ${prompt.length}, Files: ${fileMetas.length}`);

        // Map our model ID to Qwen API model name
        const qwenModel = model.id?.includes("qwen") ? "qwen3.5-plus" : model.id;

        const responseStream = await client.chatCompletions({
          message: prompt,
          model: qwenModel,
          signal: streamOptions?.signal,
          fileMetas: fileMetas.length > 0 ? fileMetas : undefined,
          sessionState: savedState,
        });

        if (!responseStream) {
          throw new Error("Qwen API returned empty response body");
        }

        const reader = responseStream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const indexMap = new Map<string, number>();
        let nextIndex = 0;
        const contentParts: (TextContent | ThinkingContent | ToolCall)[] = [];
        const accumulatedToolCalls: {
          id: string;
          name: string;
          arguments: string;
          index: number;
        }[] = [];

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
          (msg as AssistantMessage & { thinking_enabled?: boolean }).thinking_enabled =
            contentParts.some((p) => p.type === "thinking");
          return msg;
        };

        let currentMode: "text" | "thinking" | "tool_call" = "text";
        let currentToolName = "";
        let currentToolIndex = 0;
        let tagBuffer = "";

        const emitDelta = (
          type: "text" | "thinking" | "toolcall",
          delta: string,
          forceId?: string,
        ) => {
          if (delta === "" && type !== "toolcall") {
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
                id: toolId,
                name: currentToolName,
                arguments: "",
                index: currentToolIndex,
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
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta,
              partial: createPartial(),
            });
          } else if (type === "thinking") {
            (contentParts[index] as ThinkingContent).thinking += delta;
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

        const pushDelta = (delta: string, forceType?: "text" | "thinking") => {
          if (!delta) {
            return;
          }
          if (forceType === "thinking") {
            emitDelta("thinking", delta);
            return;
          }
          tagBuffer += delta;

          const checkTags = () => {
            const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
            const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);
            const toolCallStart = tagBuffer.match(
              /<tool_call\s*(?:id=['"]?([^'"]+)['"]?\s*)?name=['"]?([^'"]+)['"]?\s*>/i,
            );
            const toolCallEnd = tagBuffer.match(/<\/tool_call\s*>/i);

            const indices = [
              {
                type: "think_start",
                idx: thinkStart?.index ?? -1,
                len: thinkStart?.[0].length ?? 0,
              },
              { type: "think_end", idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
              {
                type: "tool_start",
                idx: toolCallStart?.index ?? -1,
                len: toolCallStart?.[0].length ?? 0,
                id: toolCallStart?.[1],
                name: toolCallStart?.[2],
              },
              {
                type: "tool_end",
                idx: toolCallEnd?.index ?? -1,
                len: toolCallEnd?.[0].length ?? 0,
              },
            ]
              .filter((t) => t.idx !== -1)
              .toSorted((a, b) => a.idx - b.idx);

            if (indices.length > 0) {
              const first = indices[0];
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
              } else if (first.type === "tool_start") {
                currentMode = "tool_call";
                currentToolName = first.name!;
                emitDelta("toolcall", "", first.id);
              } else if (first.type === "tool_end") {
                const index = indexMap.get(`tool_${currentToolIndex}`);
                if (index !== undefined) {
                  const part = contentParts[index] as ToolCall;
                  const argStr = accumulatedToolCalls[currentToolIndex].arguments || "{}";

                  let cleanedArg = argStr.trim();
                  if (cleanedArg.startsWith("```json")) {
                    cleanedArg = cleanedArg.substring(7);
                  } else if (cleanedArg.startsWith("```")) {
                    cleanedArg = cleanedArg.substring(3);
                  }
                  if (cleanedArg.endsWith("```")) {
                    cleanedArg = cleanedArg.substring(0, cleanedArg.length - 3);
                  }
                  cleanedArg = cleanedArg.trim();

                  try {
                    part.arguments = JSON.parse(cleanedArg);
                  } catch (e) {
                    part.arguments = { raw: argStr };
                    console.error(
                      `[Qwen Stream] Failed to parse JSON for tool call ${currentToolName}:`,
                      argStr,
                      "\nError:",
                      e,
                    );
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
              }
              tagBuffer = tagBuffer.slice(first.idx + first.len);
              checkTags();
            } else {
              const lastAngle = tagBuffer.lastIndexOf("<");
              if (lastAngle === -1) {
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, tagBuffer);
                tagBuffer = "";
              } else if (lastAngle > 0) {
                const safe = tagBuffer.slice(0, lastAngle);
                const mode =
                  currentMode === "thinking"
                    ? "thinking"
                    : currentMode === "tool_call"
                      ? "toolcall"
                      : "text";
                emitDelta(mode, safe);
                tagBuffer = tagBuffer.slice(lastAngle);
              }
            }
          };
          checkTags();
        };

        let intlAccumulatedText = ""; // Track accumulated text for international API (chat2.qianwen.com)
        let firstLine = true;
        const processLine = (line: string) => {
          if (!line || !line.startsWith("data:")) {
            // Qwen API may return a JSON error response instead of SSE
            if (firstLine && line.startsWith("{")) {
              try {
                const err = JSON.parse(line);
                if (err.success === false) {
                  throw new Error(`Qwen API error: ${err.data?.code || "unknown"} - ${err.data?.details || JSON.stringify(err)}`);
                }
              } catch (e) {
                if (e instanceof SyntaxError) { /* not JSON, ignore */ }
                else throw e;
              }
            }
            firstLine = false;
            return;
          }
          firstLine = false;

          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }

          try {
            const data = JSON.parse(dataStr);

            // Capture server-returned session ID if different from our generated one.
            // The real session state (sessionId + topicId + lastReqId) is saved after response completes.

            // Extract content delta.
            // International API (chat2.qianwen.com): data.data.messages[] with mime_type
            // Domestic API (chat.qwen.ai): choices[0].delta.content
            if (data.data?.messages && Array.isArray(data.data.messages)) {
              for (const msg of data.data.messages as Array<{ mime_type?: string; content?: string; status?: string }>) {
                if (msg.content && (msg.mime_type === "text/plain" || msg.mime_type === "multi_load/iframe")) {
                  // The API sends accumulated text, not deltas. Only emit new characters.
                  const prevLen = intlAccumulatedText.length;
                  if (msg.content.length > prevLen) {
                    const delta = msg.content.slice(prevLen);
                    intlAccumulatedText = msg.content;
                    pushDelta(delta);
                  }
                }
              }
            } else {
              const delta =
                data.choices?.[0]?.delta?.content ?? data.text ?? data.content ?? data.delta;
              if (typeof delta === "string" && delta) {
                pushDelta(delta);
              }
            }
          } catch {
            // Ignore parse errors
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              processLine(buffer.trim());
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const combined = buffer + chunk;
          const parts = combined.split("\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            processLine(part.trim());
          }
        }

        // Flush remaining tag buffer
        if (tagBuffer) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          emitDelta(mode, tagBuffer);
        }

        // Persist session state for the next request on this session key
        const newState = client.getSessionState();
        sessionStateMap.set(sessionKey, newState);
        console.log(
          `[QwenWebStream] Stream completed. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}, session: ${newState.sessionId.slice(0, 8)}...`,
        );

        stream.push({
          type: "done",
          reason: accumulatedToolCalls.length > 0 ? "toolUse" : "stop",
          message: createPartial(),
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
        } as unknown as Parameters<typeof stream.push>[0]);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
