/**
 * Chrome helpers — standalone replacement (attach-only, no openclaw deps).
 */

export interface RunningChrome {
  pid: number;
  cdpPort: number;
}

/** Fetch WebSocket debugger URL from a running Chrome CDP endpoint. */
export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 2000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Stub: never launch Chrome in standalone mode. */
export function launchOpenClawChrome(): never {
  throw new Error("Chrome launch not supported — use attach mode (./start-chrome-debug.sh)");
}

/** Stub: never stop Chrome in standalone mode. */
export function stopOpenClawChrome(): void {
  // no-op
}
