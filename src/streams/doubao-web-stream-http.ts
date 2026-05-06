/**
 * Doubao Web Stream — via DoubaoWebClient (non-browser HTTP client)
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { DoubaoWebClient, type DoubaoMessage } from "../providers/doubao-web-client.js";

export function createDoubaoWebStreamFn(cookieOrJson: string): StreamFn {
  let sessionid = "";
  let fp = "";
  try {
    const parsed = JSON.parse(cookieOrJson);
    sessionid = parsed.sessionid || "";
    fp = parsed.fp || parsed.ttwid || "";
  } catch {
    sessionid = cookieOrJson;
  }

  const client = new DoubaoWebClient({ sessionid, fp }, {});

  return (_model, context, _streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const messages = (context.messages || []) as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
        const msgList: DoubaoMessage[] = messages.map(m => {
          let c = "";
          if (typeof m.content === "string") c = m.content;
          else if (Array.isArray(m.content)) c = m.content.filter(p => p.type === "text").map(p => p.text || "").join("");
          return { role: m.role as "user" | "assistant", content: c };
        });

        console.log(`[Doubao-HTTP] Sending ${msgList.length} messages`);

        const resp = await client.chatCompletions({
          model: "doubao-pro-256k",
          messages: msgList,
          stream: true,
        });

        let fullText = "";
        if (resp && typeof resp[Symbol.asyncIterator] === "function") {
          for await (const chunk of resp as AsyncIterable<string>) {
            fullText += chunk;
            stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: {} } as AssistantMessageEvent);
          }
        } else if (resp && (resp as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content) {
          fullText = (resp as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
          stream.push({ type: "text_delta", contentIndex: 0, delta: fullText, partial: {} } as AssistantMessageEvent);
        }

        stream.push({
          type: "done", reason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: fullText }], stopReason: "stop" },
        } as AssistantMessageEvent);
      } catch (err) {
        console.error("[Doubao-HTTP] Error:", err);
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) } } as AssistantMessageEvent);
      } finally { stream.end(); }
    };
    queueMicrotask(() => void run());
    return stream;
  };
}
