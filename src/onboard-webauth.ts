/**
 * Zero Token — Web 模型授权向导
 *
 * 独立实现，不依赖 openclaw-zero-token 的 config/chrome 模块。
 * 使用 Playwright CDP 连接到已运行的 Chrome 调试实例，
 * 打开 LLM 平台页面，检测登录状态，自动提取凭证。
 */

import { chromium, type Browser, type Page } from "playwright-core";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import WebSocket from "ws";

// ── 类型 ──────────────────────────────────────────────

interface WebAuthResult {
  cookie: string;
  userAgent: string;
  bearer?: string;
  accessToken?: string;
  sessionKey?: string;
  sessionToken?: string;
  refreshToken?: string;
}

interface WebProvider {
  id: string;
  name: string;
  url: string;
  /** 检测已登录的 cookie 名称 */
  authCookieNames: string[];
  /** 额外需要提取的 cookie 名称 (可选) */
  extraCookieNames?: string[];
  /** localStorage key to check */
  localStorageCheck?: string;
  /** 授权前是否需要先清除该域名的 cookie（仅对有退登 bug 的平台启用） */
  clearCookiesBeforeAuth?: boolean;
}

// ── 提供商定义 ────────────────────────────────────────

const PROVIDERS: WebProvider[] = [
  {
    id: "deepseek-web",
    name: "DeepSeek",
    url: "https://chat.deepseek.com",
    // DeepSeek needs JWT token cookie, not just session cookies
    authCookieNames: ["token", "ds_session_id"],
    extraCookieNames: ["cf_clearance", "d_id", "HWSID"],
    // Also check localStorage for bearer token
    localStorageCheck: "bearerToken",
  },
  {
    id: "chatgpt-web",
    name: "ChatGPT",
    url: "https://chatgpt.com",
    authCookieNames: ["__Secure-next-auth.session-token", "__Secure-next-auth.session-token.0"],
    extraCookieNames: ["cf_clearance", "oai-did"],
  },
  {
    id: "claude-web",
    name: "Claude",
    url: "https://claude.ai",
    authCookieNames: ["sessionKey"],
    extraCookieNames: ["lastActiveOrg"],
  },
  {
    id: "gemini-web",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    authCookieNames: ["SID", "__Secure-1PSID", "COMPASS"],
  },
  {
    id: "grok-web",
    name: "Grok",
    url: "https://grok.com",
    authCookieNames: ["sso", "sso-rw"],
    extraCookieNames: ["_ga", "cf_clearance"],
  },
  {
    id: "kimi-web",
    name: "Kimi",
    url: "https://www.kimi.com",
    authCookieNames: ["access_token", "kimi-auth"],
    localStorageCheck: "access_token",
  },
  {
    id: "qwen-web",
    name: "Qwen",
    url: "https://www.qianwen.com/chat/",
    authCookieNames: ["tongyi_sso_ticket", "cna"],
    extraCookieNames: ["XSRF-TOKEN", "b-user-id"],
  },
  {
    id: "glm-web",
    name: "ChatGLM",
    url: "https://chatglm.cn",
    authCookieNames: ["chatglm_refresh_token", "chatglm_token"],
    extraCookieNames: ["chatglm_user_id"],
    clearCookiesBeforeAuth: true, // GLM cookie 过期后页面无法正常退出
  },
  {
    id: "doubao-web",
    name: "Doubao",
    url: "https://www.doubao.com/chat",
    authCookieNames: ["sessionid", "ttwid", "s_v_web_id"],
  },
  {
    id: "perplexity-web",
    name: "Perplexity",
    url: "https://www.perplexity.ai",
    authCookieNames: ["__Secure-next-auth.session-token", "next-auth.session-token"],
    extraCookieNames: ["intercom_session"],
  },
  {
    id: "xiaomimo-web",
    name: "Xiaomi MiMo",
    url: "https://xiaomi.moonshot.cn",
    authCookieNames: ["token", "session", "auth", "user"],
  },
  {
    id: "qwen-intl-web",
    name: "Qwen International",
    url: "https://chat.qwen.ai",
    authCookieNames: ["token", "atpsida"],
    extraCookieNames: ["XSRF-TOKEN", "b-user-id", "aui"],
  },
  {
    id: "glm-intl-web",
    name: "GLM International",
    url: "https://chatglm.ai",
    authCookieNames: ["chatglm_refresh_token", "refresh_token", "auth_token", "access_token", "token"],
  },
];

// ── 工具函数 ──────────────────────────────────────────

const STATE_DIR = new URL("../.myzt-state", import.meta.url).pathname;
const AUTH_FILE = path.join(STATE_DIR, "auth-profiles.json");

function ensureStateDir() {
  fs.mkdirSync(path.join(STATE_DIR, "agents", "main", "agent"), { recursive: true });
}

function loadAuthProfiles(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAuthProfiles(profiles: Record<string, unknown>) {
  ensureStateDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(profiles, null, 2), "utf-8");
}

async function connectChrome(): Promise<Browser> {
  const cdpUrl = "http://127.0.0.1:9222";
  // 获取 WebSocket URL
  let wsUrl: string | null = null;
  for (let i = 0; i < 10; i++) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
      wsUrl = data.webSocketDebuggerUrl ?? null;
      if (wsUrl) break;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) {
    throw new Error(`无法连接 Chrome 调试端口 ${cdpUrl}`);
  }
  return chromium.connectOverCDP(wsUrl);
}

async function getExistingPage(browser: Browser, urlPattern: string): Promise<Page | null> {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      if (page.url().includes(urlPattern)) {
        return page;
      }
    }
  }
  return null;
}

function buildCookieString(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ── CDP Cookie 清除 ───────────────────────────────────

/**
 * 通过 CDP 精确清除指定域名的 cookies 和 localStorage，
 * 用于解决过期 cookie 导致页面无法正常登录/退出的问题。
 * 只影响目标域名，不干扰其他网站。
 */
async function clearCookiesForProvider(
  provider: WebProvider,
  onProgress: (msg: string) => void,
): Promise<void> {
  const CDP_URL = "http://127.0.0.1:9222";
  const domain = new URL(provider.url).hostname;

  try {
    // 获取一个 page 级别的 WebSocket（Network.getCookies 需要 page target）
    const tabsResp = await fetch(`${CDP_URL}/json/list`);
    const tabs = (await tabsResp.json()) as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
    let pageWsUrl = tabs.find((t) => t.type === "page")?.webSocketDebuggerUrl;

    if (!pageWsUrl) {
      onProgress("  (无可用的 CDP page，跳过 cookie 清除)");
      return;
    }

    const ws = new WebSocket(pageWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 5000);
    });

    // 必须先启用 Network domain 才能调用 Network 方法
    let msgId = 0;
    const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      return new Promise((resolve) => {
        const id = ++msgId;
        ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await send("Network.enable");

    // 清除主域名 + www 子域名的 cookies
    const targets = [domain, `www.${domain.replace(/^www\./, "")}`];
    let totalCookies = 0;

    for (const target of targets) {
      try {
        const { result } = (await send("Network.getCookies", {
          urls: [`https://${target}/`],
        })) as { result?: { cookies: Array<{ name: string; domain: string }> } };

        const cookies = result?.cookies ?? [];
        if (cookies.length > 0) {
          for (const c of cookies) {
            await send("Network.deleteCookies", {
              name: c.name,
              domain: c.domain,
              url: `https://${target}/`,
            });
          }
          totalCookies += cookies.length;
        }
      } catch {
        // 域名可能不可达
      }
    }

    // 清除 localStorage / sessionStorage
    try {
      await send("Storage.clearDataForOrigin", {
        origin: `https://${domain}`,
        storageTypes: "all",
      });
    } catch {
      // ignore
    }

    ws.close();

    if (totalCookies > 0) {
      onProgress(`✓ 已清除 ${domain} 的 ${totalCookies} 个 cookies + localStorage`);
    }
  } catch (err) {
    onProgress(`  (cookie 清除失败: ${err instanceof Error ? err.message : String(err)})`);
  }
}

// ── 主流程 ────────────────────────────────────────────

async function authProvider(
  provider: WebProvider,
  onProgress: (msg: string) => void,
): Promise<WebAuthResult | null> {
  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  onProgress("连接浏览器...");
  const browser = await connectChrome();
  const context = browser.contexts()[0];

  try {
    // 仅对有退登 bug 的平台（如 GLM）清除过期 cookie
    if (provider.clearCookiesBeforeAuth) {
      await clearCookiesForProvider(provider, onProgress);
    }

    // 先检查是否已经打开该页面
    const domain = new URL(provider.url).hostname.replace("www.", "");
    const existingPage = await getExistingPage(browser, domain);

    let page: Page;
    if (existingPage) {
      onProgress(`找到已打开的页面: ${existingPage.url()}`);
      page = existingPage;
      // 如果页面停留时间较长，刷新一下以更新 cookie
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    } else {
      onProgress(`打开: ${provider.url}`);
      page = await context.newPage();
      await page.goto(provider.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    // 检测是否已登录 - 更严格的检查
    onProgress("检测登录状态...");
    let loggedIn = false;
    let authReason = "";

    // 检查 1: 查找 JWT/认证 token cookie
    const existingCookies = await context.cookies(page.url());
    const authCookiesFound = existingCookies.filter((c) =>
      provider.authCookieNames.some((name) => c.name === name),
    );

    // 对于 DeepSeek，检查 localStorage 中的 userToken
    if (provider.id === "deepseek-web") {
      try {
        const userTokenRaw = await page.evaluate(() => localStorage.getItem("userToken"));
        if (userTokenRaw) {
          const parsed = JSON.parse(userTokenRaw);
          if (parsed.value) {
            loggedIn = true;
            authReason = "✓ 已登录 (userToken)";
          }
        }
      } catch { /* ignore */ }
    }
    if (!loggedIn && authCookiesFound.length > 0) {
      loggedIn = true;
      authReason = `✓ 已登录 (检测到: ${authCookiesFound.map((c) => c.name).join(", ")})`;
    }

    // 检查 2: localStorage
    if (!loggedIn && provider.localStorageCheck) {
      try {
        const val = await page.evaluate(
          (key: string) => localStorage.getItem(key),
          provider.localStorageCheck,
        );
        if (val) {
          loggedIn = true;
          authReason = `✓ 已登录 (localStorage: ${provider.localStorageCheck})`;
        }
      } catch {
        // ignore
      }
    }

    if (loggedIn) {
      onProgress(authReason);
    } else {
      const foundList = authCookiesFound.length > 0
        ? ` (仅找到: ${authCookiesFound.map((c) => c.name).join(", ")})`
        : "";
      onProgress(`⚠ 未登录${foundList}`);
      onProgress(`请在 Chrome 中登录 ${provider.url}，程序将自动检测...`);
      onProgress("(不要关闭此终端，等待自动检测)");
    }

    // 轮询等待登录 (最多 5 分钟)
    if (!loggedIn) {
      const startTime = Date.now();
      const timeout = 300_000;
      while (Date.now() - startTime < timeout) {
        const cookies = await context.cookies(page.url());
        const found = cookies.some((c) =>
          provider.authCookieNames.some((name) => c.name === name),
        );

        // DeepSeek 特殊: 检查 localStorage 中的 userToken
        if (provider.id === "deepseek-web") {
          try {
            const userTokenRaw = await page.evaluate(() => localStorage.getItem("userToken"));
            if (userTokenRaw) {
              const parsed = JSON.parse(userTokenRaw);
              if (parsed.value) {
                onProgress("✓ 检测到 DeepSeek 登录 (userToken)!");
                loggedIn = true;
                break;
              }
            }
          } catch {
            // ignore
          }
        }
        if (found) {
          onProgress("✓ 检测到登录!");
          loggedIn = true;
          break;
        }

        if (provider.localStorageCheck) {
          try {
            const val = await page.evaluate(
              (key: string) => localStorage.getItem(key),
              provider.localStorageCheck,
            );
            if (val) {
              onProgress("✓ 检测到登录 (localStorage)!");
              loggedIn = true;
              break;
            }
          } catch {
            // ignore
          }
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      if (!loggedIn) {
        onProgress("✗ 登录超时 (5 分钟)");
        return null;
      }
    }

    // 提取凭证
    onProgress("提取凭证...");
    const allCookies = await context.cookies(page.url());

    // 也尝试从页面 JavaScript 获取 localStorage token
    let bearerToken = "";
    try {
      bearerToken = await page.evaluate(() => {
        // DeepSeek: userToken is JSON { value: "token" }
        for (const key of ["userToken", "access_token", "bearerToken", "token", "sessionKey"]) {
          const val = localStorage.getItem(key);
          if (!val) continue;
          if (key === "userToken") {
            try {
              const parsed = JSON.parse(val);
              if (parsed.value) return parsed.value;
            } catch { return val; }
          }
          return val;
        }
        return "";
      });
    } catch {
      // ignore
    }

    const cookie = buildCookieString(allCookies);

    const result: WebAuthResult = { cookie, userAgent };

    if (bearerToken) {
      result.bearer = bearerToken;
      result.accessToken = bearerToken;
    }

    // 提取特定 cookie 值
    for (const c of allCookies) {
      if (c.name === "sessionKey" && c.value.startsWith("sk-ant-sid")) {
        result.sessionKey = c.value;
      }
      if (c.name === "__Secure-next-auth.session-token") {
        result.sessionToken = c.value;
      }
      if (c.name === "access_token") {
        result.accessToken = c.value;
      }
    }

    onProgress(`✓ 成功获取凭证 (${cookie.length} 字符)`);
    return result;
  } finally {
    // 清理: 只关闭我们打开的新页面，不关闭浏览器
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
}

// ── CLI 交互 ──────────────────────────────────────────

async function main() {
  console.log("==========================================");
  console.log("  Zero Token — Web 模型授权向导");
  console.log("==========================================");
  console.log("");

  // 检查 Chrome
  try {
    const resp = await fetch("http://127.0.0.1:9222/json/version");
    if (!resp.ok) throw new Error("not ok");
    console.log("✓ Chrome 调试模式已启动");
  } catch {
    console.log("✗ Chrome 未在调试模式");
    console.log("请先运行: ./start-chrome-debug.sh");
    process.exit(1);
  }

  // 显示已授权的模型
  const profiles = loadAuthProfiles();
  const authorizedKeys = Object.keys(profiles);
  if (authorizedKeys.length > 0) {
    console.log("\n已授权:");
    for (const key of authorizedKeys) {
      console.log(`  ✓ ${key}`);
    }
  }

  console.log("\n请选择要授权的模型 (多个用逗号分隔):\n");
  for (let i = 0; i < PROVIDERS.length; i++) {
    const p = PROVIDERS[i];
    const mark = authorizedKeys.some((k) => k.includes(p.id)) ? " ✓ 已授权" : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(20)} ${p.url}${mark}`);
  }
  console.log("\n   0. 退出");
  console.log("   a. 授权所有");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("\n选择: ", resolve);
  });
  rl.close();

  if (answer === "0" || answer === "") {
    console.log("已取消");
    process.exit(0);
  }

  let selectedProviders: WebProvider[];
  if (answer.toLowerCase() === "a") {
    selectedProviders = [...PROVIDERS];
  } else {
    const indices = answer
      .split(",")
      .map((s) => s.trim())
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= PROVIDERS.length);
    selectedProviders = indices.map((i) => PROVIDERS[i - 1]);
  }

  if (selectedProviders.length === 0) {
    console.log("无效选择");
    process.exit(1);
  }

  console.log(`\n将授权 ${selectedProviders.length} 个模型:`);
  for (const p of selectedProviders) {
    console.log(`  - ${p.name}`);
  }
  console.log("");

  const results: Record<string, unknown> = { ...profiles };

  for (const provider of selectedProviders) {
    console.log(`\n━━━ ${provider.name} ━━━`);
    try {
      const result = await authProvider(provider, (msg: string) => {
        console.log(`  > ${msg}`);
      });

      if (result) {
        const profileId = `${provider.id}:default`;
        results[profileId] = {
          type: "token",
          provider: provider.id,
          token: JSON.stringify(result),
        };
        console.log(`  ✓ ${provider.name} 授权成功`);
      } else {
        console.log(`  ✗ ${provider.name} 授权失败`);
      }
    } catch (err) {
      console.log(`  ✗ ${provider.name} 错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 保存
  saveAuthProfiles(results);
  console.log(`\n✓ 已保存到 ${AUTH_FILE}`);

  // 显示摘要
  const updated = loadAuthProfiles();
  console.log(`\n已授权 ${Object.keys(updated).length} 个模型`);

  console.log("\n==========================================");
  console.log("  下一步");
  console.log("==========================================");
  console.log("");
  console.log("1. 确保网关运行: ./server.sh start");
  console.log("2. 打开测试页面: http://127.0.0.1:3001");
  console.log("3. Cookie 将自动从已保存的凭证中加载");
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
