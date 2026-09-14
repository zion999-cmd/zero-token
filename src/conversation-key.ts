/**
 * Stable logical-conversation key shared by all protocol adapters.
 * Grouping requests lets providers reuse the same upstream web conversation.
 */

// djb2-style hash on the full string avoids the truncation collision of two
// long messages sharing the same first N characters.
export function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Key: hash(firstUserMessage) + msgCount bucket
// - firstUserMessage stays constant across all turns of the same conversation
// - sysHash intentionally omitted: dynamic system-prompt fields (cch, session
//   tokens) change every turn and would break cross-turn lookup
// - msgCount bucket separates suggestion/title requests from main turns
export function getConversationKey(
  messages: Array<{ role: string; content: unknown }>,
  _systemPrompt?: string,
): string {
  const firstUser = messages.find((m) => m.role === 'user');
  let userText = '';
  if (firstUser) {
    if (typeof firstUser.content === 'string') {
      userText = firstUser.content;
    } else if (Array.isArray(firstUser.content)) {
      userText = (firstUser.content as Array<Record<string, unknown>>)
        .filter((p) => p.type === 'text')
        .map((p) => (p.text as string) || '')
        .join('');
    }
  }
  const userHash = hashStr(userText);
  // Turn 1 (msgs≤2), Turn 2+ (msgs 3-6), longer conversations (msgs 7+)
  const msgBucket = messages.length <= 2 ? 'a' : messages.length <= 6 ? 'b' : 'c';
  return `${userHash}_${msgBucket}`;
}
