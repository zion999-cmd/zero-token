/**
 * Grok Web Stream — via browser DOM interaction
 * Types message into grok.com and captures the response.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import { getBrowser } from "../providers/browser-fetch.js";

export function createGrokWebStreamFn(_cookieOrJson: string): StreamFn {
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
        let page = ctx.pages().find(p => p.url().includes("grok.com"));
        if (!page) {
          page = await ctx.newPage();
          await page.goto("https://grok.com", { waitUntil: "networkidle", timeout: 30000 });
        }

        // Wait for the input field to be ready
        await page.waitForSelector('textarea[placeholder], [contenteditable="true"], textarea', { timeout: 10000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));

        // Type message into the input
        const inputSelector = 'textarea[placeholder], [contenteditable="true"], textarea';
        const input = await page.$(inputSelector);
        if (!input) throw new Error("Grok: input field not found");
        await input.click();
        await page.keyboard.type(msg, { delay: 10 });
        await page.keyboard.press("Enter");
        await new Promise(r => setTimeout(r, 2000));

        // Poll for response text
        let fullText = "";
        let prevLen = 0;
        let stableCount = 0;

        for (let poll = 0; poll < 60; poll++) {
          const newText = await page.evaluate(() => {
            // Look for the latest assistant message
            const messages = document.querySelectorAll('[class*="message"], [class*="response"], [class*="prose"], [data-testid="response"]');
            if (messages.length > 0) {
              const last = messages[messages.length - 1];
              return (last as HTMLElement).textContent || "";
            }
            // Fallback: look for any large text block that appeared after our message
            const bodies = document.querySelectorAll('[class*="break-words"], p, .markdown');
            const texts = Array.from(bodies).map(el => (el as HTMLElement).textContent || "").filter(t => t.length > 20);
            return texts.length > 0 ? texts.join(" ") : "";
          });

          if (newText.length > prevLen) {
            const delta = newText.substring(prevLen);
            fullText += delta;
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial: {} } as AssistantMessageEvent);
            prevLen = newText.length;
            stableCount = 0;
          } else {
            stableCount++;
            if (stableCount >= 5 && fullText.length > 0) break;
          }
          await new Promise(r => setTimeout(r, 1000));
        }

        stream.push({
          type: "done", reason: "stop",
          message: { role: "assistant", content: [{ type: "text", text: fullText }], stopReason: "stop" },
        } as AssistantMessageEvent);
      } catch (err) {
        console.error("[Grok-Browser] Error:", err);
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: err instanceof Error ? err.message : String(err) } } as AssistantMessageEvent);
      } finally { stream.end(); }
    };
    queueMicrotask(() => void run());
    return stream;
  };
}
