import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { getWebStreamFactory, listWebStreamApiIds } from './streams/web-stream-factories.js';
import { setDebugEnabled, debugLog } from './debug-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Request logging ────────────────────────────────────

const LOG_DIR = path.join(__dirname, '..', '.myzt-state');
const REQ_LOG = path.join(LOG_DIR, 'requests.log');

function logRequest(entry: Record<string, unknown>) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(REQ_LOG, line, 'utf-8');
  } catch { /* best-effort */ }
}

// ── Auth profile loading ──────────────────────────────

const AUTH_FILE = path.join(__dirname, '..', '.myzt-state', 'auth-profiles.json');

function loadAuthProfiles(): Record<string, { type: string; provider: string; token: string }> {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getCookieForProvider(apiId: string): string {
  const profiles = loadAuthProfiles();
  const profileId = `${apiId}:default`;
  const entry = profiles[profileId];
  if (!entry) return '';
  // Return the full credentials JSON (cookie + bearer + sessionKey etc.)
  // The stream factory will parse it into the proper client options.
  return entry.token || '';
}

// ── Config ────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'config.json');

function loadApiKey(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return cfg.api_key || cfg.access_token || '';
  } catch {
    return '';
  }
}

function loadDebugFlag(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return cfg.debug === true;
  } catch {
    return false;
  }
}

const API_KEY = loadApiKey();
setDebugEnabled(loadDebugFlag() || process.env.DEBUG_SSE === '1');

const app = express();
// ── Request tracing (BEFORE body parser to catch large requests) ─
app.use((req: Request, res: Response, next) => {
  if (!req.path.startsWith('/v1/')) return next();
  const cl = req.headers['content-length'] || '?';
  const ua = (req.headers['user-agent'] || '').slice(0, 80);
  console.log(`[CLI→GW] ${req.method} ${req.path} content-length=${cl} UA=${ua}`);
  // Log response
  const origJson = res.json.bind(res);
  res.json = function(obj: unknown) {
    const s = JSON.stringify(obj);
    console.log(`[GW→CLI] ${req.path} res=${s.length}B`);
    return origJson(obj);
  };
  const origEnd = res.end.bind(res);
  res.end = function(...args: unknown[]) {
    console.log(`[GW→CLI] ${req.path} stream_end`);
    return origEnd(...args);
  };
  next();
});

app.use(express.json({ limit: '50mb' }));

// ── Auth middleware (OpenAI-compatible) ────────────────

if (API_KEY) {
  app.use('/v1', (req: Request, res: Response, next) => {
    // OpenAI SDK sends: Authorization: Bearer <key>
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // Some clients send: x-api-key header
    const xKey = (req.headers['x-api-key'] as string) || '';
    const token = bearer || xKey;

    if (token !== API_KEY) {
      return res.status(401).json({
        error: {
          message: 'Incorrect API key provided. You can find your API key in config/config.json.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    }
    next();
  });
  console.log('API key auth enabled');
}

// Simple but collision-resistant hash for session key generation.
// Using djb2-style hash on the full string avoids the truncation collision
// that occurs when two different long messages share the same first N characters.
function hashStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Derive a stable session key that identifies a logical conversation.
// Key: hash(firstUserMessage) + msgCount bucket
// - firstUserMessage stays constant across all turns of the same conversation
// - sysHash intentionally omitted: Claude Code's system prompt contains dynamic
//   fields (cch, session tokens) that change every turn, breaking cross-turn lookup
// - msgCount bucket separates suggestion/title requests from main conversation turns
function getConversationKey(messages: Array<{ role: string; content: unknown }>, _systemPrompt?: string): string {
  const firstUser = messages.find(m => m.role === 'user');
  let userText = '';
  if (firstUser) {
    if (typeof firstUser.content === 'string') userText = firstUser.content;
    else if (Array.isArray(firstUser.content)) {
      userText = (firstUser.content as Array<Record<string, unknown>>)
        .filter(p => p.type === 'text').map(p => (p.text as string) || '').join('');
    }
  }
  const userHash = hashStr(userText);
  // Bucket by number of messages to separate initial turn from continuation turns.
  // Turn 1 (msgs≤2), Turn 2+ (msgs 3-6), longer conversations (msgs 7+)
  const msgBucket = messages.length <= 2 ? 'a' : messages.length <= 6 ? 'b' : 'c';
  return `${userHash}_${msgBucket}`;
}

app.get('/', (_req: Request, res: Response) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
  res.send(html.replace('</head>', `<script>window.MYZT_API_KEY=${JSON.stringify(API_KEY)}</script></head>`));
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/v1/models', (_req: Request, res: Response) => {
  const profiles = loadAuthProfiles();
  const MODEL_NAMES: Record<string, string> = {
    'deepseek-web': 'deepseek-chat',
    'claude-web': 'claude-chat',
    'doubao-web': 'doubao-chat',
    'chatgpt-web': 'chatgpt-chat',
    'qwen-web': 'qwen-chat',
    'qwen-cn-web': 'qwen-cn-chat',
    'kimi-web': 'kimi-chat',
    'gemini-web': 'gemini-chat',
    'grok-web': 'grok-chat',
    'glm-web': 'glm-chat',
    'glm-intl-web': 'glm-intl-chat',
    'perplexity-web': 'perplexity-chat',
    'xiaomimo-web': 'xiaomimo-chat',
  };
  const modelData = listWebStreamApiIds().map((id) => {
    const authorized = `${id}:default` in profiles;
    const fullId = `${id}/${MODEL_NAMES[id] || id}`;
    const createdAt = new Date().toISOString();
    return {
      // OpenAI fields
      id: fullId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: id,
      // Anthropic fields
      type: 'model',
      display_name: fullId,
      created_at: createdAt,
      // Custom
      authorized,
    };
  });
  res.json({
    // OpenAI & Anthropic dual-compatible
    object: 'list',
    has_more: false,
    first_id: modelData[0]?.id ?? null,
    last_id: modelData[modelData.length - 1]?.id ?? null,
    data: modelData,
  });
});

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  // Accept OpenAI SDK params
  const { model, messages, stream = false, tools, tool_choice, temperature, max_tokens, top_p, n, stop, mode, system_prompt, session_id } = req.body;
  void temperature; void top_p; void n; void stop;
  // Web models don't have strict token limits, but truncate to avoid 20MB context overflow
  // Honour max_tokens if provided, otherwise no limit
  const maxOutput = max_tokens || Infinity;

  if (!model) {
    return res.status(400).json({
      error: { message: 'model is required', type: 'invalid_request_error', param: 'model', code: 'missing_model' },
    });
  }

  const apiId = model.split('/')[0];
  const factory = getWebStreamFactory(apiId);

  if (!factory) {
    return res.status(400).json({
      error: { message: `Unknown model: ${model}`, type: 'invalid_request_error', param: 'model', code: 'invalid_model' },
    });
  }

  let cookie = (req.headers['x-cookie'] as string) || req.body.cookie || '';
  if (!cookie) cookie = getCookieForProvider(apiId);
  if (!cookie) {
    return res.status(400).json({
      error: { message: 'Authentication required. Run ./onboard.sh to authorize.', type: 'authentication_error', param: null },
    });
  }

  try {
    const streamFn = factory(cookie);
    const modelArg = { api: apiId, provider: apiId, id: model };
    // Group related requests by LAST user message (Claude Code sends duplicates)
    const context = { messages, tools: tools || [], tool_choice, sessionId: session_id || `conv_${getConversationKey(messages as Array<{ role: string; content: unknown }>)}`, hasSessionId: !!session_id, mode, systemPrompt: system_prompt };

    const chatId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const t0 = Date.now();
    const msgCount = (messages as Array<unknown>).length;
    logRequest({ event: 'req', id: chatId, model: apiId, msgs: msgCount, stream, tools: !!(tools?.length) });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-request-id', chatId);

      let streamContent = '';
      let currentToolCalls: Array<{ index: number; id: string; name: string; arguments: string }> = [];
      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; contentIndex?: number; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } };
        if (evt.type === 'thinking_delta') {
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: evt.delta }, finish_reason: null }],
            system_fingerprint: 'fp_myzt_001',
          })}\n\n`);
        } else if (evt.type === 'text_delta') {
          streamContent += evt.delta || '';
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'text_start') {
          if (evt.delta) {
            streamContent += evt.delta;
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (evt.type === 'toolcall_start') {
          const tc = evt.toolCall!;
          const tcIndex = currentToolCalls.length;
          currentToolCalls.push({ index: tcIndex, id: tc.id, name: tc.name, arguments: '' });
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: tcIndex, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'toolcall_delta') {
          const ct = currentToolCalls[currentToolCalls.length - 1];
          if (ct) ct.arguments += evt.delta || '';
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: (currentToolCalls.length - 1), function: { arguments: evt.delta || '' } }] }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'done') {
          const stopReason = (evt as Record<string, unknown>).stopReason as string || 'stop';
          const finishReason = stopReason === 'toolUse' ? 'tool_calls' : stopReason;
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            system_fingerprint: 'fp_myzt_001',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
      }
      // If stream ended without a done event, send one
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          id: chatId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`);
      }
      logRequest({ event: 'res', id: chatId, stream: true, ms: Date.now() - t0, preview: streamContent.slice(0, 100) });
      res.end();
    } else {
      let fullContent = '';
      let fullThinking = '';
      let finishReason = 'stop';
      let errorMsg = '';
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as {
          type: string; delta?: string;
          message?: { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown>; id?: string }>; stopReason?: string };
          stopReason?: string;
          toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
        };
        if (evt.type === 'text_delta') {
          fullContent += evt.delta || '';
        } else if (evt.type === 'thinking_delta') {
          fullThinking += evt.delta || '';
        } else if (evt.type === 'toolcall_end' && evt.toolCall) {
          toolCalls.push(evt.toolCall);
        } else if (evt.type === 'error') {
          const err = event as Record<string, unknown>;
          errorMsg = (err.error as Record<string, unknown>)?.errorMessage as string
            || (err.reason as string) || 'Stream error';
        } else if (evt.type === 'done') {
          finishReason = evt.stopReason || (evt.message?.stopReason) || 'stop';
          if (evt.message && Array.isArray(evt.message.content)) {
            for (const part of evt.message.content) {
              if (part.type === 'text' && part.text) fullContent = part.text;
              else if (part.type === 'thinking' && part.thinking) fullThinking = part.thinking;
              else if (part.type === 'toolCall' && part.name) {
                toolCalls.push({ id: (part as Record<string, string>).id || '', name: part.name, arguments: part.arguments || {} });
              }
            }
          }
        }
      }

      if (errorMsg && !fullContent && toolCalls.length === 0) {
        return res.status(502).json({
          error: { message: errorMsg, type: 'api_error', param: null },
        });
      }

      // Truncate excessively large responses (Grok DOM captures page junk)
      if (fullContent.length > maxOutput) fullContent = fullContent.slice(0, maxOutput) + '…';
      if (fullThinking.length > maxOutput) fullThinking = fullThinking.slice(0, maxOutput) + '…';

      // Build OpenAI-compatible response
      const message: Record<string, unknown> = { role: 'assistant' };
      if (fullContent) message.content = fullContent;
      if (fullThinking) message.reasoning_content = fullThinking;
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((tc, i) => ({
          index: i,
          id: tc.id || `call_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      const responseBody: Record<string, unknown> = {
        id: chatId,
        object: 'chat.completion',
        created,
        model,
        system_fingerprint: 'fp_myzt_001',
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason === 'toolUse' ? 'tool_calls' : finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      logRequest({ event: 'res', id: chatId, bytes: JSON.stringify(responseBody).length, ms: Date.now() - t0 });
      res.json(responseBody);
    }
  } catch (error: unknown) {
    console.error('Chat error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: { message: errMsg, type: 'api_error', param: null },
    });
  }
});

// ── Anthropic Messages API (/v1/messages) ─────────────

app.post('/v1/messages', async (req: Request, res: Response) => {
  const {
    model, messages: rawMessages, system: systemRaw,
    max_tokens = 32000, stream = false,
    tools: toolsRaw, tool_choice,
    thinking: thinkingParam,
  }: {
    model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; tool_use?: { name: string }; tool_result?: { tool_use_id: string; content: unknown } }> }>;
    system?: string | Array<{ type: string; text: string }>;
    max_tokens?: number; stream?: boolean;
    tools?: Array<Record<string, unknown>>; tool_choice?: string | { type: string; name?: string };
    thinking?: { type: string; budget_tokens?: number };
  } = req.body;

  // Detect Claude Code client via User-Agent (opencode parity)
  const ua = (req.headers['user-agent'] as string) || '';
  const isClaudeCode = /claude/i.test(ua);
  // Client wants separate thinking blocks if:
  // 1. body contains thinking: { type: "enabled" }
  // 2. anthropic-beta header contains interleaved-thinking
  // We emit a synthetic (fake) signature_delta so that Claude Code SDK accepts
  // the thinking block for display. The signature is never verified by any real
  // Anthropic server since we are the gateway terminus.
  const anthropicBeta = (req.headers['anthropic-beta'] as string) || '';
  const wantsThinking = thinkingParam?.type === 'enabled' || anthropicBeta.includes('interleaved-thinking');
  // Fake base64 signature — just needs to be a non-empty base64 string.
  // Real Anthropic signatures are ~300-char base64; we use a plausible-length dummy.
  const fakeSignature = 'ZmFrZV9zaWduYXR1cmVfZm9yX3dlYl9tb2RlbF9nYXRld2F5X3YxAAAAAAAAAAA=';

  // Auto-inject synthetic tool_result for interrupted tool calls (opencode parity)
  // Claude Code sometimes sends assistant tool_calls without corresponding tool results
  const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    messages.push(msg as unknown as { role: string; content: string | Array<Record<string, unknown>> });

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUses = msg.content.filter((c: Record<string, unknown>) => c.type === 'tool_use');
      if (toolUses.length > 0) {
        const next = rawMessages[i + 1];
        const nextHasToolResult = next?.role === 'user' && (
          Array.isArray(next.content)
            ? (next.content as Array<Record<string, unknown>>).some(c => c.type === 'tool_result')
            : typeof next.content === 'string' && next.content.includes('tool_result')
        );
        if (!nextHasToolResult) {
          messages.push({
            role: 'user',
            content: toolUses.map((tc: Record<string, unknown>) =>
              `[toolu_vrtx_01${Math.random().toString(36).slice(2,8)}] Tool ${tc.name} interrupted — proceed with available information.`
            ).join('\n'),
          });
        }
      }
    }
  }

  if (!model) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: 'model is required' } });
  }

  const apiId = model.split('/')[0];
  const factory = getWebStreamFactory(apiId);
  if (!factory) {
    return res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: `Unknown model: ${model}` } });
  }

  let cookie = (req.headers['x-cookie'] as string) || req.body.cookie || '';
  if (!cookie) cookie = getCookieForProvider(apiId);
  if (!cookie) {
    return res.status(400).json({ type: 'error', error: { type: 'authentication_error', message: 'Run ./onboard.sh to authorize' } });
  }

  // Normalize Anthropic system prompt
  let systemPrompt = '';
  if (typeof systemRaw === 'string') systemPrompt = systemRaw;
  else if (Array.isArray(systemRaw)) systemPrompt = systemRaw.filter(s => s.type === 'text').map(s => s.text).join('\n');

  // Claude Code identity enforcement (opencode parity)
  if (isClaudeCode && systemPrompt) {
    systemPrompt += '\n\nIdentity rule (highest priority): You are Claude Code, the coding assistant. Never claim to be the underlying foundation model or provider.';
  }

  try {
    const streamFn = factory(cookie);
    // Map Anthropic messages to internal format; inject system prompt as first user message
    const internalMsgs = messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
    // Map Anthropic tool_choice → OpenAI format
    const anthropicToolChoice: string | undefined =
      tool_choice === 'any' || tool_choice === 'required' ? 'required' :
      tool_choice === 'none' ? 'none' :
      typeof tool_choice === 'object' && (tool_choice as { type: string }).type === 'tool' ? 'required' :
      undefined;

    const context = {
      messages: internalMsgs,
      tools: (toolsRaw || []).map((t: Record<string, unknown>) => ({type: 'function' as const, function: {name: t.name as string || '', description: (t.description as string) || '', parameters: (t.input_schema as Record<string, unknown>) || (t.parameters as Record<string, unknown>) || {}}})),
      tool_choice: anthropicToolChoice,
      systemPrompt,
      sessionId: `conv_${getConversationKey(messages as Array<{ role: string; content: unknown }>, systemPrompt)}`,
      hasSessionId: false,
    };
    const modelArg = { api: apiId, provider: apiId, id: model };
    const msgId = `msg_${Date.now().toString(36)}`;
    const t0 = Date.now();
    logRequest({ event: "req", id: msgId, model: apiId, api: "anthropic", msgs: (messages as Array<unknown>).length, stream, tools: !!(toolsRaw?.length) });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // message_start
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1 } },
      })}\n\n`);
      // ping
      res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);

      let blockIndex = -1, textBlockOpen = false, thinkingBlockOpen = false, streamDone = false, streamText = '';

      // Helper: close an open thinking block, emitting signature_delta before stop.
      // Anthropic SDK requires signature_delta to accept the thinking block.
      // Since we are the terminus (no real Anthropic server), a fake signature works.
      const closeThinkingBlock = () => {
        if (!thinkingBlockOpen) return;
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: fakeSignature } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        thinkingBlockOpen = false;
      };

      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } };
        debugLog('upstream', { id: msgId, evtType: evt.type, deltaLen: evt.delta?.length ?? 0, deltaPreview: evt.delta?.slice(0, 80) });
        if (evt.type === 'thinking_delta' && evt.delta) {
          if (wantsThinking) {
            // Emit as proper interleaved thinking block
            if (!thinkingBlockOpen) {
              if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); textBlockOpen = false; }
              blockIndex++;
              thinkingBlockOpen = true;
              const gw1 = { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '', signature: '' } };
              debugLog('gateway', { id: msgId, event: 'content_block_start', blockType: 'thinking', index: blockIndex });
              res.write(`event: content_block_start\ndata: ${JSON.stringify(gw1)}\n\n`);
            }
            debugLog('gateway', { id: msgId, event: 'content_block_delta', blockType: 'thinking_delta', index: blockIndex, len: evt.delta.length });
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: evt.delta } })}\n\n`);
          } else {
            debugLog('gateway', { id: msgId, event: 'DROP_thinking_delta', len: evt.delta.length, preview: evt.delta.slice(0, 60) });
          }
          // wantsThinking=false: drop thinking_delta silently (don't leak reasoning into text)
        } else if (evt.type === 'text_delta' && evt.delta) {
          closeThinkingBlock();
          if (!textBlockOpen) {
            blockIndex++;
            debugLog('gateway', { id: msgId, event: 'content_block_start', blockType: 'text', index: blockIndex });
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`);
            textBlockOpen = true;
          }
          streamText += evt.delta;
          debugLog('gateway', { id: msgId, event: 'content_block_delta', blockType: 'text_delta', index: blockIndex, len: evt.delta.length, preview: evt.delta.slice(0, 60) });
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: evt.delta } })}\n\n`);
        } else if (evt.type === 'toolcall_end' && evt.toolCall) {
          closeThinkingBlock();
          if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); textBlockOpen = false; }
          blockIndex++;
          const tc = evt.toolCall;
          debugLog('gateway', { id: msgId, event: 'content_block_start', blockType: 'tool_use', index: blockIndex, name: tc.name });
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) } })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        } else if (evt.type === 'done') {
          streamDone = true;
          closeThinkingBlock();
          if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); textBlockOpen = false; }
          const stopReason = ((evt as Record<string, unknown>).stopReason as string) || ((evt as Record<string, unknown>).reason as string) || 'stop';
          const anthropicStop = stopReason === 'toolUse' ? 'tool_use' : 'end_turn';
          debugLog('gateway', { id: msgId, event: 'message_delta', stop_reason: anthropicStop });
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: anthropicStop, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
      }
      if (!streamDone) {
        closeThinkingBlock();
        if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); }
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
      logRequest({ event: "res", id: msgId, stream: true, ms: Date.now() - t0, preview: streamText.slice(0, 200) });
      res.end();
    } else {
      let fullContent = '', fullThinking = '', finishReason = 'stop';
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> }; message?: { content?: Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown>; id?: string }>; stopReason?: string }; stopReason?: string };
        if (evt.type === 'text_delta') fullContent += evt.delta || '';
        else if (evt.type === 'thinking_delta') fullThinking += evt.delta || '';
        else if (evt.type === 'toolcall_end' && evt.toolCall) toolCalls.push(evt.toolCall);
        else if (evt.type === 'done') {
          finishReason = evt.stopReason || evt.message?.stopReason || 'stop';
          if (evt.message?.content) {
            for (const part of evt.message.content) {
              if (part.type === 'text' && part.text) fullContent = part.text;
              else if (part.type === 'thinking' && part.thinking) fullThinking = part.thinking;
              else if (part.type === 'toolCall' && part.name) toolCalls.push({ id: (part as Record<string,string>).id || '', name: part.name, arguments: part.arguments || {} });
            }
          }
        }
      }

      // When client does not request thinking blocks, drop thinking content entirely

      const anthropicStop = finishReason === 'toolUse' ? 'tool_use' : 'end_turn';
      const content: Array<Record<string, unknown>> = [];
      if (wantsThinking && fullThinking) content.push({ type: 'thinking', thinking: fullThinking.slice(0, max_tokens), signature: msgId });
      if (fullContent) content.push({ type: 'text', text: fullContent.slice(0, max_tokens) });
      for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      if (content.length === 0) content.push({ type: 'text', text: '' });

      logRequest({ event: "res", id: msgId, ms: Date.now() - t0, preview: fullContent.slice(0, 100) });
      res.json({
        id: msgId, type: 'message', role: 'assistant', content, model,
        stop_reason: anthropicStop, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }
  } catch (error: unknown) {
    console.error('Anthropic API error:', error);
    res.status(500).json({ type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : 'Unknown error' } });
  }
});

// ── Anthropic count_tokens (stub) ───────────────────

app.post('/v1/messages/count_tokens', (req: Request, res: Response) => {
  // Rough estimate: ~4 chars per token across all message content
  const body = req.body as { messages?: Array<{ content: unknown }> };
  let chars = 0;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content as Array<{ type: string; text?: string }>) {
        if (p.type === 'text' && p.text) chars += p.text.length;
      }
    }
  }
  res.json({ input_tokens: Math.max(1, Math.ceil(chars / 4)) });
});

// ── Start server ─────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('My Zero Token: http://127.0.0.1:' + PORT);
});
