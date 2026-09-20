import { describe, expect, it } from 'vitest';
import {
  MODE_SEMANTICS,
  canRetryWithFreshUpstreamSession,
  getModeSemantics,
  resolveMode,
  type ModeHint,
} from '../src/mode-semantics.js';

const ALL_MODES = Object.keys(MODE_SEMANTICS) as ModeHint[];

describe('resolveMode', () => {
  it('maps the known modes to themselves', () => {
    expect(resolveMode('chat')).toBe('chat');
    expect(resolveMode('chatroom')).toBe('chatroom');
    expect(resolveMode('tool')).toBe('tool');
  });

  it('treats anything else as the standard API mode', () => {
    expect(resolveMode(undefined)).toBe('default');
    expect(resolveMode(null)).toBe('default');
    expect(resolveMode('')).toBe('default');
    expect(resolveMode('CHAT')).toBe('default');
    expect(resolveMode({ mode: 'chat' })).toBe('default');
  });
});

describe('mode semantics table', () => {
  it('standard API mode carries its own context and supports tools', () => {
    const s = getModeSemantics(undefined);
    expect(s.carriesCanonicalContext).toBe(true);
    expect(s.dependsOnUpstreamState).toBe(false);
    expect(s.supportsTools).toBe(true);
  });

  it('native chat mode depends on upstream state and supports no tools', () => {
    const s = getModeSemantics('chat');
    expect(s.carriesCanonicalContext).toBe(false);
    expect(s.dependsOnUpstreamState).toBe(true);
    expect(s.supportsTools).toBe(false);
  });

  it('chatroom mode carries the room history in the request', () => {
    const s = getModeSemantics('chatroom');
    expect(s.carriesCanonicalContext).toBe(true);
    expect(s.dependsOnUpstreamState).toBe(false);
    expect(s.supportsTools).toBe(false);
  });

  it('every mode states whether it depends on upstream state', () => {
    for (const mode of ALL_MODES) {
      const s = MODE_SEMANTICS[mode];
      // Carrying your own context and depending on upstream state are opposites.
      expect(s.dependsOnUpstreamState).toBe(!s.carriesCanonicalContext);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe('canRetryWithFreshUpstreamSession', () => {
  it('allows retry only for modes whose request carries the context', () => {
    for (const mode of ALL_MODES) {
      const allowed = canRetryWithFreshUpstreamSession(mode);
      // The safety property: a fresh-session retry may never be allowed in a
      // mode that would lose the conversation by starting a new session.
      if (allowed) {
        expect(MODE_SEMANTICS[mode].carriesCanonicalContext).toBe(true);
      }
      expect(allowed).toBe(MODE_SEMANTICS[mode].supportsFreshSessionRetry);
    }
  });

  it('forbids retry in native chat mode', () => {
    expect(canRetryWithFreshUpstreamSession('chat')).toBe(false);
  });

  it('allows retry in the standard API mode', () => {
    expect(canRetryWithFreshUpstreamSession(undefined)).toBe(true);
    expect(canRetryWithFreshUpstreamSession('chatroom')).toBe(true);
  });
});
