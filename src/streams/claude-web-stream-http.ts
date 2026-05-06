/**
 * Claude Web Stream — via browser fetch to claude.ai/api
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { getBrowser } from "../providers/browser-fetch.js";

const conversationMap = new Map<string, string>();
let cachedOrgId = "";

async function getOrgId(): Promise<string> {
  if (cachedOrgId) return cachedOrgId;
  const browser = await getBrowser();
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find(p => p.url().includes("claude.ai"));
  if (!page) {
    page = await ctx.newPage();
    await page.goto("https://claude.ai", { waitUntil: "domcontentloaded", timeout: 15000 });
  }
  const orgs = await page.evaluate(async () => {
    const r = await fetch("https://claude.ai/api/organizations", {
      headers: { "Content-Type": "application/json" },
    });
    return r.json();
  });
  cachedOrgId = (orgs as Array<{ uuid: string }>)[0]?.uuid || "";
  return cachedOrgId;
}

export function createClaudeWebStreamFn(_cookieOrJson: string): StreamFn {
  return (_model, context, _streamOptions) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const messages = (context.messages || []) as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
        let userMessage = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") {
            const c = messages[i].content;
            if (typeof c === "string") userMessage = c;
            else if (Array.isArray(c)) userMessage = c.filter(p => p.type === "text").map(p => p.text || "").join("");
            break;
          }
        }
        if (!userMessage) {
          stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: "No user message" } } as AssistantMessageEvent);
          stream.end();
          return;
        }

        const orgId = await getOrgId();
        const baseUrl = orgId
          ? `https://claude.ai/api/organizations/${orgId}/chat_conversations`
          : "https://claude.ai/api/chat_conversations";

        const browser = await getBrowser();
        const ctx = browser.contexts()[0];
        let page = ctx.pages().find(p => p.url().includes("claude.ai"));
        if (!page) {
          page = await ctx.newPage();
          await page.goto("https://claude.ai", { waitUntil: "domcontentloaded", timeout: 15000 });
        }

        // Create or reuse conversation
        const sessionKey = (context as Record<string, unknown>).sessionId as string || "default";
        let convId = conversationMap.get(sessionKey);

        if (!convId) {
          convId = await page.evaluate(async (url) => {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: "Chat", uuid: crypto.randomUUID() }),
            });
            const d = await r.json();
            return (d as { uuid: string }).uuid || "";
          }, baseUrl);
          if (convId) conversationMap.set(sessionKey, convId);
        }

        if (!convId) throw new Error("Failed to create Claude conversation");

        console.log(`[Claude-HTTP] Session: ${sessionKey}, convId: ${convId}, msgLen: ${userMessage.length}`);

        // Stream completion from within the browser page
        const chunks: string[] = [];
        const done = await page.evaluate(async ({ url, prompt }: { url: string; prompt: string }) => {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "anthropic-client-platform": "web_claude_ai",
            },
            body: JSON.stringify({ prompt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
          });
          const text = await r.text();
          return { ok: r.ok, status: r.status, text };
        }, { url: `${baseUrl}/${convId}/completion`, prompt: userMessage });

        if (!done.ok) {
          throw new Error(`Claude API error: ${done.status} - ${done.text.substring(0, 300)}`);
        }

        // Parse SSE response
        let fullText = "";
        const lines = done.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "completion" && data.completion) {
                fullText += data.completion;
                stream.push({
                  type: "text_delta", contentIndex: 0,
                  delta: data.completion, partial: {},
                } as AssistantMessageEvent);
              }
            } catch { /* skip */ }
          }
        }

        stream.push({
          type: "done", reason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: fullText }], stopReason: "stop" },
        } as AssistantMessageEvent);
      } catch (err) {
        console.error("[Claude-HTTP] Error:", err);
        stream.push({
          type: "error", reason: "error",
          error: { role: "assistant", content: [], stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) },
        } as AssistantMessageEvent);
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
