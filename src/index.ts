import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { getWebStreamFactory, listWebStreamApiIds } from './streams/web-stream-factories.js';

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

const API_KEY = loadApiKey();

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
  res.json({
    object: 'list',
    data: listWebStreamApiIds().map((id) => {
      const authorized = `${id}:default` in profiles;
      return {
        id: `${id}/${MODEL_NAMES[id] || id}`,
        object: 'model',
        created: Date.now(),
        owned_by: id,
        authorized,
      };
    }),
  });
});

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  // Accept OpenAI SDK params
  const { model, messages, stream = false, tools, tool_choice, temperature, max_tokens, top_p, n, stop } = req.body;
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
    const context = { messages, tools: tools || [], tool_choice };

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

      let hasContent = false;
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
          hasContent = true;
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'text_start') {
          if (evt.delta) {
            hasContent = true;
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (evt.type === 'toolcall_start') {
          const tc = evt.toolCall!;
          currentToolCalls.push({ index: currentToolCalls.length, id: tc.id, name: tc.name, arguments: '' });
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: '' } }] }, finish_reason: null }],
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
      logRequest({ event: 'res', id: chatId, stream: true, ms: Date.now() - t0 });
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
  }: {
    model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; tool_use?: { name: string }; tool_result?: { tool_use_id: string; content: unknown } }> }>;
    system?: string | Array<{ type: string; text: string }>;
    max_tokens?: number; stream?: boolean;
    tools?: Array<Record<string, unknown>>; tool_choice?: string | { type: string; name?: string };
  } = req.body;

  // Detect Claude Code client via User-Agent (opencode parity)
  const ua = (req.headers['user-agent'] as string) || '';
  const isClaudeCode = /claude/i.test(ua);

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
        if (!next || next.role !== 'user' || (typeof next.content === 'string' && !next.content.includes('tool_result'))) {
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
    const context = {
      messages: internalMsgs,
      tools: (toolsRaw || []).map((t: Record<string, unknown>) => ({type: 'function' as const, function: {name: t.name as string || '', description: (t.description as string) || '', parameters: (t.input_schema as Record<string, unknown>) || (t.parameters as Record<string, unknown>) || {}}})),
      systemPrompt,
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

      let blockIndex = -1, textBlockOpen = false, streamDone = false;
      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } };
        if (evt.type === 'text_delta' && evt.delta) {
          if (!textBlockOpen) { blockIndex++; res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`); textBlockOpen = true; }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: evt.delta } })}\n\n`);
        } else if (evt.type === 'toolcall_start' && evt.toolCall) {
          if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); textBlockOpen = false; }
          blockIndex++;
          const tc = evt.toolCall;
          res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } })}\n\n`);
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) } })}\n\n`);
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        } else if (evt.type === 'done') {
          streamDone = true;
          if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); textBlockOpen = false; }
          const stopReason = (evt as Record<string, unknown>).stopReason as string || 'stop';
          const anthropicStop = stopReason === 'toolUse' ? 'tool_use' : 'end_turn';
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: anthropicStop, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
      }
      if (!streamDone) {
        if (textBlockOpen) { res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`); }
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
      logRequest({ event: "res", id: msgId, stream: true, ms: Date.now() - t0 });
      res.end();;
    } else {
      let fullContent = '', finishReason = 'stop';
      const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> }; message?: { content?: Array<{ type: string; text?: string; name?: string; arguments?: Record<string, unknown>; id?: string }>; stopReason?: string }; stopReason?: string };
        if (evt.type === 'text_delta') fullContent += evt.delta || '';
        else if (evt.type === 'toolcall_end' && evt.toolCall) toolCalls.push(evt.toolCall);
        else if (evt.type === 'done') {
          finishReason = evt.stopReason || evt.message?.stopReason || 'stop';
          if (evt.message?.content) {
            for (const part of evt.message.content) {
              if (part.type === 'text' && part.text) fullContent = part.text;
              else if (part.type === 'toolCall' && part.name) toolCalls.push({ id: (part as Record<string,string>).id || '', name: part.name, arguments: part.arguments || {} });
            }
          }
        }
      }

      const anthropicStop = finishReason === 'toolUse' ? 'tool_use' : 'end_turn';
      const content: Array<Record<string, unknown>> = [];
      if (fullContent) content.push({ type: 'text', text: fullContent.slice(0, max_tokens) });
      for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      if (content.length === 0) content.push({ type: 'text', text: '' });

      logRequest({ event: "res", id: msgId, ms: Date.now() - t0 });
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

// ── Start server ─────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('My Zero Token: http://127.0.0.1:' + PORT);
});
