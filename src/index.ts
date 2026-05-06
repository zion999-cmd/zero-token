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

const app = express();
app.use(express.json());

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
  const { model, messages, stream = false } = req.body;

  if (!model) {
    return res.status(400).json({
      error: { message: 'model is required', type: 'invalid_request_error', code: 'missing_model' },
    });
  }

  const apiId = model.split('/')[0];
  const factory = getWebStreamFactory(apiId);

  if (!factory) {
    return res.status(400).json({
      error: { message: `Unknown model: ${model}`, type: 'invalid_request_error', code: 'invalid_model' },
    });
  }

  let cookie = (req.headers['x-cookie'] as string) || req.body.cookie || '';
  if (!cookie) cookie = getCookieForProvider(apiId);
  if (!cookie) {
    return res.status(400).json({
      error: { message: 'Authentication required. Run ./onboard.sh to authorize.', type: 'authentication_error' },
    });
  }

  try {
    const streamFn = factory(cookie);
    const modelArg = { api: apiId, provider: apiId, id: model };
    const context = { messages };

    const chatId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('x-request-id', chatId);

      let hasContent = false;
      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as { type: string; delta?: string; contentIndex?: number };
        if (evt.type === 'thinking_delta') {
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: evt.delta }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'text_delta') {
          hasContent = true;
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
          })}\n\n`);
        } else if (evt.type === 'text_start') {
          // First non-empty text delta acts as role indicator
          if (evt.delta) {
            hasContent = true;
            res.write(`data: ${JSON.stringify({
              id: chatId, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant', content: evt.delta }, finish_reason: null }],
            })}\n\n`);
          }
        } else if (evt.type === 'done') {
          const finishReason = (evt as Record<string, unknown>).stopReason as string || 'stop';
          res.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
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

      for await (const event of await Promise.resolve(streamFn(modelArg, context, {}))) {
        const evt = event as {
          type: string; delta?: string;
          message?: { content?: Array<{ type: string; text?: string; thinking?: string }>; stopReason?: string };
          stopReason?: string;
        };
        if (evt.type === 'text_delta') {
          fullContent += evt.delta || '';
        } else if (evt.type === 'thinking_delta') {
          fullThinking += evt.delta || '';
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
            }
          }
        }
      }

      if (errorMsg && !fullContent) {
        return res.status(502).json({
          error: { message: errorMsg, type: 'api_error' },
        });
      }

      // OpenAI-compatible response
      const responseBody: Record<string, unknown> = {
        id: chatId,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: fullContent },
          finish_reason: finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      // Include reasoning/thinking if present (OpenAI o1-style)
      if (fullThinking) {
        (responseBody.choices as Array<Record<string, unknown>>)[0].message = {
          role: 'assistant',
          content: fullContent,
          reasoning_content: fullThinking,
        };
      }

      res.json(responseBody);
    }
  } catch (error: unknown) {
    console.error('Chat error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: { message: errMsg, type: 'api_error' },
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('My Zero Token: http://127.0.0.1:' + PORT);
});
