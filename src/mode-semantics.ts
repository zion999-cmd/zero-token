/**
 * Mode hints — semantics for the NON-CONTRACT `mode` field.
 *
 * ── Layer boundary ──────────────────────────────────────────────────────────
 *
 *   WebChat provider
 *        ↑
 *   my-zero-token Gateway      ← product core; contract = /v1/* endpoints
 *        ↑
 *   :3001 test application     ← a consumer (index.html), not the Gateway
 *
 * The Gateway's contract is the standard API surface:
 *
 *   /v1/chat/completions   /v1/responses   /v1/messages
 *
 * and that surface is stateless at the API semantic layer: the request must
 * carry the context needed to reproduce its answer, and correctness must never
 * depend on the lifetime of an upstream WebChat session. An upstream session
 * is a transport resource that MAY be reused as an optimization, never
 * authoritative conversation memory.
 *
 * ── What `mode` is, and is not ──────────────────────────────────────────────
 *
 * `mode` is NOT part of that contract. It is an internal hint consumed by the
 * bundled :3001 test application for its chat / tools / chatroom experiments.
 * Nothing in the standard API depends on it — omitting it always selects the
 * stateless path.
 *
 * Delete the :3001 application and the Gateway remains complete: this table
 * exists only so the Gateway handles the hint consistently instead of
 * re-deriving its meaning ad hoc in each branch.
 *
 * ── Known conflict with the boundary above (reported, not silently kept) ────
 *
 * The Gateway currently *implements* `mode` inside its own request path — the
 * route reads it, the middleware branches on it, and provider streams consult
 * it. Per the boundary definition a test-application hint should not alter
 * Gateway behaviour at all, so this is historical coupling rather than
 * intended architecture. It is documented and contained here; separating it is
 * a future change, deliberately not attempted in this revision.
 */

/** Hint values accepted on the chat-completions surface. Not a public contract. */
export type ModeHint = "default" | "chat" | "chatroom" | "tool";

export interface ModeSemantics {
  /**
   * Does the request itself carry everything needed to reproduce the answer?
   * When true, a fresh upstream session yields an equivalent result.
   */
  carriesCanonicalContext: boolean;
  /**
   * Is upstream WebChat session history the ONLY conversation memory?
   * When true, losing the upstream session loses the conversation.
   */
  dependsOnUpstreamState: boolean;
  /**
   * May a failed/empty run be recovered by replaying the request against a
   * fresh upstream session without changing conversation semantics?
   */
  supportsFreshSessionRetry: boolean;
  /** Are caller-supplied tool definitions actually transmitted upstream? */
  supportsTools: boolean;
  /** Short human-facing description, used in errors and docs. */
  description: string;
}

export const MODE_SEMANTICS: Record<ModeHint, ModeSemantics> = {
  default: {
    carriesCanonicalContext: true,
    dependsOnUpstreamState: false,
    supportsFreshSessionRetry: true,
    supportsTools: true,
    description:
      "Standard API path — the request carries its own context; this is the Gateway contract",
  },
  chat: {
    carriesCanonicalContext: false,
    dependsOnUpstreamState: true,
    supportsFreshSessionRetry: false,
    supportsTools: false,
    description:
      "Test-app native WebChat session mode — only the latest user message is sent, so the upstream session is the sole conversation memory",
  },
  chatroom: {
    carriesCanonicalContext: true,
    dependsOnUpstreamState: false,
    supportsFreshSessionRetry: true,
    supportsTools: false,
    description:
      "Test-app chatroom mode — the caller rebuilds and sends the room history each turn",
  },
  tool: {
    carriesCanonicalContext: true,
    dependsOnUpstreamState: false,
    supportsFreshSessionRetry: true,
    supportsTools: false,
    description: "Pass-through tool mode — the caller sends the message list",
  },
};

/** Normalise an untrusted `mode` value; anything unknown selects the contract path. */
export function resolveMode(mode: unknown): ModeHint {
  return mode === "chat" || mode === "chatroom" || mode === "tool" ? mode : "default";
}

export function getModeSemantics(mode: unknown): ModeSemantics {
  return MODE_SEMANTICS[resolveMode(mode)];
}

/**
 * May this request be retried against a brand-new upstream session?
 *
 * Only when the request itself carries the conversation context — otherwise a
 * "successful" retry would answer without the conversation, which is silent
 * semantic corruption rather than recovery.
 */
export function canRetryWithFreshUpstreamSession(mode: unknown): boolean {
  const semantics = getModeSemantics(mode);
  return semantics.carriesCanonicalContext && semantics.supportsFreshSessionRetry;
}
