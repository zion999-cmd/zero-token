/**
 * GLM/ChatGLM Web Stream — via browser fetch to chatglm.cn backend API
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { getBrowser } from "../providers/browser-fetch.js";

const convMap = new Map<string, string>();

export function createGlmWebStreamFn(_cookieOrJson: string): StreamFn {
  return (_model, context, _streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      try {
        const messages = (context.messages || []) as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
        let msg = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            const c = messages[i].content;
            if (typeof c === "string") msg = c;
            else if (Array.isArray(c)) msg = c.filter(p => p.type === "text").map(p => p.text || "").join("");
            break;
          }
        }
        if (!msg) throw new Error("No user message");

        const browser = await getBrowser();
        const ctx = browser.contexts()[0];
        let page = ctx.pages().find(p => p.url().includes("chatglm.cn"));
        if (!page) {
          page = await ctx.newPage();
          await page.goto("https://chatglm.cn", { waitUntil: "domcontentloaded", timeout: 15000 });
        }

        const sessionKey = (context as Record<string, unknown>).sessionId as string || "default";
        let convId = convMap.get(sessionKey);

        const code = await page.evaluate(async ({ msg, convId }: { msg: string; convId: string | null }) => {
          const body: Record<string, unknown> = {
            prompt: msg,
            model: "glm-4.6",
            return_search_results: false,
          };
          if (convId) body.conversation_id = convId;

          const r = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          const text = await r.text();
          return { ok: r.ok, text };
        }, { msg, convId });

        if (!(code as { ok: boolean }).ok) throw new Error(`GLM API error: ${(code as { text: string }).text.substring(0, 200)}`);

        let fullText = "";
        const lines = (code as { text: string }).text.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const data = JSON.parse(dataStr);
            const delta = data.delta || data.content || data.text || "";
            if (delta) {
              fullText += delta;
              stream.push({ type: "text_delta", contentIndex: 0, delta, partial: {} } as AssistantMessageEvent);
            }
            // Save conversation ID from response
            if (data.conversation_id) convMap.set(sessionKey, data.conversation_id as string);
          } catch { /* skip */ }
        }

        stream.push({
          type: "done", reason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: fullText }], stopReason: "stop" },
        } as AssistantMessageEvent);
      } catch (err) {
        console.error("[GLM-HTTP] Error:", err);
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) } } as AssistantMessageEvent);
      } finally { stream.end(); }
    };
    queueMicrotask(() => void run());
    return stream;
  };
}
