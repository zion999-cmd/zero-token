import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import { getWebStreamFactory, listWebStreamApiIds } from './streams/web-stream-factories.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function loadAccessToken(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return cfg.access_token || '';
  } catch {
    return '';
  }
}

const ACCESS_TOKEN = loadAccessToken();

const app = express();
app.use(express.json());

// ── Auth middleware ────────────────────────────────────

if (ACCESS_TOKEN) {
  app.use('/v1', (req: Request, res: Response, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== ACCESS_TOKEN) {
      return res.status(401).json({
        error: { message: 'Invalid access token', type: 'authentication_error', param: null },
      });
    }
    next();
  });
  console.log('Access token auth enabled');
}

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
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
  // Accept but ignore OpenAI SDK params (web models don't support them)
  const { model, messages, stream = false, tools, tool_choice, temperature, max_tokens, top_p, n, stop } = req.body;
  void temperature; void max_tokens; void top_p; void n; void stop;

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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('My Zero Token: http://127.0.0.1:' + PORT);
});
