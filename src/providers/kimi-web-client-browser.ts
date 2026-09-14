import * as fs from "node:fs/promises";
import * as os from "node:os";
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

export interface KimiFileMeta {
  fileId: string;
}

export interface KimiWebClientOptions {
  cookie?: string;
  accessToken?: string;
  refreshToken?: string;
  userAgent?: string;
}

/**
 * Kimi Web Client using CDP attach
 * 使用 Connect RPC 纯 API（/apiv2/kimi.gateway.chat.v1.ChatService/Chat），kimi-auth 从 Cookie 提取
 */
export class KimiWebClientBrowser {
  private cookie: string;
  private accessToken: string;
  private refreshToken: string;
  private userAgent: string;
  private baseUrl = "https://www.kimi.com";
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private running: RunningChrome | null = null;
  private conversationId: string | null = null;
  get currentConversationId(): string | null { return this.conversationId; }

  constructor(options: KimiWebClientOptions | string) {
    if (typeof options === "string") {
      try {
        const parsed = JSON.parse(options) as KimiWebClientOptions;
        this.cookie = parsed.cookie || "";
        this.accessToken = parsed.accessToken || "";
        this.refreshToken = parsed.refreshToken || "";
        this.userAgent = parsed.userAgent || "Mozilla/5.0";
      } catch {
        this.cookie = options;
        this.accessToken = "";
        this.refreshToken = "";
        this.userAgent = "Mozilla/5.0";
      }
    } else {
      this.cookie = options.cookie || "";
      this.accessToken = options.accessToken || "";
      this.refreshToken = options.refreshToken || "";
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
          `Failed to connect to Chrome at ${profile.cdpUrl}. Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }

      this.browser = (
        await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
      ).contexts()[0]!;

      const pages = this.browser.pages();
      let kimiPage = pages.find(
        (p) => p.url().includes("kimi.com") || p.url().includes("moonshot.cn"),
      );
      if (kimiPage) {
        this.page = kimiPage;
      } else {
        this.page = await this.browser.newPage();
        await this.page.goto(`${this.baseUrl}/`, { waitUntil: "domcontentloaded" });
      }
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
        await chromium.connectOverCDP(wsUrl, { headers: getHeadersWithAuth(wsUrl) })
      ).contexts()[0]!;
      this.page = this.browser.pages()[0] || (await this.browser.newPage());
    }

    if (this.cookie.trim()) {
      const pageUrl = this.page?.url() ?? this.baseUrl;
      const domain = pageUrl.includes("moonshot.cn") ? ".moonshot.cn" : ".kimi.com";

      const rawCookies = this.cookie.split(";").map((c) => {
        const [name, ...valueParts] = c.trim().split("=");
        const nameStr = name?.trim() ?? "";
        const valueStr = valueParts.join("=").trim();
        if (!nameStr) {
          return null;
        }
        const cookie: {
          name: string;
          value: string;
          domain: string;
          path: string;
          secure?: boolean;
        } = {
          name: nameStr,
          value: valueStr,
          domain,
          path: "/",
        };
        if (nameStr.startsWith("__Secure-") || nameStr.startsWith("__Host-")) {
          cookie.secure = true;
        }
        return cookie;
      });
      const cookies = rawCookies.filter((c): c is NonNullable<typeof c> => c !== null);
      if (cookies.length > 0) {
        let _ok = 0, _fail = 0;
        for (const _c of cookies) {
          try { await this.browser.addCookies([_c]); _ok++; } catch { _fail++; }
        }
        if (_ok > 0 || _fail > 0) console.log('[Kimi Web] cookies:', _ok, 'injected,', _fail, 'skipped');
      }
    }

    return { browser: this.browser, page: this.page };
  }

  /** Decode a JWT's exp (unix seconds); 0 when the token is not a parseable JWT. */
  private jwtExp(token: string): number {
    try {
      const payload = token.split(".")[1];
      if (!payload) return 0;
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: unknown };
      return typeof claims.exp === "number" ? claims.exp : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Resolve a usable access token at call time.
   *
   * kimi.com keeps a SHORT-LIVED (~15 min) access_token plus a long-lived
   * refresh_token in localStorage; a token captured at onboard time expires
   * within days and must not be preferred over the live browser session.
   */
  private async resolveAccessToken(): Promise<string> {
    const { page, browser } = await this.ensureBrowser();
    const skewMs = 60_000;
    const isValid = (token: string): boolean => {
      if (!token) return false;
      const exp = this.jwtExp(token);
      return exp === 0 || exp * 1000 > Date.now() + skewMs;
    };

    const stored = await page.evaluate(() => ({
      access: localStorage.getItem("access_token") || "",
      refresh: localStorage.getItem("refresh_token") || "",
    }));

    if (isValid(stored.access)) {
      return stored.access;
    }

    if (stored.refresh) {
      // The site rotates tokens via the auth.kimi.com Connect RPC gateway;
      // call it from the page (CORS + site cookies apply automatically).
      const fresh = await page.evaluate(
        async (refreshToken: string) => {
          try {
            const r = await fetch(
              "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refresh_token: refreshToken }),
              },
            );
            if (!r.ok) return "";
            // Response is camelCase: { accessToken, refreshToken }
            const d = (await r.json()) as {
              accessToken?: string;
              refreshToken?: string;
            };
            if (d.accessToken) localStorage.setItem("access_token", d.accessToken);
            if (d.refreshToken) localStorage.setItem("refresh_token", d.refreshToken);
            return d.accessToken || "";
          } catch {
            return "";
          }
        },
        stored.refresh,
      );
      if (isValid(fresh)) {
        console.log("[Kimi Web] access_token refreshed via refresh_token");
        return fresh;
      }
    }

    if (isValid(this.accessToken)) {
      return this.accessToken;
    }

    const cookies = await browser.cookies([this.baseUrl]);
    const cookieToken = cookies.find((c) => c.name === "kimi-auth")?.value || "";
    if (isValid(cookieToken)) {
      return cookieToken;
    }

    throw new Error(
      "Kimi: 登录态已过期且无法自动刷新，请在浏览器中重新登录 kimi.com（或运行 ./onboard.sh）。",
    );
  }

  async init() {
    await this.ensureBrowser();
  }

  /**
   * Upload a file to Kimi via multipart/form-data.
   * Returns the file ID for use in chat completions.
   */
  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<KimiFileMeta> {
    const { browser } = await this.ensureBrowser();

    const cookies = await browser.cookies([this.baseUrl]);
    const authToken = await this.resolveAccessToken();

    const cookieHeader = cookies
      .filter((c) => c.domain.includes("kimi.com") || c.domain.includes("moonshot.cn"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    // Build multipart/form-data body
    const boundary = "----KimiUpload" + Date.now();
    const ext = path.extname(fileName) || ".png";
    const tmpPath = path.join(os.tmpdir(), `kimi-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await fs.writeFile(tmpPath, fileBuffer);

    try {
      const fileBytes = await fs.readFile(tmpPath);
      const header = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
        `Content-Type: ${mimeType}`,
        "",
        "",
      ].join("\r\n");
      const footer = `\r\n--${boundary}--\r\n`;

      const headerBytes = new TextEncoder().encode(header);
      const footerBytes = new TextEncoder().encode(footer);
      const body = new Uint8Array(headerBytes.length + fileBytes.length + footerBytes.length);
      body.set(headerBytes, 0);
      body.set(fileBytes, headerBytes.length);
      body.set(footerBytes, headerBytes.length + fileBytes.length);

      const res = await fetch(`${this.baseUrl}/apiv2-files/file/upload`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          Authorization: `Bearer ${authToken}`,
          "X-Language": "zh-CN",
          "X-Msh-Platform": "web",
          Origin: this.baseUrl,
          Referer: `${this.baseUrl}/`,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Kimi file upload failed: ${res.status} - ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as { file?: { id?: string } };
      const fileId = json.file?.id;
      if (!fileId) throw new Error(`Kimi upload: no file id in response`);

      // Wait for file parse to complete (images are fast, ~2-5s)
      await new Promise((r) => setTimeout(r, 5000));

      return { fileId };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    signal?: AbortSignal;
    fileMetas?: KimiFileMeta[];
  }): Promise<ReadableStream<Uint8Array>> {
    const { browser } = await this.ensureBrowser();

    const cookies = await browser.cookies([this.baseUrl]);
    // Live token from page localStorage (auto-refreshed) — see resolveAccessToken.
    const authToken = await this.resolveAccessToken();

    // Build full cookie string from browser context to pass in Node.js fetch
    const cookieHeader = cookies
      .filter((c) => c.domain.includes("kimi.com") || c.domain.includes("moonshot.cn"))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const fileMetas = params.fileMetas || [];
    const hasFiles = fileMetas.length > 0;

    const scenario = params.model.includes("search")
      ? "SCENARIO_SEARCH"
      : params.model.includes("research")
        ? "SCENARIO_RESEARCH"
        : params.model.includes("k1")
          ? "SCENARIO_K1"
          : hasFiles
            ? "SCENARIO_K2D5"
            : "SCENARIO_K2";

    // Build message blocks
    const blocks: Array<Record<string, unknown>> = [];
    if (params.message) {
      blocks.push({ message_id: "", text: { content: params.message } });
    }
    for (const f of fileMetas) {
      blocks.push({ file: { id: f.fileId, status: "PROCESS_STATUS_SUCCESS" } });
    }

    // Build ConnectRPC framed request body (5-byte header + JSON)
    const req: Record<string, unknown> = {
      scenario,
      tools: hasFiles ? [{ type: "TOOL_TYPE_SEARCH", search: {} }] : [],
      message: {
        role: "user" as const,
        blocks,
        scenario,
      },
      options: { thinking: false },
    };
    // Pass conversation/chat ID to continue an existing session
    if (params.conversationId) {
      req.chat_id = params.conversationId;
    }
    const enc = new TextEncoder().encode(JSON.stringify(req));
    const frameBuf = new Uint8Array(5 + enc.byteLength);
    const dv = new DataView(frameBuf.buffer);
    dv.setUint8(0, 0x00);
    dv.setUint32(1, enc.byteLength, false);
    frameBuf.set(enc, 5);

    // Make the request directly from Node.js (not page.evaluate) so we get real
    // streaming without any Playwright timeout constraints.
    const res = await fetch(`${this.baseUrl}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        Accept: "*/*",
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/`,
        "X-Language": "zh-CN",
        "X-Msh-Platform": "web",
        Authorization: `Bearer ${authToken}`,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: frameBuf,
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kimi API 错误 ${res.status}: ${text.slice(0, 400)}`);
    }

    const encoder = new TextEncoder();
    const responseBody = res.body!;

    // Capture chat_id from response for session reuse
    const self = this;
    let capturedChatId: string | undefined;

    // Parse ConnectRPC frames incrementally and emit SSE-style data chunks.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = responseBody.getReader();
        let leftover = new Uint8Array(0);
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Append new bytes to leftover
            const combined = new Uint8Array(leftover.length + value.length);
            combined.set(leftover);
            combined.set(value, leftover.length);
            leftover = combined;

            // Parse as many complete frames as possible
            let offset = 0;
            while (offset + 5 <= leftover.length) {
              const frameLen = new DataView(
                leftover.buffer,
                leftover.byteOffset + offset + 1,
                4,
              ).getUint32(0, false);
              if (offset + 5 + frameLen > leftover.length) break;

              const frameBytes = leftover.slice(offset + 5, offset + 5 + frameLen);
              offset += 5 + frameLen;

              try {
                const obj = JSON.parse(decoder.decode(frameBytes));
                // Capture chat_id for session persistence
                if (obj.chat_id && !capturedChatId) {
                  capturedChatId = obj.chat_id as string;
                  this.conversationId = capturedChatId;
                  console.log(`[KimiWebClient] Captured chat_id: ${capturedChatId}`);
                }
                // Capture chat.id for session persistence
                if (obj.chat?.id && !capturedChatId) {
                  capturedChatId = obj.chat.id as string;
                  self.conversationId = capturedChatId;
                }
                if (obj.error) {
                  const errMsg =
                    obj.error.message ||
                    obj.error.code ||
                    JSON.stringify(obj.error).slice(0, 200);
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`),
                  );
                  break;
                }

                const op: string = obj.op || "";
                let text: string | undefined;

                if (obj.block?.text?.content && (op === "append" || op === "set")) {
                  text = obj.block.text.content as string;
                } else if (obj.text?.content && (op === "append" || op === "set")) {
                  text = obj.text.content as string;
                } else if (!op && obj.message?.role === "assistant" && obj.message?.blocks) {
                  text = (obj.message.blocks as Array<{ text?: { content?: string } }>)
                    .map((b) => b.text?.content || "")
                    .join("");
                }

                if (text) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text })}\n\n`),
                  );
                }

                if (obj.done) break;
              } catch {
                // ignore malformed JSON frames
              }
            }

            leftover = leftover.slice(offset);
          }
        } catch (err) {
          console.error("[KimiWebClient] Stream read error:", err);
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
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
        id: "moonshot-v1-32k",
        name: "Moonshot v1 32K",
        api: "kimi-web",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ] as ModelDefinitionConfig[];
  }
}
