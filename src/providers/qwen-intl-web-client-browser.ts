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

export interface QwenIntlWebClientOptions {
  cookie: string;
  xsrfToken: string;
  userAgent?: string;
  deviceId?: string;
  ut?: string;
}

/**
 * Qwen International Web Client (chat.qwen.ai) using Playwright browser context
 */
export class QwenIntlWebClientBrowser {
  private cookie: string;
  private xsrfToken: string;
  private userAgent: string;
  private deviceId: string;
  private ut: string;
  private baseUrl = "https://chat.qwen.ai";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  constructor(options: QwenIntlWebClientOptions | string) {
    let finalOptions: QwenIntlWebClientOptions;
    if (typeof options === "string") {
      try {
        finalOptions = JSON.parse(options);
      } catch {
        finalOptions = { cookie: options, xsrfToken: "" };
      }
    } else {
      finalOptions = options;
    }

    this.cookie = finalOptions.cookie || "";
    this.xsrfToken = finalOptions.xsrfToken || "";
    this.userAgent =
      finalOptions.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    this.ut = finalOptions.ut || "";

    if (!this.ut && this.cookie) {
      // Extract b-user-id from cookie string (format: "name1=val1; name2=val2")
      const parts = this.cookie.split(";");
      for (const part of parts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx !== -1) {
          const name = part.slice(0, eqIdx).trim();
          if (name === "b-user-id") {
            this.ut = part.slice(eqIdx + 1).trim();
            break;
          }
        }
      }
    }
    this.deviceId =
      finalOptions.deviceId || this.ut || "random-" + Math.random().toString(36).slice(2);
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
      console.log(`[Qwen Intl Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);

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

      const cdpBrowser = await chromium.connectOverCDP(wsUrl, {
        headers: getHeadersWithAuth(wsUrl),
      });
      const ctx = cdpBrowser.contexts()[0];
      if (!ctx) {
        throw new Error("CDP connection returned no browser context");
      }
      this.browser = ctx;

      const pages = ctx.pages();
      let qwenPage = pages.find((p) => p.url().includes("qwen.ai"));

      if (qwenPage) {
        console.log(`[Qwen Intl Web Browser] Found existing Qwen Intl page`);
        this.page = qwenPage;
      } else {
        console.log(`[Qwen Intl Web Browser] Creating new page`);
        this.page = await ctx.newPage();
        await this.page.goto("https://chat.qwen.ai/", { waitUntil: "domcontentloaded" });
      }

      console.log(`[Qwen Intl Web Browser] Connected successfully`);
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

      const cdpBrowser2 = await chromium.connectOverCDP(wsUrl, {
        headers: getHeadersWithAuth(wsUrl),
      });
      const ctx2 = cdpBrowser2.contexts()[0];
      if (!ctx2) {
        throw new Error("CDP connection returned no browser context");
      }
      this.browser = ctx2;

      this.page = ctx2.pages()[0] || (await ctx2.newPage());
    }

    const browserForCookies = this.browser;
    if (!browserForCookies) {
      throw new Error("Browser context missing after ensureBrowser setup");
    }

    const cookies = this.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".qwen.ai",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);

    if (cookies.length > 0) {
      try {
        await browserForCookies.addCookies(cookies);
      } catch (err) {
        console.warn(
          `[Qwen Intl Web Browser] addCookies failed (page may already have session): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { browser: this.browser, page: this.page };
  }

  async init() {
    await this.ensureBrowser();
  }

  /**
   * Upload a file to chat.qwen.ai via direct HTTP (no browser needed).
   * Returns the file metadata for inclusion in chat messages.
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<{ id: string; url: string }> {
    const { browser } = await this.ensureBrowser();
    const cookies = await browser.cookies();
    const cookieStr = cookies
      .filter((c) => c.domain.includes("qwen.ai"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(fileBuffer)], { type: mimeType }), fileName);

    const headers: Record<string, string> = {
      Cookie: cookieStr,
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };
    if (this.xsrfToken) headers["X-XSRF-TOKEN"] = this.xsrfToken;

    // Also try to get bearer token from page localStorage for auth
    try {
      const { page } = await this.ensureBrowser();
      const token = await page.evaluate(() => localStorage.getItem("token"));
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } catch { /* ok */ }

    const res = await fetch(`${this.baseUrl}/api/v1/files/`, {
      method: "POST",
      headers,
      body: fd,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`File upload failed: ${res.status} - ${errText.slice(0, 200)}`);
    }
    const data = (await res.json()) as { id: string };
    if (!data.id) throw new Error("File upload: no id in response");

    return {
      id: data.id,
      url: `${this.baseUrl}/api/v1/files/${data.id}/content`,
    };
  }

  async chatCompletions(params: {
    sessionId?: string;
    message: string;
    model?: string;
    parentMessageId?: string;
    signal?: AbortSignal;
    fileMetas?: Array<{ url: string }>;
  }): Promise<ReadableStream<Uint8Array>> {
    const { page } = await this.ensureBrowser();

    const model = params.model || "Qwen3.5-Plus";
    const fileMetas = params.fileMetas || [];
    const hasFiles = fileMetas.length > 0;
    const sessionId =
      params.sessionId ||
      Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

    console.log(`[Qwen Intl Web Browser] Sending message (model: ${model}, session: ${sessionId.slice(0, 8)}..., files: ${fileMetas.length})`);

    const timestamp = Date.now();
    const nonce = Math.random().toString(36).slice(2);

    const responseData = await page.evaluate(
      async ({
        baseUrl,
        sessionId,
        model,
        message,
        hasFiles,
        fileMetas,
        parentMessageId,
        ut,
        xsrfToken,
        deviceId,
        nonce,
        timestamp,
      }) => {
        try {
          const url = `${baseUrl}/api/v2/chat?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&nonce=${nonce}&timestamp=${timestamp}&ut=${ut}`;

          const apiMessages: Array<Record<string, unknown>> = [];
          if (hasFiles) {
            apiMessages.push({
              mime_type: "image/url",
              content: "",
              meta_data: { resource_infos: fileMetas.map((f) => ({ url: f.url })) },
            });
          }
          apiMessages.push({
            content: message,
            mime_type: "text/plain",
            meta_data: { ori_query: message },
          });

          const bodyObj: Record<string, unknown> = {
            model: model,
            messages: apiMessages,
            session_id: sessionId,
            parent_req_id: parentMessageId || "0",
            deep_search: "0",
            req_id: "req-" + Math.random().toString(36).slice(2),
            scene: "chat",
            sub_scene: "chat",
            temporary: false,
            from: "default",
            scene_param: parentMessageId ? "continue_chat" : "first_turn",
            chat_client: "h5",
            client_tm: timestamp.toString(),
            protocol_version: "v2",
            biz_id: "ai_qwen",
          };

          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream, text/plain, */*",
              Referer: `${baseUrl}/`,
              Origin: baseUrl,
              "x-xsrf-token": xsrfToken,
              "x-deviceid": deviceId,
              "x-platform": "pc_tongyi",
              "x-req-from": "pc_web",
            },
            body: JSON.stringify(bodyObj),
            credentials: "include",
          });

          if (!res.ok) {
            const errorText = await res.text();
            return { ok: false, status: res.status, error: errorText };
          }

          const reader = res.body?.getReader();
          if (!reader) {
            return { ok: false, status: 500, error: "No response body" };
          }

          const decoder = new TextDecoder();
          let fullText = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunk = decoder.decode(value, { stream: true });
            fullText += chunk;
          }

          return { ok: true, data: fullText };
        } catch (err) {
          return { ok: false, status: 500, error: String(err) };
        }
      },
      {
        baseUrl: this.baseUrl,
        sessionId,
        model,
        message: params.message,
        hasFiles,
        fileMetas,
        parentMessageId: params.parentMessageId,
        ut: this.ut,
        xsrfToken: this.xsrfToken,
        deviceId: this.deviceId,
        nonce,
        timestamp,
      },
    );
    console.log(
      `[Qwen Intl Web Browser] Response data: ok=${responseData?.ok}, status=${responseData?.status}, data length=${responseData?.data?.length}`,
    );
    if (responseData?.data && responseData.data.length > 0) {
      console.log(
        `[Qwen Intl Web Browser] Response preview: ${responseData.data.substring(0, 200)}...`,
      );
    }
    if (!responseData || !responseData.ok) {
      throw new Error(
        `Qwen Intl API error: ${responseData?.status || "unknown"} - ${responseData?.error || "Request failed"}`,
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(responseData.data));
        controller.close();
      },
    });

    return stream;
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
        id: "Qwen3.5-Plus",
        name: "Qwen 3.5 Plus (International)",
        api: "qwen-intl-web",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "Qwen3.5-Turbo",
        name: "Qwen 3.5 Turbo (International)",
        api: "qwen-intl-web",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ];
  }
}
