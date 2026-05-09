/**
 * Shared debug logger — writes detailed event data to .myzt-state/debug.log
 *
 * Enable via config/config.json: { "debug": true }
 * Or env var: DEBUG_SSE=1
 *
 * Layers logged:
 *   "sse-raw"    — raw SSE events from DeepSeek web stream
 *   "middleware" — prompt sent + parsed events in web-stream-middleware
 *   "gateway"    — SSE events sent to the client (index.ts)
 */
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', '.myzt-state');
export const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');

let _enabled = false;

/** Call once at startup with config value */
export function setDebugEnabled(enabled: boolean): void {
  _enabled = enabled;
  if (enabled) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      // Rotate: clear on each server start so the file doesn't grow unbounded
      fs.writeFileSync(DEBUG_LOG, `=== debug log started ${new Date().toISOString()} ===\n`, 'utf-8');
      console.log(`[Debug] SSE debug logging ENABLED → ${DEBUG_LOG}`);
    } catch { /* best-effort */ }
  }
}

export function isDebugEnabled(): boolean {
  return _enabled;
}

/**
 * Write one entry to debug.log (JSONL format).
 * @param layer  e.g. "sse-raw", "middleware", "gateway"
 * @param entry  arbitrary key-value pairs
 */
export function debugLog(layer: string, entry: Record<string, unknown>): void {
  if (!_enabled) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), layer, ...entry }) + '\n';
    fs.appendFileSync(DEBUG_LOG, line, 'utf-8');
  } catch { /* best-effort */ }
}
