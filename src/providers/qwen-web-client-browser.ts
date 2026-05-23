import crypto from "node:crypto";
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

export interface QwenWebClientOptions {
  sessionToken: string;
  cookie?: string;
  userAgent?: string;
}

/**
 * Qwen Web Client using Playwright browser context
 */
export class QwenWebClientBrowser {
  private sessionToken: string;
  private cookie: string;
  private userAgent: string;
  private baseUrl = "https://chat.qwen.ai";       // API gateway
  private pageUrl = "https://www.qianwen.com/chat/"; // web UI
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  constructor(options: QwenWebClientOptions | string) {
    if (typeof options === "string") {
      const parsed = JSON.parse(options) as QwenWebClientOptions;
      this.sessionToken = parsed.sessionToken;
      this.cookie = parsed.cookie || `qwen_session=${parsed.sessionToken}`;
      this.userAgent = parsed.userAgent || "Mozilla/5.0";
    } else {
      this.sessionToken = options.sessionToken;
      this.cookie = options.cookie || `qwen_session=${options.sessionToken}`;
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
      console.log(`[Qwen Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);

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
      let qwenPage = pages.find((p) => p.url().includes("qianwen.com") || p.url().includes("qwen.ai"));

      if (qwenPage) {
        console.log(`[Qwen Web Browser] Found existing Qwen page`);
        this.page = qwenPage;
      } else {
        console.log(`[Qwen Web Browser] Creating new page`);
        this.page = await this.browser.newPage();
        await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded" });
      }

      console.log(`[Qwen Web Browser] Connected successfully`);
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
    }

    const cookies = this.cookie.split(";").map((c) => {
      const [name, ...valueParts] = c.trim().split("=");
      return {
        name: name.trim(),
        value: valueParts.join("=").trim(),
        domain: ".qianwen.com",
        path: "/",
      };
    });

    await this.browser.addCookies(cookies);

    return { browser: this.browser, page: this.page };
  }

  async init() {
    await this.ensureBrowser();
  }

  
  async chatCompletions(params: {
    message: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    const { browser } = await this.ensureBrowser();

    const model = params.model || "qwen3.5-plus";

    console.log(`[Qwen Web Browser] Sending (model: ${model}, len: ${params.message.length})`);

    // Get cookies from browser context for API auth
    const cookies = await browser.cookies([this.baseUrl, this.pageUrl]);
    const cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // Step 1: Create chat session via Node.js fetch
    const createChatTimeoutMs = 30_000;
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), createChatTimeoutMs);

    let createRes: Response;
    try {
      createRes = await fetch(`${this.baseUrl}/api/v2/chats/new`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify({}),
        signal: ctrl1.signal,
      });
    } catch (err) {
      clearTimeout(t1);
      throw new Error(`Failed to create Qwen chat: ${String(err)}`);
    }
    clearTimeout(t1);

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(`Failed to create Qwen chat: ${createRes.status} - ${errText.slice(0, 300)}`);
    }

    const createData = await createRes.json() as Record<string, unknown>;
    const chatId = (createData as any).data?.id ?? (createData as any).chat_id ?? (createData as any).id;
    if (!chatId) {
      throw new Error("No chat_id in Qwen response");
    }
    console.log(`[Qwen Web Browser] Chat ID: ${chatId}`);

    // Step 2: Send message via Node.js fetch
    const fetchTimeoutMs = 300_000;
    const fid = crypto.randomUUID();
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), fetchTimeoutMs);

    const requestBody = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model: model,
      parent_id: null,
      messages: [{
        fid,
        parentId: null,
        childrenIds: [],
        role: "user",
        content: params.message,
        user_action: "chat",
        files: [],
        timestamp: Math.floor(Date.now() / 1000),
        models: [model],
        chat_type: "t2t",
        feature_config: { thinking_enabled: true, output_schema: "phase" },
      }],
    };

    let msgRes: Response;
    try {
      msgRes = await fetch(`${this.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: ctrl2.signal,
      });
    } catch (err) {
      clearTimeout(t2);
      const msg = String(err);
      if (msg.includes("aborted") || msg.includes("signal")) {
        throw new Error(`Qwen API request timed out after ${fetchTimeoutMs / 1000}s`);
      }
      throw err;
    }
    clearTimeout(t2);

    if (!msgRes.ok) {
      if (msgRes.status === 401 || msgRes.status === 403) {
        throw new Error("Authentication failed. Please re-run onboarding to refresh your Qwen session.");
      }
      const errText = await msgRes.text().catch(() => "");
      throw new Error(`Qwen API error: ${msgRes.status} - ${errText.slice(0, 300)}`);
    }

    // Stream the response directly
    const reader = msgRes.body?.getReader();
    if (!reader) throw new Error("Qwen API returned empty response body");

    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
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
        id: "qwen3.5-plus",
        name: "Qwen 3.5 Plus",
        api: "qwen-web",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      },
    ] as ModelDefinitionConfig[];
  }
}
