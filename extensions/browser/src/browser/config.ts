/**
 * Browser config resolvers — standalone replacement (attach-only, no openclaw deps).
 */

interface ResolvedBrowserConfig {
  attachOnly: boolean;
  defaultProfile: string;
}

interface ResolvedBrowserProfile {
  cdpPort: number;
  cdpUrl: string;
  attachOnly: boolean;
}

export function resolveBrowserConfig(
  cfg: { attachOnly?: boolean; defaultProfile?: string } | undefined,
  _rootConfig?: unknown,
): ResolvedBrowserConfig {
  return {
    attachOnly: cfg?.attachOnly ?? true,
    defaultProfile: cfg?.defaultProfile ?? "default",
  };
}

export function resolveProfile(
  browserConfig: ResolvedBrowserConfig,
  profileName: string | undefined,
): ResolvedBrowserProfile | undefined {
  if (!profileName) return undefined;
  return {
    cdpPort: 9222,
    cdpUrl: "http://127.0.0.1:9222",
    attachOnly: true,
  };
}
