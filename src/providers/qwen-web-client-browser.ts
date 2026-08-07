import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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

export interface QwenFileMeta {
  fileUuid: string;
  batchId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  url: string;
}

export interface QwenSessionState {
  sessionId: string;
  topicId: string;
  lastReqId: string;
}

export interface QwenWebClientOptions {
  sessionToken: string;
  cookie?: string;
  userAgent?: string;
}

/**
 * Qwen Web Client using Playwright browser context.
 * Domestic CN version: page at www.qianwen.com/chat/, API at chat2.qianwen.com.
 *
 * ## Image upload mechanism (⚠️ read before modifying)
 *
 * The full image upload pipeline:
 *
 * ```
 *   API receives image_url (base64 data URL)
 *     → stream decodes base64, writes temp file
 *     → client.uploadFile() called
 *       → CDP Network.enable (monitor file/record/add)
 *       → find hidden <input type="file"> on the page
 *       → Playwright setInputFiles(tmpFile)
 *       → page JS detects file selection → OSS upload → file/record/add API
 *       → CDP captures response → extract fileUuid + url
 *     → chatCompletions() sends OSS URL in API request body
 *       → POST chat2.qianwen.com/api/v2/chat
 * ```
 *
 * ### Critical details:
 *
 * 1. **Page matching**: MUST match CN page (qianwen.com) BEFORE Intl page (qwen.ai).
 *    The Intl page has a file input with `accept=""` which doesn't match the
 *    `accept*=".png"` / `accept*="image"` selectors used here. If the Intl page
 *    is matched first, `uploadFile()` fails with "No image file input found".
 *
 * 2. **File input is NOT persistent**: Qwen CN creates the hidden `<input type="file">`
 *    dynamically ONLY after clicking "添加附件" → "上传图片" in the Radix dropdown menu.
 *    Previous versions relied on a dedicated newPage() + goto() which triggered full
 *    page render including the hidden input. After the refactor to reuse the main page,
 *    the input may not exist yet on the landing/dashboard view.
 *
 * 3. **waitForSelector needs `state: 'attached'`**: The file input is `display: none`.
 *    Playwright's default `state: 'visible'` will timeout. Always use `state: 'attached'`.
 *
 * 4. **Browser session integrity required**: The oss_token → OSS PUT → callback →
 *    file/record/add chain requires browser cookies/CSRF tokens. Direct Node.js fetch()
 *    was tried (commit cb9087b) but failed — the OSS callback rejects non-browser requests.
 *    The upload MUST go through the browser page.
 *
 * 5. **10-image limit**: Qwen's frontend limits the chat input to 10 images.
 *    The cleanup code in `uploadFile()` clears the file input value and clicks
 *    close/remove buttons on image previews after each upload to reset the counter.
 */
export class QwenWebClientBrowser {
  private sessionToken: string;
  private cookie: string;
  private userAgent: string;
  private apiBase = "https://chat2.qianwen.com";
  private pageUrl = "https://www.qianwen.com/chat/";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;

  // Session state for conversation continuity
  private sessionId = "";
  private topicId = "";
  private lastReqId = "";
  private deviceId = "";

  /** Expose session state so the stream can persist it across requests. */
  getSessionState(): QwenSessionState {
    return {
      sessionId: this.sessionId,
      topicId: this.topicId,
      lastReqId: this.lastReqId,
    };
  }

  /** Restore a previously saved session state. */
  restoreSession(state: QwenSessionState) {
    this.sessionId = state.sessionId;
    this.topicId = state.topicId;
    this.lastReqId = state.lastReqId;
  }

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

  /** Generate a topic ID in the same format the page uses (22 char base62). */
  private generateTopicId(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let result = "";
    const bytes = crypto.randomBytes(16);
    for (let i = 0; i < 22; i++) {
      result += chars[bytes[i % 16] % chars.length];
    }
    return result;
  }

  /** Extract device ID from browser cookies. */
  private async resolveDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    const { browser } = await this.ensureBrowser();
    const cookies = await browser.cookies([this.pageUrl]);
    const utCookie = cookies.find((c) => c.name === "b-user-id");
    this.deviceId = utCookie?.value || "";
    return this.deviceId;
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
      // Match CN page first — Intl page (qwen.ai) has a file input with empty accept,
      // which doesn't work with this client's selectors.
      let qwenPage = pages.find((p) => p.url().includes("qianwen.com"))
        || pages.find((p) => p.url().includes("qwen.ai"));

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

    let _ok = 0, _fail = 0;
    for (const _c of cookies) {
      try { await this.browser.addCookies([_c]); _ok++; } catch { _fail++; }
    }
    if (_ok > 0 || _fail > 0) console.log('[Qwen Web Browser] cookies:', _ok, 'injected,', _fail, 'skipped');

    // Ensure the page is ready: Qwen CN creates the hidden file input
    // dynamically via "添加附件" → "上传图片" dropdown. Trigger it once
    // so the input exists for subsequent uploadFile() calls.
    await this.page.waitForTimeout(1000);
    const hasFileInput = await this.page.$('input[type="file"]');
    if (!hasFileInput) {
      const attachBtn = await this.page.$('[aria-label="添加附件"]');
      if (attachBtn) {
        await attachBtn.click();
        await this.page.waitForTimeout(600);
        await this.page.evaluate(() => {
          const items = [...document.querySelectorAll('[role="menuitem"]')];
          const uploadImg = items.find((el) => el.textContent?.includes("上传图片"));
          if (uploadImg) (uploadImg as HTMLElement).click();
        });
        await this.page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(() => {});
      }
    }

    return { browser: this.browser, page: this.page };
  }

  async init() {
    await this.ensureBrowser();
    await this.resolveDeviceId();
  }

  /**
   * Upload an image through the browser page's file input.
   * Reuses the main page (no extra pages) and clears uploaded images
   * from the chat input after each upload to prevent the 10-image limit.
   *
   * The oss_token→OSS→callback→file/record/add chain requires browser session
   * integrity, so we let the page's JS handle the upload flow and extract the
   * file/record/add response via CDP.
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    _mimeType: string,
  ): Promise<QwenFileMeta> {
    const { page } = await this.ensureBrowser();

    const ext = path.extname(fileName) || ".png";
    const tmpPath = path.join("/tmp", `qwen-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await fs.writeFile(tmpPath, fileBuffer);

    let cdpSession: any = null;
    try {
      cdpSession = await page.context().newCDPSession(page);
      await cdpSession.send("Network.enable");

      let resolveRecord: (data: { response: Record<string, unknown>; requestBody: Record<string, unknown> }) => void;
      const recordPromise = new Promise<{ response: Record<string, unknown>; requestBody: Record<string, unknown> }>((resolve) => {
        resolveRecord = resolve;
      });

      const requestBodyMap = new Map<string, Record<string, unknown>>();

      cdpSession.on(
        "Network.requestWillBeSent",
        (params: { requestId: string; request: { url: string; postData?: string } }) => {
          if (params.request.url.includes("file/record/add") && params.request.postData) {
            try { requestBodyMap.set(params.requestId, JSON.parse(params.request.postData)); } catch { /* ignore */ }
          }
        },
      );

      cdpSession.on(
        "Network.responseReceived",
        async (params: { response: { url: string; status: number }; requestId: string }) => {
          if (params.response.url.includes("file/record/add") && params.response.status === 200) {
            const reqBody = requestBodyMap.get(params.requestId);
            try {
              const body = (await cdpSession!.send("Network.getResponseBody", {
                requestId: params.requestId,
              })) as { body: string };
              const json = JSON.parse(body.body) as Record<string, unknown>;
              if (json?.data && reqBody) {
                resolveRecord({ response: json, requestBody: reqBody });
              }
            } catch { /* ignore */ }
          }
        },
      );

      // Qwen CN creates the hidden file input dynamically — it only exists after
      // clicking "添加附件" → "上传图片" in the Radix dropdown menu.
      let fileInput = await page.$(
        'input[type="file"][accept*=".png"], input[type="file"][accept*="image"]',
      );
      if (!fileInput) {
        const attachBtn = await page.$('[aria-label="添加附件"]');
        if (attachBtn) {
          await attachBtn.click();
          await page.waitForTimeout(600);
          await page.evaluate(() => {
            const items = [...document.querySelectorAll('[role="menuitem"]')];
            const uploadImg = items.find((el) => el.textContent?.includes("上传图片"));
            if (uploadImg) (uploadImg as HTMLElement).click();
          });
          await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 });
        }
        fileInput = await page.$(
          'input[type="file"][accept*=".png"], input[type="file"][accept*="image"]',
        );
      }
      if (!fileInput) {
        throw new Error("No image file input found on Qwen page");
      }

      await fileInput.setInputFiles(tmpPath);

      const timeoutMs = 60_000;
      const result = await Promise.race([
        recordPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("File upload timed out")), timeoutMs),
        ),
      ]);

      const data = result.response.data as Record<string, unknown>;
      if (!data?.fileUuid) {
        throw new Error(`No fileUuid in upload response: ${JSON.stringify(result.response)}`);
      }

      const reqBody = result.requestBody;
      const url =
        (reqBody.resourcePath as string) ||
        ((reqBody.resourceInfos as Array<{ url: string }>)?.[0]?.url) ||
        "";

      return {
        fileUuid: data.fileUuid as string,
        batchId: (data.batchId as string) || "",
        fileName,
        fileSize: fileBuffer.length,
        fileType: "image",
        url,
      };
    } finally {
      if (cdpSession) {
        await cdpSession.send("Network.disable").catch(() => {});
      }
      await fs.unlink(tmpPath).catch(() => {});
      // Clear uploaded images from the chat input to prevent 10-image limit
      await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
        if (input) input.value = "";
        document.querySelectorAll('[class*="close"], [class*="remove"], [class*="delete"]').forEach((el) => {
          (el as HTMLElement).click();
        });
      }).catch(() => {});
    }
  }

  async chatCompletions(params: {
    message: string;
    model?: string;
    signal?: AbortSignal;
    fileMetas?: QwenFileMeta[];
    sessionState?: QwenSessionState;
  }): Promise<ReadableStream<Uint8Array>> {
    const { browser } = await this.ensureBrowser();
    const deviceId = await this.resolveDeviceId();

    const model = params.model || "qwen3.5-plus";
    const fileMetas = params.fileMetas || [];
    const hasFiles = fileMetas.length > 0;

    // Restore persisted session state before generating a new one
    if (params.sessionState?.sessionId) {
      this.restoreSession(params.sessionState);
    }

    // Generate session state for new conversations
    const isFirstTurn = !this.sessionId;
    if (isFirstTurn) {
      this.sessionId = crypto.randomUUID().replace(/-/g, "");
      this.topicId = this.generateTopicId();
      this.lastReqId = "";
    }

    const reqId = crypto.randomUUID().replace(/-/g, "");
    const ts = Math.floor(Date.now() / 1000);
    const nonce = Math.random().toString(36).slice(2, 10);

    console.log(`[Qwen Web Browser] Sending (model: ${model}, session: ${this.sessionId.slice(0, 8)}..., files: ${fileMetas.length}, scene_param: ${isFirstTurn ? "first_turn" : "continue_chat"})`);

    // Build messages array
    const apiMessages: Array<Record<string, unknown>> = [];

    if (hasFiles) {
      apiMessages.push({
        mime_type: "image/url",
        content: "",
        meta_data: {
          resource_infos: fileMetas.map((f) => ({ url: f.url })),
        },
        status: "complete",
      });
    }

    // Send text message
    const textContent = params.message || (hasFiles ? "描述这张图片" : "");
    if (textContent) {
      apiMessages.push({
        mime_type: "text/plain",
        content: textContent,
        meta_data: { ori_query: textContent },
        status: "complete",
      });
    }

    const requestBody: Record<string, unknown> = {
      req_id: reqId,
      parent_req_id: this.lastReqId || "0",
      messages: apiMessages,
      scene: "chat",
      sub_scene: "",
      scene_param: isFirstTurn ? "first_turn" : "continue_chat",
      session_id: this.sessionId,
      biz_id: "ai_qwen",
      topic_id: this.topicId,
      model: "Qwen",
      from: "default",
      protocol_version: "v2",
      messages_merge: false,
      chat_client: "h5",
      deep_search: "0",
      temporary: false,
    };

    // Get cookies for API auth
    const cookies = await browser.cookies([this.apiBase, this.pageUrl]);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const url = `${this.apiBase}/api/v2/chat?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${deviceId}&wv=2.9.7&ve=2.9.7&nonce=${nonce}&timestamp=${ts}`;

    const fetchTimeoutMs = 300_000;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), fetchTimeoutMs);

    let msgRes: Response;
    try {
      msgRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const msg = String(err);
      if (msg.includes("aborted") || msg.includes("signal")) {
        throw new Error(`Qwen API request timed out after ${fetchTimeoutMs / 1000}s`);
      }
      throw err;
    }
    clearTimeout(timeout);

    if (!msgRes.ok) {
      if (msgRes.status === 401 || msgRes.status === 403) {
        throw new Error("Authentication failed. Please re-run onboarding to refresh your Qwen session.");
      }
      const errText = await msgRes.text().catch(() => "");
      throw new Error(`Qwen API error: ${msgRes.status} - ${errText.slice(0, 300)}`);
    }

    // Save reqId for next turn
    this.lastReqId = reqId;

    // Stream the response
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

  /** Reset session for a new conversation. */
  resetSession() {
    this.sessionId = "";
    this.topicId = "";
    this.lastReqId = "";
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
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 8192,
      },
    ] as ModelDefinitionConfig[];
  }
}
