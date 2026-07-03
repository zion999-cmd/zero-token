import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { getHeadersWithAuth } from "../../../extensions/browser/src/browser/cdp.helpers.js";
import { getChromeWebSocketUrl, launchOpenClawChrome } from "../../../extensions/browser/src/browser/chrome.js";
import { resolveBrowserConfig, resolveProfile } from "../../../extensions/browser/src/browser/config.js";
import { loadConfig } from "../../config/io.js";

export interface ZWebClientOptions {
  cookie: string;
  userAgent: string;
  headless?: boolean;
}

/** Model ID -> ChatGLM assistant_id mapping */
const ASSISTANT_ID_MAP: Record<string, string> = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

const X_EXP_GROUPS =
  "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a," +
  "na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a," +
  "desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4," +
  "app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add," +
  "mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A," +
  "homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A," +
  "memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user," +
  "app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5," +
  "ai_wallet:exp:ai_wallet_enable";

/** Generate X-Sign, X-Nonce, X-Timestamp headers required by chatglm.cn */
function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split("").map((c) => Number(c));
  const i = o.reduce((acc, v) => acc + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto
    .createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`)
    .digest("hex");
  return { timestamp, nonce, sign };
}

export class ZWebClientBrowser {
  private options: ZWebClientOptions;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;
  private accessToken: string | null = null;
  private deviceId = crypto.randomUUID().replace(/-/g, "");

  constructor(options: ZWebClientOptions) {
    this.options = options;
  }

  private parseCookies(): Array<{ name: string; value: string; domain: string; path: string }> {
    return this.options.cookie
      .split(";")
      .filter((c) => c.trim().includes("="))
      .map((cookie) => {
        const [name, ...valueParts] = cookie.trim().split("=");
        return {
          name: name?.trim() ?? "",
          value: valueParts.join("=").trim(),
          domain: ".chatglm.cn",
          path: "/",
        };
      })
      .filter((c) => c.name.length > 0);
  }

  private getRefreshToken(): string | null {
    const cookies = this.parseCookies();
    const refreshCookie = cookies.find((c) => c.name === "chatglm_refresh_token");
    return refreshCookie?.value ?? null;
  }

  private getAccessTokenFromCookie(): string | null {
    const cookies = this.parseCookies();
    const tokenCookie = cookies.find((c) => c.name === "chatglm_token");
    return tokenCookie?.value ?? null;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootConfig = loadConfig();
    const browserConfig = resolveBrowserConfig(rootConfig.browser, rootConfig);
    const profile = resolveProfile(browserConfig, browserConfig.defaultProfile);
    if (!profile) {
      throw new Error(`Could not resolve browser profile '${browserConfig.defaultProfile}'`);
    }

    let wsUrl: string | null = null;

    if (browserConfig.attachOnly) {
      console.log(`[Z Web Browser] Connecting to existing Chrome at ${profile.cdpUrl}`);
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
            `Make sure Chrome is running in debug mode (./start-chrome-debug.sh)`,
        );
      }
    } else {
      const running = await launchOpenClawChrome(browserConfig, profile);
      const cdpUrl = `http://127.0.0.1:${running.cdpPort}`;
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
    }

    const connectedBrowser = await chromium.connectOverCDP(wsUrl, {
      headers: getHeadersWithAuth(wsUrl),
    });
    this.browser = connectedBrowser;
    this.context = connectedBrowser.contexts()[0];

    const pages = this.context.pages();
    const zPage = pages.find((p) => p.url().includes("chatglm.cn"));
    if (zPage) {
      console.log(`[Z Web Browser] Found existing ChatGLM page`);
      this.page = zPage;
    } else {
      this.page = await this.context.newPage();
      await this.page.goto("https://chatglm.cn", { waitUntil: "domcontentloaded" });
    }

    const cookies = this.parseCookies();
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch (e) {
        console.warn("[Z Web Browser] Failed to add some cookies:", e);
      }
    }

    await this.refreshAccessToken();

    this.initialized = true;
  }

  private async refreshAccessToken(): Promise<void> {
    const cookieToken = this.getAccessTokenFromCookie();
    if (cookieToken) {
      this.accessToken = cookieToken;
      console.log("[Z Web Browser] Using chatglm_token from cookies");
      return;
    }

    // Also try to get token from browser cookies
    if (this.context) {
      try {
        const browserCookies = await this.context.cookies(["https://chatglm.cn"]);
        const browserToken = browserCookies.find((c) => c.name === "chatglm_token");
        if (browserToken?.value) {
          this.accessToken = browserToken.value;
          console.log("[Z Web Browser] Using chatglm_token from browser cookies");
          return;
        }
      } catch {
        // ignore
      }
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken || !this.page) {
      console.warn("[Z Web Browser] No chatglm_token found, will rely on browser cookies for auth");
      return;
    }

    console.log("[Z Web Browser] Refreshing access token via API...");
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const result = await this.page.evaluate(
      async ({ refreshToken, deviceId, requestId, sign }) => {
        try {
          const res = await fetch("https://chatglm.cn/chatglm/user-api/user/refresh", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${refreshToken}`,
              "App-Name": "chatglm",
              "X-App-Platform": "pc",
              "X-App-Version": "0.0.1",
              "X-Device-Id": deviceId,
              "X-Request-Id": requestId,
              "X-Sign": sign.sign,
              "X-Nonce": sign.nonce,
              "X-Timestamp": sign.timestamp,
            },
            credentials: "include",
            body: JSON.stringify({}),
          });

          if (!res.ok) {
            return { ok: false, status: res.status, error: await res.text() };
          }

          const data = await res.json();
          const accessToken =
            data?.result?.access_token ?? data?.result?.accessToken ?? data?.accessToken;
          if (!accessToken) {
            return {
              ok: false,
              status: 200,
              error: `No accessToken in response: ${JSON.stringify(data).substring(0, 300)}`,
            };
          }
          return { ok: true, accessToken };
        } catch (err) {
          return { ok: false, status: 500, error: String(err) };
        }
      },
      { refreshToken, deviceId: this.deviceId, requestId, sign },
    );

    if (result.ok && result.accessToken) {
      this.accessToken = result.accessToken;
      console.log("[Z Web Browser] Access token refreshed successfully");
    } else {
      console.warn(`[Z Web Browser] Failed to refresh access token: ${result.error}`);
    }
  }

  async chatCompletions(params: {
    conversationId?: string;
    message: string;
    model: string;
    imageUrls?: string[];
    signal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array>> {
    if (!this.page) {
      throw new Error("ZWebClientBrowser not initialized");
    }

    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const { conversationId, message, model, imageUrls } = params;
    const assistantId = ASSISTANT_ID_MAP[model] ?? DEFAULT_ASSISTANT_ID;

    console.log(`[Z Web Browser] Sending request... model=${model} assistantId=${assistantId} images=${imageUrls?.length || 0}`);

    // 构建 content 数组：文本 + 图片
    const contentParts: Array<Record<string, unknown>> = [
      { type: "text", text: message },
    ];
    if (imageUrls && imageUrls.length > 0) {
      for (const url of imageUrls) {
        contentParts.push({
          type: "image_url",
          image_url: { url },
        });
      }
    }

    const fetchTimeoutMs = 120_000;
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

    const body = {
      assistant_id: assistantId,
      conversation_id: conversationId || "",
      project_id: "",
      chat_type: "user_chat",
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: "xxxx",
        channel: "",
        draft_id: "",
        chat_mode: "zero",
        is_networking: false,
        quote_log_id: "",
        platform: "pc",
      },
      messages: [
        {
          role: "user",
          content: contentParts,
        },
      ],
    };

    // Use Node.js fetch instead of page.evaluate to avoid
    // "Execution context was destroyed" errors on page navigation.
    const bodyStr = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "App-Name": "chatglm",
      Origin: "https://chatglm.cn",
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-App-fr": "default",
      "X-Device-Id": this.deviceId,
      "X-Exp-Groups": X_EXP_GROUPS,
      "X-Lang": "zh",
      "X-Nonce": sign.nonce,
      "X-Request-Id": requestId,
      "X-Sign": sign.sign,
      "X-Timestamp": sign.timestamp,
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);

    let res: Response;
    try {
      res = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/stream", {
        method: "POST",
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = String(err);
      if (msg.includes("aborted") || msg.includes("signal")) {
        throw new Error(`ChatGLM API request timed out after ${fetchTimeoutMs / 1000}s`);
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      if (res.status === 401) {
        console.log("[Z Web Browser] Access token expired, refreshing...");
        await this.refreshAccessToken();
        throw new Error("Authentication expired. Token has been refreshed, please retry.");
      }
      const errorText = await res.text().catch(() => "");
      throw new Error(`ChatGLM API error: ${res.status} - ${errorText.slice(0, 300)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("ChatGLM API returned empty response body");
    }

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

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.initialized = false;
    this.accessToken = null;
  }
}
