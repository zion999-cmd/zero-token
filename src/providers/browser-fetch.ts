/**
 * Browser Fetch — 通过 Chrome CDP 在浏览器上下文中执行 fetch()。
 * 绕过 Cloudflare 等反爬保护，使用浏览器的 cookie jar 和 TLS 指纹。
 */
import { chromium, type Browser, type Page } from "playwright-core";

const CDP_URL = "http://127.0.0.1:9222";

export interface BrowserFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 该 API 请求应该从哪个域名发起 (Referer/Origin) */
  referer?: string;
}

let browserCache: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserCache?.isConnected()) return browserCache;
  let wsUrl: string | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await fetch(`${CDP_URL}/json/version`);
      const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
      wsUrl = data.webSocketDebuggerUrl ?? null;
      if (wsUrl) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) throw new Error("Cannot connect to Chrome CDP");
  browserCache = await chromium.connectOverCDP(wsUrl);
  return browserCache;
}

/** Get or create a page on a specific domain */
async function getPage(browser: Browser, domain: string): Promise<Page> {
  const ctx = browser.contexts()[0];
  // Try to find an existing page on this domain
  for (const page of ctx.pages()) {
    if (page.url().includes(domain)) return page;
  }
  // Create a new page
  const page = await ctx.newPage();
  await page.goto(`https://${domain}`, { waitUntil: "domcontentloaded", timeout: 15000 });
  return page;
}

/**
 * Execute a fetch() call from inside a browser page context.
 * Returns the response body as text.
 */
export async function browserFetch(options: BrowserFetchOptions): Promise<string> {
  const domain = new URL(options.url).hostname;
  const browser = await getBrowser();
  const page = await getPage(browser, domain);

  return page.evaluate(async (opts) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "*/*",
      ...(opts.headers || {}),
    };
    if (opts.referer) {
      headers["Referer"] = opts.referer;
      headers["Origin"] = new URL(opts.referer).origin;
    }

    const resp = await fetch(opts.url, {
      method: opts.method || "GET",
      headers,
      body: opts.body || undefined,
    });

    return resp.text();
  }, options);
}

/**
 * Execute a fetch() from browser and stream the SSE response back.
 * Returns an async generator that yields SSE data lines.
 */
export async function* browserFetchStream(
  options: BrowserFetchOptions,
): AsyncGenerator<string> {
  const domain = new URL(options.url).hostname;
  const browser = await getBrowser();
  const page = await getPage(browser, domain);

  // We use a different approach: inject a ReadableStream reader proxy
  // The browser evaluates JS that returns chunks through a callback mechanism
  const streamPromise = page.evaluate(async (opts) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(opts.headers || {}),
    };
    if (opts.referer) {
      headers["Referer"] = opts.referer;
      headers["Origin"] = new URL(opts.referer).origin;
    }

    const resp = await fetch(opts.url, {
      method: opts.method || "POST",
      headers,
      body: opts.body || undefined,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: true, status: resp.status, body: errText };
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush remaining
    return { error: false, status: resp.status, chunks };
  }, options);

  const result = await streamPromise;

  if (result.error) {
    throw new Error(`Browser fetch failed: ${result.status} - ${result.body?.substring(0, 200)}`);
  }

  // Yield each SSE line
  let buffer = "";
  for (const chunk of result.chunks || []) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        yield line;
      }
    }
  }
}
