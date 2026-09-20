import { describe, expect, it } from 'vitest';
import {
  normalizeResponsesInput,
  normalizeResponsesTools,
  resolveTerminalStatus,
} from '../src/responses-api.js';

/** Narrow an internal message's content to its part array for assertions. */
function partsOf(message: { content: unknown }): Array<Record<string, unknown>> {
  return message.content as Array<Record<string, unknown>>;
}

describe('normalizeResponsesInput — images', () => {
  it('accepts the standard Responses shape (image_url as a bare string URL)', () => {
    const msgs = normalizeResponsesInput([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what color?' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
        ],
      },
    ]);
    const parts = partsOf(msgs[0]);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/a.png' },
    });
  });

  it('accepts the standard Responses shape with a data URI', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    const msgs = normalizeResponsesInput([
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: dataUri }] },
    ]);
    expect(partsOf(msgs[0])[0]).toEqual({ type: 'image_url', image_url: { url: dataUri } });
  });

  it('still tolerates the chat-completions shape (image_url.url)', () => {
    const msgs = normalizeResponsesInput([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } }],
      },
    ]);
    expect(partsOf(msgs[0])[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/b.jpg' },
    });
  });
});

describe('normalizeResponsesInput — roles', () => {
  it('folds developer into the system/instructions tier', () => {
    const msgs = normalizeResponsesInput([
      { type: 'message', role: 'developer', content: 'Always answer JSON' },
      { role: 'developer', content: [{ type: 'text', text: 'Be terse' }] },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe('Always answer JSON');
    expect(msgs[1].role).toBe('system');
    expect(msgs[1].content).toBe('Be terse');
  });

  it('never downgrades developer to a user message', () => {
    const msgs = normalizeResponsesInput([{ role: 'developer', content: 'instruction' }]);
    expect(msgs[0].role).not.toBe('user');
  });

  it('maps an explicit system role to system', () => {
    const msgs = normalizeResponsesInput([{ role: 'system', content: 'hi' }]);
    expect(msgs[0].role).toBe('system');
  });
});

describe('normalizeResponsesInput — function_call_output', () => {
  it('extracts text parts from a content array instead of JSON noise', () => {
    const msgs = normalizeResponsesInput([
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [
          { type: 'input_text', text: 'weather: sunny' },
          { type: 'input_image', image_url: 'data:image/png;base64,xx' },
          { type: 'output_text', text: 'temp: -3' },
        ],
      },
    ]);
    const block = partsOf(msgs[0])[0];
    const textPart = partsOf({ content: block.content })[0];
    expect(textPart.text).toBe('weather: sunny\ntemp: -3');
  });

  it('passes a string output through unchanged and keeps call_id', () => {
    const msgs = normalizeResponsesInput([
      { type: 'function_call_output', call_id: 'c2', output: '{"temp":-3}' },
    ]);
    const block = partsOf(msgs[0])[0];
    expect(block.tool_use_id).toBe('c2');
    expect(partsOf({ content: block.content })[0].text).toBe('{"temp":-3}');
  });

  it('falls back to JSON for image-only output (never an empty tool result)', () => {
    const output = [{ type: 'input_image', image_url: 'data:image/png;base64,xx' }];
    const msgs = normalizeResponsesInput([
      { type: 'function_call_output', call_id: 'c3', output },
    ]);
    const block = partsOf(msgs[0])[0];
    expect(partsOf({ content: block.content })[0].text).toBe(JSON.stringify(output));
  });
});

describe('resolveTerminalStatus', () => {
  it('reports completed only when the upstream emitted done', () => {
    expect(resolveTerminalStatus(true, false)).toBe('completed');
  });

  it('reports incomplete when the stream ended without done', () => {
    expect(resolveTerminalStatus(false, false)).toBe('incomplete');
  });

  it('reports incomplete when the stream failed', () => {
    expect(resolveTerminalStatus(true, true)).toBe('incomplete');
  });
});

describe('normalizeResponsesInput — function calls', () => {
  it('maps function_call to an assistant tool_use block carrying call_id', () => {
    const msgs = normalizeResponsesInput([
      {
        type: 'function_call',
        call_id: 'call_9',
        name: 'get_weather',
        arguments: '{"city":"北京"}',
      },
    ]);
    expect(msgs[0].role).toBe('assistant');
    const block = partsOf(msgs[0])[0];
    expect(block.type).toBe('tool_use');
    expect(block.id).toBe('call_9');
    expect(block.name).toBe('get_weather');
    expect(block.input).toEqual({ city: '北京' });
  });

  it('degrades malformed arguments without fabricating a real parameter', () => {
    const msgs = normalizeResponsesInput([
      { type: 'function_call', call_id: 'x', name: 'f', arguments: 'not-json' },
    ]);
    expect(partsOf(msgs[0])[0].input).toEqual({
      __responses_raw_arguments: 'not-json',
    });
  });
});

describe('normalizeResponsesInput — misc items', () => {
  it('drops reasoning items', () => {
    const msgs = normalizeResponsesInput([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hmm' }] },
      { type: 'message', role: 'user', content: 'hi' },
    ]);
    expect(msgs).toHaveLength(1);
    expect(partsOf(msgs[0])[0].text).toBe('hi');
  });
});

describe('normalizeResponsesTools', () => {
  it('strips hosted tools and accepts flat and nested function definitions', () => {
    const tools = normalizeResponsesTools([
      { type: 'web_search' },
      { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } },
      { type: 'function', function: { name: 'g', description: 'd2' } },
    ]);
    expect(tools).toHaveLength(2);
    expect((tools[0].function as Record<string, unknown>).name).toBe('f');
    expect((tools[1].function as Record<string, unknown>).name).toBe('g');
  });
});
