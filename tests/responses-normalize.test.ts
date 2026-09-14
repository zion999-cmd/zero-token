import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeResponsesInput,
  normalizeResponsesTools,
  resolveTerminalStatus,
} from '../src/responses-api.js';

// ── Fix #1: standard Responses input_image (image_url as a bare string) ──

test('input_image accepts standard Responses string image_url (URL)', () => {
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
  const parts = msgs[0].content as Array<Record<string, unknown>>;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
});

test('input_image accepts standard Responses string image_url (data URI)', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  const msgs = normalizeResponsesInput([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: dataUri }],
    },
  ]);
  const parts = msgs[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(parts[0], { type: 'image_url', image_url: { url: dataUri } });
});

test('input_image still tolerates chat-style nested image_url:{url}', () => {
  const msgs = normalizeResponsesInput([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } }],
    },
  ]);
  const parts = msgs[0].content as Array<Record<string, unknown>>;
  assert.deepEqual(parts[0], { type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } });
});

// ── Fix #2: developer role maps to system, never downgraded to user ──

test('developer role folds into system messages', () => {
  const msgs = normalizeResponsesInput([
    { type: 'message', role: 'developer', content: 'Always answer JSON' },
    { role: 'developer', content: [{ type: 'text', text: 'Be terse' }] },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'Always answer JSON');
  assert.equal(msgs[1].role, 'system');
  assert.equal(msgs[1].content, 'Be terse');
});

test('explicit system role still maps to system', () => {
  const msgs = normalizeResponsesInput([{ role: 'system', content: 'hi' }]);
  assert.equal(msgs[0].role, 'system');
});

// ── Fix #5: function_call_output array extracts text, no protocol noise ──

test('function_call_output array yields joined text parts', () => {
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
  const block = (msgs[0].content as Array<Record<string, unknown>>)[0];
  const textPart = (block.content as Array<Record<string, unknown>>)[0];
  assert.equal(textPart.text, 'weather: sunny\ntemp: -3');
});

test('function_call_output string passes through', () => {
  const msgs = normalizeResponsesInput([
    { type: 'function_call_output', call_id: 'c2', output: '{"temp":-3}' },
  ]);
  const block = (msgs[0].content as Array<Record<string, unknown>>)[0];
  assert.equal(block.tool_use_id, 'c2');
  assert.equal((block.content as Array<Record<string, unknown>>)[0].text, '{"temp":-3}');
});

test('function_call_output image-only array falls back to JSON (never empty)', () => {
  const out = [{ type: 'input_image', image_url: 'data:image/png;base64,xx' }];
  const msgs = normalizeResponsesInput([
    { type: 'function_call_output', call_id: 'c3', output: out },
  ]);
  const block = (msgs[0].content as Array<Record<string, unknown>>)[0];
  assert.equal((block.content as Array<Record<string, unknown>>)[0].text, JSON.stringify(out));
});

// ── Fix #3/#4: EOF without done is incomplete, not completed ──

test('resolveTerminalStatus: done → completed, missing done → incomplete', () => {
  assert.equal(resolveTerminalStatus(true, false), 'completed');
  assert.equal(resolveTerminalStatus(false, false), 'incomplete');
  assert.equal(resolveTerminalStatus(true, true), 'incomplete');
});

// ── Existing behavior regression: function_call / reasoning / hosted tools ──

test('function_call item becomes assistant tool_use block with call_id', () => {
  const msgs = normalizeResponsesInput([
    { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"北京"}' },
  ]);
  assert.equal(msgs[0].role, 'assistant');
  const block = (msgs[0].content as Array<Record<string, unknown>>)[0];
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'call_9');
  assert.equal(block.name, 'get_weather');
  assert.deepEqual(block.input, { city: '北京' });
});

test('malformed arguments do not fabricate a raw parameter', () => {
  const msgs = normalizeResponsesInput([
    { type: 'function_call', call_id: 'x', name: 'f', arguments: 'not-json' },
  ]);
  const block = (msgs[0].content as Array<Record<string, unknown>>)[0];
  assert.deepEqual(block.input, { __responses_raw_arguments: 'not-json' });
});

test('reasoning items are dropped', () => {
  const msgs = normalizeResponsesInput([
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hmm' }] },
    { type: 'message', role: 'user', content: 'hi' },
  ]);
  assert.equal(msgs.length, 1);
  assert.equal((msgs[0].content as Array<Record<string, unknown>>)[0].text, 'hi');
});

test('hosted tools are stripped; flat and nested function defs accepted', () => {
  const tools = normalizeResponsesTools([
    { type: 'web_search' },
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } },
    { type: 'function', function: { name: 'g', description: 'd2' } },
  ]);
  assert.equal(tools.length, 2);
  assert.equal((tools[0].function as Record<string, unknown>).name, 'f');
  assert.equal((tools[1].function as Record<string, unknown>).name, 'g');
});
