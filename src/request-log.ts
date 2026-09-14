import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STATE_DIR = path.join(__dirname, '..', '.myzt-state');
const REQ_LOG = path.join(STATE_DIR, 'requests.log');

/** Append one structured request-log entry (best-effort, never throws). */
export function logRequest(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(REQ_LOG, line, 'utf-8');
  } catch { /* best-effort */ }
}
