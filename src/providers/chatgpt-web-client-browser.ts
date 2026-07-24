import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { getHeadersWithAuth } from "../../../extensions/browser/src/browser/cdp.helpers.js";
import {
  launchOpenClawChrome,
  stopOpenClawChrome,
  getChromeWebSocketUrl,
  type RunningChrome,
} from "../../../extensions/browser/src/browser/chrome.js";
import {
  resolveBrowserConfig,
  resolveProfile,
} from "../../../extensions/browser/src/browser/config.js";
import { loadConfig } from "../../config/io.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";

export interface ChatGPTWebClientOptions {
  accessToken: string;
  cookie?: string;
  userAgent?: string;
}

export interface ChatGPTConversation {
  id: string;
  title: string;
  created_at?: number;
}

/**
 * ChatGPT Web Client using Playwright browser context
 */
export class ChatGPTWebClientBrowser {
  private accessToken: string;
  private cookie: string;
  private userAgent: string;
  private baseUrl = "https://chatgpt.com";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  constructor(options: ChatGPTWebClientOptions | string) {
    if (typeof options === "string") {
      const parsed = JSON.parse(options) as ChatGPTWebClientOptions;
      this.accessToken = parsed.accessToken;
      this.cookie = parsed.cookie || `__Secure-next-auth.session-token=${parsed.accessToken}`;
      this.userAgent = parsed.userAgent || "Mozilla/5.0";
    } else {
      this.accessToken = options.accessToken;
      this.cookie = options.cookie || `__Secure-next-auth.session-token=${options.accessToken}`;
      this.userAgent = options.userAgent || "Mozilla/5.0";
    }
  }

  private async ensureBrowser() {
    if (this.browser && this.page) {
      return { browser: this.browser, page: this.page };
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    if (browserConfig.attachOnly) {
      console.log(`[ChatGPT Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);

      let wsUrl: string | null = null;
      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(profile.cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!wsUrl) {
        throw new Error(
          `Failed to connect to Chrome at ${profile.cdpUrl}. ` +
            `Make sure Chrome is running in debug mode`,
        );
      }

      this.browser = (
        await chromium.connectOverCDP(wsUrl, {
          headers: getHeadersWithAuth(wsUrl),
        })
      ).contexts()[0]!;

      const pages = this.browser.pages();
      const chatgptPage = pages.find((p) => p.url().includes("chatgpt.com"));

      if (chatgptPage) {
        console.log(`[ChatGPT Web Browser] Found existing ChatGPT page: ${chatgptPage.url()}`);
        this.page = chatgptPage;
      } else {
        console.log(`[ChatGPT Web Browser] No ChatGPT page found, creating new one...`);
        this.page = await this.browser.newPage();
        await this.page.goto("https://chatgpt.com/", { waitUntil: "load" });
      }

      await this.ensureChatGptPageReady();
      console.log(`[ChatGPT Web Browser] Connected to existing Chrome successfully`);
    } else {
      this.running = await launchOpenClawChrome(browserConfig, profile);

      const cdpUrl = `http://127.0.0.1:${this.running.cdpPort}`;
      let wsUrl: string | null = null;

      for (let i = 0; i < 10; i++) {
        wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
        if (wsUrl) {
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!wsUrl) {
        throw new Error(`Failed to resolve Chrome WebSocket URL from ${cdpUrl}`);
      }

      this.browser = (
        await chromium.connectOverCDP(wsUrl, {
          headers: getHeadersWithAuth(wsUrl),
        })
      ).contexts()[0]!;

      this.page = this.browser.pages()[0] || (await this.browser.newPage());
      if (!this.page.url().includes("chatgpt.com")) {
        await this.page.goto("https://chatgpt.com/", { waitUntil: "load" });
      }
      await this.ensureChatGptPageReady();
    }

    const cookieStr = typeof this.cookie === "string" ? this.cookie.trim() : "";
    if (cookieStr && !cookieStr.startsWith("{")) {
      const rawCookies = cookieStr.split(";").map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".chatgpt.com",
          path: "/",
        };
      });
      const cookies = rawCookies.filter((c) => c.name.length > 0);
      if (cookies.length > 0) {
        try {
          await this.browser.addCookies(cookies);
        } catch (err) {
          console.warn(
            `[ChatGPT Web Browser] addCookies failed (page may already have session): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return { browser: this.browser, page: this.page };
  }

  /** 确保 chatgpt.com 页面已加载且 oaistatic Sentinel 脚本已就绪 */
  private async ensureChatGptPageReady() {
    if (!this.page) {
      return;
    }
    if (!this.page.url().includes("chatgpt.com")) {
      await this.page.goto("https://chatgpt.com/", { waitUntil: "load" });
    }
    try {
      await this.page.waitForFunction(
        () => {
          const scripts = Array.from(document.scripts);
          return scripts.some((s) => s.src?.includes("oaistatic.com") && s.src?.endsWith(".js"));
        },
        { timeout: 15000 },
      );
    } catch {
      console.warn("[ChatGPT Web Browser] oaistatic script not found in 15s, continuing anyway");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  /**
   * DOM 模拟：通过真实浏览器交互发送消息，绕过 403 风控
   * 参考：zsodur/chatgpt-api-by-browser-script 等 DOM 模拟实现
   */
  private async chatCompletionsViaDOM(params: {
    message: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const { page } = await this.ensureBrowser();

    // Use Playwright native APIs for reliable input (same as Gemini/Grok/Perplexity)
    const inputSelectors = [
      "#prompt-textarea",
      "textarea[placeholder]",
      "textarea",
      '[contenteditable="true"]',
    ];
    let inputHandle = null;
    for (const sel of inputSelectors) {
      inputHandle = await page.$(sel);
      if (inputHandle) {
        break;
      }
    }
    if (!inputHandle) {
      throw new Error("ChatGPT DOM 模拟失败: 找不到输入框");
    }

    await inputHandle.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(params.message, { delay: 20 });
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    console.log("[ChatGPT Web Browser] DOM: typed message and pressed Enter");

    // 轮询等待回复完成（最多约 90 秒，降低频率减少封号风险）
    const maxWaitMs = 90000;
    const pollIntervalMs = 2000;
    let lastText = "";
    let stableCount = 0;
    const signal = params.signal;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      if (signal?.aborted) {
        throw new Error("ChatGPT 请求已取消");
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));

      // Use string-form page.evaluate to avoid esbuild __name helper injection
      const rawResult = await page.evaluate(`(() => {
        const clean = (t) => t.replace(/[\\u200B-\\u200D\\uFEFF]/g, "").trim();
        const els = document.querySelectorAll(
          'div[data-message-author-role="assistant"], .agent-turn [data-message-author-role="assistant"], [class*="markdown"], [class*="assistant"]'
        );
        const last = els.length > 0 ? els[els.length - 1] : null;
        const text = last ? clean(last.textContent || "") : "";
        const stopBtn = document.querySelector('button.bg-black .icon-lg, [aria-label*="Stop"]');
        const isStreaming = !!stopBtn;
        return JSON.stringify({ text, isStreaming });
      })()`);
      let result: { text: string; isStreaming: boolean };
      try {
        result = JSON.parse(rawResult);
      } catch {
        result = { text: "", isStreaming: false };
      }

      if (result.text && result.text !== lastText) {
        lastText = result.text;
        stableCount = 0;
      } else if (result.text) {
        stableCount++;
        if (!result.isStreaming && stableCount >= 2) {
          break;
        }
      }
    }


    if (!lastText) {
      throw new Error(
        "ChatGPT DOM 模拟：未检测到回复。请确保 chatgpt.com 页面已打开并登录，且输入框可见。",
      );
    }

    const fakeSse = `data: ${JSON.stringify({
      message: { id: "dom-fallback", content: { parts: [lastText] } },
    })}\n\ndata: [DONE]\n\n`;
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(fakeSse));
        controller.close();
      },
    });
  }

  async init() {
    await this.ensureBrowser();
  }

  async chatCompletions(params: {
    conversationId?: string;
    parentMessageId?: string;
    message: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    await this.ensureBrowser();

    console.log(`[ChatGPT Web Browser] Sending message`);
    console.log(`[ChatGPT Web Browser] Conversation ID: ${params.conversationId || "new"}`);
    console.log(`[ChatGPT Web Browser] Model: ${params.model || "gpt-4"}`);

    // Since ChatGPT removed oaistatic scripts from the page (~2025-07),
    // the sentinel-based API path is broken (returns 403 "Unusual activity").
    // DOM simulation is the only reliable approach — it types directly
    // into the ChatGPT browser page and polls for the response.
    console.log(`[ChatGPT Web Browser] Using DOM simulation (sentinel API path is obsolete)`);
    return this.chatCompletionsViaDOM({
      message: params.message,
      signal: params.signal,
    });
  }

  async close() {
    if (this.running) {
      await stopOpenClawChrome(this.running);
      this.running = null;
    }
    this.browser = null;
    this.page = null;
  }

  async discoverModels(): Promise<ModelDefinitionConfig[]> {
    return [
      {
        id: "gpt-4",
        name: "GPT-4",
        api: "chatgpt-web",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 4096,
      },
    ] as ModelDefinitionConfig[];
  }
}
