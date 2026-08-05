/**
 * Concurrency limiter for gateway requests (zero-dependency).
 *
 * Every provider runs ONE shared browser page (singleton client), so two DOM
 * simulations racing on the same page garble each other — navigation, typing
 * and response-polling all fight over the same DOM. This module therefore:
 *
 *   - accepts up to `PROVIDER_CONCURRENCY` (default 5) concurrent requests per
 *     provider — the network-capacity ceiling, matching user expectation that
 *     several sessions can be "in flight" at once;
 *   - executes the actual browser work STRICTLY SERIALLY per provider via a
 *     tail chain — a single page can only do one thing at a time;
 *   - sheds excess load by returning `ShedLoad` when the queue is too deep;
 *     the caller destroys the socket (no response bytes → near-zero CPU),
 *     so a flood can't be turned into a response-writing DoS.
 *
 * Per-session ordering falls out naturally from the provider-wide serialization:
 * the same conversation can never have two requests executing at once.
 *
 * NOTE: slot accounting is SYNCHRONOUS on purpose. `running` is incremented at
 * the moment the slot is granted, not in a microtask, so a burst of synchronous
 * callers (e.g. `Promise.all([...])`) still respects the cap and the shed rule.
 */

/** Sentinel returned by `runWithLimit` when the provider is overloaded. */
export const ShedLoad = Symbol('shed-load');

/** Max concurrent in-flight requests accepted per provider. */
const PROVIDER_CONCURRENCY = Number(process.env.PROVIDER_CONCURRENCY) || 5;

/** Shed new requests once this many are already queued waiting for a slot. */
const MAX_QUEUE_DEPTH = Number(process.env.MAX_QUEUE_DEPTH) || 10;

interface ProviderGate {
  /** Requests currently holding a concurrency slot (granted synchronously). */
  running: number;
  /** FIFO waiters for a free slot; each call transfers a slot synchronously. */
  waiters: Array<() => void>;
  /** Serialization chain — the promise of the previous request's work. */
  tail: Promise<unknown>;
}

const gates = new Map<string, ProviderGate>();

function getGate(apiId: string): ProviderGate {
  let gate = gates.get(apiId);
  if (!gate) {
    gate = { running: 0, waiters: [], tail: Promise.resolve() };
    gates.set(apiId, gate);
  }
  return gate;
}

/**
 * Run `fn` on the provider's serialization chain, then free its slot and hand
 * the slot to the next waiter.
 */
function executeWork<T>(gate: ProviderGate, fn: () => Promise<T>): Promise<T> {
  const work = gate.tail.then(() => fn());
  gate.tail = work.catch(() => {}); // keep the chain alive across failures
  return work.finally(() => {
    gate.running--;
    const next = gate.waiters.shift();
    if (next) next(); // transfer the freed slot to the next waiter
  });
}

/**
 * Run `fn` under the provider's concurrency budget.
 *
 * Returns `ShedLoad` (not a rejection) when overloaded — the caller should
 * drop the connection without writing any response.
 *
 * @param apiId          provider id, e.g. `chatgpt-web`
 * @param _conversationId reserved for per-session semantics; provider-wide
 *                        serialization already guarantees session ordering
 * @param fn             the async work to run (the stream invocation)
 */
export function runWithLimit<T>(
  apiId: string,
  _conversationId: string | undefined,
  fn: () => Promise<T>,
): Promise<T | typeof ShedLoad> {
  const gate = getGate(apiId);

  // Overload shedding: all slots busy AND queue already deep → drop without
  // even enqueueing. Cheaper than responding (a rejection flood costs CPU).
  if (gate.running >= PROVIDER_CONCURRENCY && gate.waiters.length >= MAX_QUEUE_DEPTH) {
    console.log(
      `[Concurrency] shed ${apiId}: running=${gate.running} waiters=${gate.waiters.length}`,
    );
    return Promise.resolve(ShedLoad);
  }

  // Grant a slot synchronously if one is free, else queue for the next release.
  if (gate.running < PROVIDER_CONCURRENCY) {
    gate.running++;
    return executeWork(gate, fn);
  }

  return new Promise<T | typeof ShedLoad>((resolve, reject) => {
    gate.waiters.push(() => {
      gate.running++; // take the transferred slot synchronously
      executeWork(gate, fn).then(resolve, reject);
    });
  });
}

/** Reset all gates — mainly for tests. */
export function resetConcurrencyLimits(): void {
  gates.clear();
}
