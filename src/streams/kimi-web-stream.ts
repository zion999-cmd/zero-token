import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import {
  KimiWebClientBrowser,
  type KimiWebClientOptions,
} from "../providers/kimi-web-client-browser.js";
import { stripInboundMeta } from "./strip-inbound-meta.js";

const sessionMap = new Map<string, string>();

export function createKimiWebStreamFn(cookieOrJson: string): StreamFn {
  let options: KimiWebClientOptions;
  try {
    const parsed = JSON.parse(cookieOrJson);
    options = parsed;
  } catch {
    options = { cookie: cookieOrJson, userAgent: "Mozilla/5.0" };
  }
  const client = new KimiWebClientBrowser(options);

  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        await client.init();

        // Middleware (wrapWithToolCalling) always sends a single user message containing
        // the fully-formatted conversation history. Extract it directly — no session reuse.
        const messages = context.messages || [];
        const lastUserMsg = [...messages].reverse().find((m) => (m as { role: string }).role === "user");
        let prompt = "";
        if (lastUserMsg) {
          if (typeof lastUserMsg.content === "string") {
            prompt = lastUserMsg.content;
          } else if (Array.isArray(lastUserMsg.content)) {
            prompt = (lastUserMsg.content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text")
              .map((p) => p.text || "")
              .join("");
          }
        }

        prompt = stripInboundMeta(prompt);
        if (!prompt) {
          throw new Error("No message found to send to KimiWeb API");
        }

        console.log(`[KimiWebStream] Prompt length: ${prompt.length}`);
        console.log(`[KimiWebStream] Prompt preview: ${prompt.slice(0, 200).replace(/\n/g, " ")}`);

        // Reuse conversation session when available
        const sessionKey = (context as unknown as { sessionId?: string }).sessionId || "default";
        const cachedCid = sessionMap.get(sessionKey);

        const responseStream = await client.chatCompletions({
          message: prompt,
          model: model.id,
          signal: streamOptions?.signal,
          conversationId: cachedCid || undefined,
        });

        if (!responseStream) {
          throw new Error("KimiWeb API returned empty response body");
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
                      `[KimiWebStream] Failed to parse JSON for tool call ${currentToolName}: ${argStr}\nError: ${String(e)}`,
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

        // Kimi sometimes falls back to its native tool-call format instead of the
        // XML <tool_call name="..."> format we instruct in the prompt.
        // Convert it to the XML format so the existing pushDelta parser can handle it.
        // Format: <|tool_calls_section_begin|>
        //           <|tool_call_begin|> functions.ToolName:idx <|tool_call_argument_begin|> {json} <|tool_call_end|>
        //         <|tool_calls_section_end|>
        const convertKimiNativeFormat = (text: string): string => {
          if (!text.includes("<|tool_calls_section_begin|>")) return text;

          const sectionStart = text.indexOf("<|tool_calls_section_begin|>");
          const before = text.slice(0, sectionStart);
          const rest = text.slice(sectionStart + "<|tool_calls_section_begin|>".length);

          const sectionEndIdx = rest.indexOf("<|tool_calls_section_end|>");
          const section = sectionEndIdx !== -1 ? rest.slice(0, sectionEndIdx) : rest;
          const after = sectionEndIdx !== -1
            ? rest.slice(sectionEndIdx + "<|tool_calls_section_end|>".length)
            : "";

          const toolCallRegex =
            /<\|tool_call_begin\|>\s*(?:functions\.)?(\w+)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
          let converted = "";
          let match: RegExpExecArray | null;
          while ((match = toolCallRegex.exec(section)) !== null) {
            const name = match[1]!;
            const args = match[2]!.trim();
            converted += `<tool_call name="${name}">${args}</tool_call>`;
          }

          return before + converted + after;
        };

        const processLine = (line: string) => {
          if (!line || !line.startsWith("data:")) {
            return;
          }

          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) {
            return;
          }

          try {
            const data = JSON.parse(dataStr);

            // Extract content delta - Qwen v2 uses choices[0].delta.content
            let delta: string | undefined =
              data.choices?.[0]?.delta?.content ?? data.text ?? data.content ?? data.delta;
            if (typeof delta === "string" && delta) {
              delta = convertKimiNativeFormat(delta);
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

        // Flush remaining tag buffer
        if (tagBuffer) {
          const mode =
            (currentMode as string) === "thinking"
              ? "thinking"
              : (currentMode as string) === "tool_call"
                ? "toolcall"
                : "text";
          emitDelta(mode, tagBuffer);
          tagBuffer = "";
        }

        // Finalize any in-progress tool call: Kimi may omit the closing </tool_call> tag.
        if (currentMode === "tool_call") {
          const index = indexMap.get(`tool_${currentToolIndex}`);
          if (index !== undefined) {
            const part = contentParts[index] as ToolCall;
            const argStr = accumulatedToolCalls[currentToolIndex]?.arguments || "{}";
            let cleanedArg = argStr.trim();
            if (cleanedArg.startsWith("```json")) cleanedArg = cleanedArg.substring(7);
            else if (cleanedArg.startsWith("```")) cleanedArg = cleanedArg.substring(3);
            if (cleanedArg.endsWith("```")) cleanedArg = cleanedArg.substring(0, cleanedArg.length - 3);
            cleanedArg = cleanedArg.trim();
            try { part.arguments = JSON.parse(cleanedArg); } catch { part.arguments = { raw: argStr }; }
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: part, partial: createPartial() });
          }
          currentMode = "text";
        }

        // Save conversationId for next round
        const cid = client.currentConversationId;
        if (cid) sessionMap.set(sessionKey, cid);

        console.log(
          `[KimiWebStream] Stream completed. Parts: ${contentParts.length}, Tools: ${accumulatedToolCalls.length}, convId: ${cid || 'none'}`,
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
