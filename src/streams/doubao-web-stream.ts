import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  DoubaoWebClientBrowser,
  type DoubaoWebClientOptions,
} from "../providers/doubao-web-client-browser.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

import { LruMap } from "../utils/lru-map.js";
const sessionMap = new LruMap<string, string>(500);

// Singleton client — creating a new DoubaoWebClientBrowser per request leaks
// Browser objects from chromium.connectOverCDP().
let clientPromise: Promise<DoubaoWebClientBrowser> | null = null;

export function createDoubaoWebStreamFn(cookieOrJson: string): StreamFn {
  let options: DoubaoWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = parsed;
  } catch {
    options = { cookie: cookieOrJson, sessionid: "" };
  }
  // Singleton: reuse client across requests to avoid Browser object leaks
  if (!clientPromise) {
    const client = new DoubaoWebClientBrowser(options);
    clientPromise = client.init().then(
      () => client,
      (err: unknown) => {
        // Never cache a failed init. A transient browser/CDP failure would
        // otherwise leave this provider permanently broken (every later request
        // awaits the same rejected promise) until the gateway restarts.
        clientPromise = null;
        throw err;
      },
    );
  }

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const client = await clientPromise!;

        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        let sessionId = sessionMap.get(sessionKey);

        const messages = context.messages || [];

        // Doubao web uses DOM simulation — only send the last user message.
        // System prompts, tools, and full history would overwhelm the input.
        let prompt = "";
        const lastUserMessage = [...messages].toReversed().find((m) => m.role === "user");
        if (lastUserMessage) {
          if (typeof lastUserMessage.content === "string") {
            prompt = lastUserMessage.content;
          } else if (Array.isArray(lastUserMessage.content)) {
            prompt = (lastUserMessage.content as TextContent[])
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
          }
        }

        prompt = stripInboundMeta(prompt);
        if (!prompt) {
          throw new Error("No message found to send to DoubaoWeb API");
        }

        console.log(`[DoubaoWebStream] Starting run for session: ${sessionKey}`);
        console.log(`[DoubaoWebStream] Conversation ID: ${sessionId || "new"}`);
        console.log(`[DoubaoWebStream] Prompt length: ${prompt.length}`);

        const responseStream = await client.chatCompletions({
          messages: [{ role: "user", content: prompt }],
          model: model.id,
          signal: streamOptions?.signal,
          conversationId: sessionId || undefined,
          rawText: true,
        });

        if (!responseStream) {
          throw new Error("DoubaoWeb API returned empty response body");
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

        // Accumulate raw text in a simple buffer and flush in batches to reduce
        // UI update frequency. Doubao sends every single Chinese character as a
        // separate SSE line, which floods the UI with tiny text_delta events.
        let textBuffer = "";
        const textFlushThreshold = 20;

        const flushTextBuffer = () => {
          if (!textBuffer) {
            return;
          }
          const text = textBuffer;
          textBuffer = "";
          emitDelta("text", text);
        };

        const pushDelta = (delta: string) => {
          if (!delta) {
            return;
          }

          // Buffer first, then let checkTags() strip tag markup BEFORE anything
          // is emitted per mode. Emitting raw deltas up-front leaked the split
          // tool-call tags ('">', </tool_call>) into the JSON arguments.
          tagBuffer += delta;

          const checkTags = (): void => {
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
                // Flush content buffered in earlier scans, then emit the part of
                // tagBuffer before the tag per current mode. Nothing in tagBuffer
                // has ever entered textBuffer, so emitting directly cannot double.
                flushTextBuffer();
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
                      `[Doubao Stream] Failed to parse JSON for tool call ${currentToolName}:`,
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
              // Recurse: everything remaining in tagBuffer is new unprocessed content.
              checkTags();
            } else {
              // No complete tag found. Hold back only a tail that can still
              // grow into one ('<', '</', '<tool_call name="x"', …) so markup
              // is never emitted as content; the rest is safe to emit now.
              const lastAngle = tagBuffer.lastIndexOf("<");
              let holdLen = 0;
              if (lastAngle !== -1) {
                const tail = tagBuffer.slice(lastAngle);
                const looksLikePartialTag =
                  !tail.includes(">") &&
                  /^<\/?[a-zA-Z_][\w-]*(?:\s[^<>]*)?$/.test(tail);
                if (looksLikePartialTag) {
                  holdLen = tail.length;
                }
              }
              const safe = tagBuffer.slice(0, tagBuffer.length - holdLen);

              if (safe) {
                if (currentMode === "tool_call") {
                  flushTextBuffer();
                  emitDelta("toolcall", safe);
                } else if (currentMode === "thinking") {
                  flushTextBuffer();
                  emitDelta("thinking", safe);
                } else {
                  textBuffer += safe;
                  if (textBuffer.length >= textFlushThreshold) {
                    flushTextBuffer();
                  }
                }
              }
              tagBuffer = holdLen > 0 ? tagBuffer.slice(tagBuffer.length - holdLen) : "";
            }
          };
          checkTags();
        };

        let lineCount = 0;
        const processLine = (line: string) => {
          lineCount++;
          if (!line || !line.startsWith("data:")) {
            return;
          }
          // Log first few lines and every 50th for diagnosis
          if (lineCount <= 5 || lineCount % 50 === 0) {
            console.log(
              `[DoubaoStream] line[${lineCount}]: ${line.slice(0, 120).replace(/\n/g, "\\n")}`,
            );
          }

          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }

          try {
            const data = JSON.parse(dataStr);

            // Extract conversation ID
            if (data.sessionId) {
              sessionMap.set(sessionKey, data.sessionId);
            }

            // Handle Doubao's event-based response format
            // event_type 2001 = message content (delta in event_data.message.content)
            // event_type 2002 = message created (no text)
            // event_type 2003 = unknown (empty keys in this trace)
            // event_type 2010 = seed intention (no text)
            let delta = "";

            if (data.event_data) {
              let eventData: Record<string, unknown>;
              if (typeof data.event_data === "string") {
                try {
                  eventData = JSON.parse(data.event_data);
                } catch {
                  eventData = {};
                }
              } else {
                eventData = data.event_data;
              }

              if (data.event_type === 2001) {
                // Message content: event_data.message.content is a JSON string
                // containing {text: "...", suggest: "...", suggestions: [...]}
                // We only want the text field, and we accumulate across events.
                const msg = eventData.message as Record<string, unknown> | undefined;
                const contentRaw = msg?.content;
                if (typeof contentRaw === "string") {
                  try {
                    const contentObj = JSON.parse(contentRaw);
                    delta = typeof contentObj.text === "string" ? contentObj.text : "";
                  } catch {
                    delta = "";
                  }
                } else {
                  delta = "";
                }
              } else if (data.event_type === 2003) {
                // Content delta at top level
                delta =
                  (eventData.text as string) ||
                  (eventData.content as string) ||
                  (eventData.delta as string) ||
                  "";
              }
            }

            // Standard format fallback
            if (!delta) {
              delta = data.choices?.[0]?.delta?.content ?? data.text ?? data.content ?? data.delta;
            }

            if (typeof delta === "string" && delta) {
              // Doubao sends incremental deltas (each event = new chars only).
              pushDelta(delta);
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

        // Flush any remaining text buffer and tag buffer at end of stream.
        // A held partial tag ('<', '</tool_c…' without closing '>') is markup
        // that never completed — drop it rather than corrupt tool arguments.
        if (tagBuffer && !/^<\/?[a-zA-Z_][\w-]*(\s[^<>]*)?$/.test(tagBuffer)) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          if (mode === "text") {
            // All remaining tagBuffer content is text
            textBuffer += tagBuffer;
          } else {
            // thinking or tool_call mode: flush pending text, then emit the
            // trailing tagBuffer content as the appropriate delta type
            flushTextBuffer();
            emitDelta(mode, tagBuffer);
          }
        }
        flushTextBuffer();

        // Save conversationId back for next round
        const cid = client.currentConversationId;
        if (cid) sessionMap.set(sessionKey, cid);

        console.log(
          `[DoubaoWebStream] Stream completed. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}, convId: ${cid || 'none'}`,
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
        } as Parameters<typeof stream.push>[0]);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
