import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './request-log.js';

const AUTH_FILE = path.join(STATE_DIR, 'auth-profiles.json');

export interface AuthProfile {
  type: string;
  provider: string;
  token: string;
}

export function loadAuthProfiles(): Record<string, AuthProfile> {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')) as Record<string, AuthProfile>;
  } catch {
    return {};
  }
}

/**
 * Credentials for a provider (full credentials JSON: cookie + bearer +
 * sessionKey …). The stream factory parses it into client options.
 */
export function getCookieForProvider(apiId: string): string {
  const profiles = loadAuthProfiles();
  return profiles[`${apiId}:default`]?.token || '';
}
