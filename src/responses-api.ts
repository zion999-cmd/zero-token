import type { Request, Response } from 'express';
import { getWebStreamFactory } from './streams/web-stream-factories.js';
import { runWithLimit, ShedLoad } from './concurrency-limiter.js';
import { getConversationKey } from './conversation-key.js';

// ── Types ─────────────────────────────────────────────

type Json = Record<string, unknown>;

interface InternalMessage {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
}

interface CollectedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface HandlerDeps {
  getCookieForProvider: (apiId: string) => string;
  logRequest: (entry: Json) => void;
}

// ── Request normalization (pure) ──────────────────────

/** Parse a function-call arguments string without inventing fake parameters. */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    // Non-object or malformed JSON: preserve verbatim under a reserved key that
    // cannot collide with a real function parameter.
    return { __responses_raw_arguments: raw };
  } catch {
    return { __responses_raw_arguments: raw };
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : ((p as Json)?.text as string) ?? ''))
      .join('');
  }
  return '';
}

/**
 * Flatten a function_call_output `output` to text the model can read.
 * Strings pass through; content arrays contribute their text parts (image /
 * file parts have no textual channel yet and are dropped); anything else is
 * JSON-stringified so we never feed raw protocol-object noise verbatim.
 */
function toolOutputToText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const texts = output
      .map((p) => {
        if (typeof p === 'string') return p;
        const part = (p ?? {}) as Json;
        return typeof part.text === 'string' &&
          (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text' || part.type === undefined)
          ? part.text
          : '';
      })
      .filter((t) => t !== '');
    // No extractable text (e.g. image/file-only result): preserve the payload
    // rather than feeding the model an empty tool result.
    return texts.length > 0 ? texts.join('\n') : JSON.stringify(output ?? '');
  }
  return JSON.stringify(output ?? '');
}

/**
 * Convert Responses `input` (string | item array) into the Anthropic/pi-ai
 * block shapes the tool middleware actually understands (tool_use /
 * tool_result). Also tolerates OpenAI chat-format items (role:'tool',
 * assistant.tool_calls).
 */
export function normalizeResponsesInput(input: unknown): InternalMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (!Array.isArray(input)) return [];

  const out: InternalMessage[] = [];
  for (const rawItem of input) {
    const item = (rawItem ?? {}) as Json;

    // Responses function_call → assistant tool_use block
    if (item.type === 'function_call') {
      out.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          input: parseToolArguments(String(item.arguments ?? '{}')),
        }],
      });
      continue;
    }

    // Responses function_call_output → user tool_result block
    if (item.type === 'function_call_output') {
      const output = toolOutputToText(item.output);
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.call_id ?? ''),
          content: [{ type: 'text', text: output }],
        }],
      });
      continue;
    }

    // Reasoning items are intentionally dropped (no reasoning passthrough).
    if (item.type === 'reasoning') continue;

    const role = typeof item.role === 'string' ? item.role : 'user';

    // Chat-format assistant tool_calls (tolerated input)
    if (role === 'assistant' && Array.isArray(item.tool_calls)) {
      const blocks: Json[] = (item.tool_calls as Json[])
        .filter((tc) => tc?.type === 'function')
        .map((tc): Json => {
          const fn = (tc.function ?? {}) as Json;
          return {
            type: 'tool_use',
            id: String(tc.id ?? ''),
            name: String(fn.name ?? ''),
            input: parseToolArguments(String(fn.arguments ?? '{}')),
          };
        });
      const text = textOfContent(item.content);
      if (text) blocks.unshift({ type: 'text', text });
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // Chat-format tool result message (tolerated input)
    if (role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.tool_call_id ?? ''),
          content: [{ type: 'text', text: textOfContent(item.content) }],
        }],
      });
      continue;
    }

    // Regular message item (Responses typed or bare chat shape)
    const parts: Json[] = [];
    const content = item.content;
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const rawPart of content) {
        const part = (rawPart ?? {}) as Json;
        const pt = part.type;
        if (pt === 'input_text' || pt === 'output_text' || pt === 'text') {
          if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
        } else if (pt === 'input_image' || pt === 'image_url') {
          // Only the last user turn's images survive the middleware pipeline.
          // Standard Responses form: image_url is a bare string (URL or data
          // URI). Chat-completions form {image_url:{url}} is also tolerated.
          const rawUrl = part.image_url;
          const url =
            typeof rawUrl === 'string'
              ? rawUrl
              : typeof (rawUrl as Json)?.url === 'string'
                ? ((rawUrl as Json).url as string)
                : typeof part.image === 'string'
                  ? part.image
                  : '';
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
        // Unknown part types are ignored.
      }
    }

    if (parts.length === 0) continue;
    if (role === 'assistant') {
      out.push({ role: 'assistant', content: parts });
    } else if (role === 'system' || role === 'developer') {
      // Responses 'developer' is an instruction-tier role; fold into system.
      out.push({ role: 'system', content: parts.map((p) => p.text).join('\n') });
    } else {
      out.push({ role: 'user', content: parts });
    }
  }
  return out;
}

/** Keep only function tools; hosted tools (web_search, …) are silently dropped. */
export function normalizeResponsesTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const raw of tools) {
    const t = (raw ?? {}) as Json;
    if (t.type !== 'function') continue;
    const nested = (t.function ?? null) as Json | null;
    const def = nested ?? t; // accept both nested and flat definitions
    if (typeof def.name !== 'string') continue;
    out.push({
      type: 'function',
      function: {
        name: def.name,
        description: typeof def.description === 'string' ? def.description : '',
        parameters: (def.parameters as Json) ?? { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

/** Fold any system-role input items into the instructions/system prompt. */
function extractSystemPrompt(instructions: unknown, messages: InternalMessage[]): string {
  let prompt = typeof instructions === 'string' ? instructions : '';
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : textOfContent(m.content);
      prompt = prompt ? `${prompt}\n${text}` : text;
    }
  }
  return prompt;
}

// ── Response object factory (single source of truth) ──

interface ResponseInit {
  id: string;
  createdAt: number;
  model: string;
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete';
  output?: Json[];
  error?: { code: string; message: string } | null;
  incompleteDetails?: { reason: string } | null;
}

/**
 * Terminal status from upstream evidence. A stream EOF without an explicit
 * `done` event is NOT a successful completion — report incomplete instead of
 * fabricating success.
 */
export function resolveTerminalStatus(sawDone: boolean, failed: boolean): 'completed' | 'incomplete' {
  return sawDone && !failed ? 'completed' : 'incomplete';
}

function buildResponseObject(init: ResponseInit): Json {
  return {
    id: init.id,
    object: 'response',
    created_at: init.createdAt,
    status: init.status,
    model: init.model,
    output: init.output ?? [],
    // Compatibility fields — declare the gateway's real (stateless) behavior.
    error: init.error ?? null,
    incomplete_details: init.incompleteDetails ?? null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    tool_choice: 'auto',
    tools: [],
    metadata: {},
    // Unknown usage is null — never fabricated zeros.
    usage: null,
  };
}

function messageOutputItem(itemId: string, text: string): Json {
  return {
    type: 'message',
    id: itemId,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function functionCallOutputItem(itemId: string, tc: CollectedToolCall): Json {
  return {
    type: 'function_call',
    id: itemId,
    call_id: tc.id,
    name: tc.name,
    arguments: JSON.stringify(tc.arguments),
    status: 'completed',
  };
}

// ── Handler ───────────────────────────────────────────

export function createResponsesHandler(deps: HandlerDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Json;
    const model = typeof body.model === 'string' ? body.model : '';
    const stream = body.stream === true;
    const respId = `resp_${Date.now().toString(36)}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const t0 = Date.now();

    if (!model) {
      res.status(400).json({
        error: { message: 'model is required', type: 'invalid_request_error', param: 'model', code: 'missing_model' },
      });
      return;
    }

    const apiId = model.split('/')[0];
    const factory = getWebStreamFactory(apiId);
    if (!factory) {
      res.status(400).json({
        error: { message: `Unknown model: ${model}`, type: 'invalid_request_error', param: 'model', code: 'invalid_model' },
      });
      return;
    }

    let cookie = (req.headers['x-cookie'] as string) || (typeof body.cookie === 'string' ? body.cookie : '');
    if (!cookie) cookie = deps.getCookieForProvider(apiId);
    if (!cookie) {
      res.status(400).json({
        error: { message: 'Run ./onboard.sh to authorize', type: 'invalid_request_error', param: null, code: 'authentication_required' },
      });
      return;
    }

    const internalMsgs = normalizeResponsesInput(body.input);
    const tools = normalizeResponsesTools(body.tools);
    const systemPrompt = extractSystemPrompt(body.instructions, internalMsgs);
    const conversationMessages = internalMsgs.filter((m) => m.role !== 'system') as Array<{
      role: 'user' | 'assistant';
      content: unknown;
    }>;

    const context = {
      messages: conversationMessages,
      tools,
      sessionId: `conv_${getConversationKey(conversationMessages, systemPrompt)}`,
      hasSessionId: false,
      systemPrompt,
    };
    const modelArg = { api: apiId, provider: apiId, id: model };

    deps.logRequest({
      event: 'req', id: respId, model: apiId, api: 'responses',
      msgs: conversationMessages.length, stream, tools: tools.length,
    });

    try {
      const streamFn = factory(cookie);
      const upstream = await runWithLimit(apiId, undefined, () =>
        // Casts mirror the existing chat/messages adapters (pi-ai generic Model<Api>).
        Promise.resolve(streamFn(modelArg as never, context as never, {})));
      if (upstream === ShedLoad) {
        deps.logRequest({ event: 'shed', id: respId, api: 'responses' });
        req.destroy();
        return;
      }

      if (stream) {
        await streamResponse(req, res, {
          upstream: upstream as AsyncIterable<Json>,
          respId, createdAt, model, deps, t0,
        });
      } else {
        await collectResponse(res, {
          upstream: upstream as AsyncIterable<Json>,
          respId, createdAt, model, deps, t0,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Responses API error:', error);
      // Pre-stream failure → HTTP error envelope, never a 200 with status:failed.
      if (!res.headersSent) {
        res.status(502).json({ error: { message, type: 'api_error', param: null } });
      }
      deps.logRequest({ event: 'error', id: respId, api: 'responses', ms: Date.now() - t0, message });
    }
  };
}

// ── Non-streaming ─────────────────────────────────────

interface RunParams {
  upstream: AsyncIterable<Json>;
  respId: string;
  createdAt: number;
  model: string;
  deps: HandlerDeps;
  t0: number;
}

async function collectResponse(res: Response, params: RunParams): Promise<void> {
  const { upstream, respId, createdAt, model, deps } = params;
  let fullText = '';
  const toolCalls: CollectedToolCall[] = [];
  let errorMsg = '';
  let sawDone = false;

  for await (const evt of upstream) {
    if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
      fullText += evt.delta;
      // thinking_delta is deliberately dropped
    } else if (evt.type === 'toolcall_end' && evt.toolCall) {
      const tc = evt.toolCall as CollectedToolCall;
      toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments ?? {} });
    } else if (evt.type === 'error') {
      const err = (evt.error ?? {}) as Json;
      errorMsg = (err.errorMessage as string) || (evt.reason as string) || 'Upstream stream error';
    } else if (evt.type === 'done') {
      sawDone = true;
    }
  }

  if (errorMsg && !fullText && toolCalls.length === 0) {
    res.status(502).json({ error: { message: errorMsg, type: 'api_error', param: null } });
    return;
  }

  const output: Json[] = [];
  if (fullText) {
    output.push(messageOutputItem(`msg_${Date.now().toString(36)}`, fullText));
  }
  toolCalls.forEach((tc, i) => {
    output.push(functionCallOutputItem(`fc_${i}_${Date.now().toString(36)}`, tc));
  });

  // EOF without an explicit done event is an uncertain termination, not success.
  const status = resolveTerminalStatus(sawDone, false);
  if (status === 'incomplete') {
    deps.logRequest({ event: 'upstream_eof_without_done', id: respId, api: 'responses' });
  }
  const response = buildResponseObject({
    id: respId, createdAt, model, status, output,
    incompleteDetails: status === 'incomplete' ? { reason: 'upstream_ended' } : null,
  });
  deps.logRequest({ event: 'res', id: respId, api: 'responses', ms: Date.now() - params.t0, tools: toolCalls.length, status });
  res.json(response);
}

// ── Streaming ─────────────────────────────────────────

async function streamResponse(req: Request, res: Response, params: RunParams): Promise<void> {
  const { upstream, respId, createdAt, model, deps } = params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let seq = 0;
  const emit = (type: string, data: Json): void => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  };

  const initialResponse = buildResponseObject({ id: respId, createdAt, model, status: 'in_progress' });
  emit('response.created', { response: initialResponse });
  emit('response.in_progress', { response: initialResponse });

  let outputIndex = -1;
  let textOpen = false;
  let textItemId = '';
  let textBuffer = '';
  const finalizedOutput: Json[] = [];
  let streamDone = false;
  let failed = false;

  const ensureTextItem = (): void => {
    if (textOpen) return;
    outputIndex++;
    textItemId = `msg_${Date.now().toString(36)}_${outputIndex}`;
    textOpen = true;
    textBuffer = '';
    emit('response.output_item.added', {
      output_index: outputIndex,
      item: { type: 'message', id: textItemId, status: 'in_progress', role: 'assistant', content: [] },
    });
    emit('response.content_part.added', {
      item_id: textItemId, output_index: outputIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const closeTextItem = (): void => {
    if (!textOpen) return;
    emit('response.output_text.done', {
      item_id: textItemId, output_index: outputIndex, content_index: 0, text: textBuffer,
    });
    emit('response.content_part.done', {
      item_id: textItemId, output_index: outputIndex, content_index: 0,
      part: { type: 'output_text', text: textBuffer, annotations: [] },
    });
    const item = messageOutputItem(textItemId, textBuffer);
    finalizedOutput.push(item);
    emit('response.output_item.done', { output_index: outputIndex, item });
    textOpen = false;
  };

  const emitFunctionCall = (tc: CollectedToolCall): void => {
    closeTextItem();
    outputIndex++;
    const itemId = `fc_${outputIndex}_${Date.now().toString(36)}`;
    const argsJson = JSON.stringify(tc.arguments);
    const inProgress: Json = {
      type: 'function_call', id: itemId, call_id: tc.id, name: tc.name,
      arguments: '', status: 'in_progress',
    };
    emit('response.output_item.added', { output_index: outputIndex, item: inProgress });
    // One complete arguments delta is protocol-valid; do not fabricate fake chunks.
    emit('response.function_call_arguments.delta', {
      item_id: itemId, output_index: outputIndex, delta: argsJson,
    });
    emit('response.function_call_arguments.done', {
      item_id: itemId, output_index: outputIndex, arguments: argsJson,
    });
    const done = { ...inProgress, arguments: argsJson, status: 'completed' };
    finalizedOutput.push(done);
    emit('response.output_item.done', { output_index: outputIndex, item: done });
  };

  try {
    for await (const evt of upstream) {
      // NOTE: req.destroyed is true right after body parsing even on a live
      // keep-alive socket — it does NOT mean the client left. Use res.destroyed.
      if (res.destroyed) return;

      if (evt.type === 'text_delta' && typeof evt.delta === 'string') {
        ensureTextItem();
        textBuffer += evt.delta;
        emit('response.output_text.delta', {
          item_id: textItemId, output_index: outputIndex, content_index: 0, delta: evt.delta,
        });
        // thinking_delta is dropped; toolcall_start/delta are not reliable upstream.
      } else if (evt.type === 'toolcall_end' && evt.toolCall) {
        const tc = evt.toolCall as CollectedToolCall;
        emitFunctionCall({ id: tc.id, name: tc.name, arguments: tc.arguments ?? {} });
      } else if (evt.type === 'error') {
        const err = (evt.error ?? {}) as Json;
        const message = (err.errorMessage as string) || (evt.reason as string) || 'Upstream stream error';
        failed = true;
        closeTextItem();
        const failedResponse = buildResponseObject({
          id: respId, createdAt, model, status: 'failed',
          output: finalizedOutput, error: { code: 'upstream_error', message },
        });
        emit('response.failed', { response: failedResponse });
        break;
      } else if (evt.type === 'done') {
        streamDone = true;
      }
    }

    if (!failed) {
      closeTextItem();
      // EOF without an explicit done event is an uncertain termination.
      const status = resolveTerminalStatus(streamDone, false);
      const terminal = buildResponseObject({
        id: respId, createdAt, model, status, output: finalizedOutput,
        incompleteDetails: status === 'incomplete' ? { reason: 'upstream_ended' } : null,
      });
      if (status === 'incomplete') {
        deps.logRequest({ event: 'upstream_eof_without_done', id: respId, api: 'responses' });
        emit('response.incomplete', { response: terminal });
      } else {
        emit('response.completed', { response: terminal });
      }
    }
  } finally {
    deps.logRequest({
      event: 'res', id: respId, api: 'responses', stream: true,
      ms: Date.now() - params.t0, items: finalizedOutput.length, failed,
    });
    res.end();
  }
}
