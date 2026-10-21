import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protect, restore, splitText, TranslationBroker, type Provider } from '../src/index.ts';

test('protected code, math, links and extension identities survive valid output', () => {
  const source = 'Read [[OIT_OPEN_0]]this[[OIT_CLOSE_0]] and `x=1`, $a+b$, https://example.test/a.';
  const encoded = protect(source);
  assert.equal(restore(encoded.text, encoded), source);
  assert.throws(() => restore(encoded.text.replace('⟪OIT_0⟫', ''), encoded), /protected/);
  assert.throws(() => restore(`${encoded.text} ⟪OIT_0⟫`, encoded), /protected/);
});

test('long strings split losslessly without cutting protected IDs or Unicode pairs', () => {
  const source = `${'hello '.repeat(20)}⟪OIT_123⟫${'😀 text '.repeat(20)}`;
  const parts = splitText(source, 35);
  assert.equal(parts.join(''), source);
  assert.ok(parts.every(part => !/^\uDE00|\uD83D$/.test(part)));
  assert.equal(parts.filter(part => part.includes('⟪OIT_123⟫')).length, 1);
});

test('cache is keyed by target language and provider output is associated with original IDs', async () => {
  let calls = 0;
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true,
    async translate(segments, _source, target) { calls++; return segments.map(s => ({ ...s, text: `${target}: ${s.text}` })); } };
  const broker = new TranslationBroker(provider);
  const request = { segments: [{ id: 'a', text: 'hello $x$' }], targetLanguage: 'fr' };
  const first = await broker.translate(request);
  assert.equal(first.results[0]?.text, 'fr: hello $x$');
  assert.equal((await broker.translate(request)).results[0]?.cached, true);
  await broker.translate({ ...request, targetLanguage: 'de' });
  assert.equal(calls, 2);
});

test('corrupt provider IDs and protected tokens fail without entering cache', async () => {
  const provider: Provider = { kind: 'bad', model: 'v1', configured: true,
    async translate(segments) { return [{ id: segments[0]!.id, text: 'lost the placeholder' }]; } };
  const result = await new TranslationBroker(provider).translate({ segments: [{ id: 'a', text: 'keep `code`' }], targetLanguage: 'fr' });
  assert.equal(result.results.length, 0); assert.match(result.errors[0]!.message, /protected/);
  await assert.rejects(() => new TranslationBroker(provider).translate({ segments: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }], targetLanguage: 'fr' }), /unique/);
});

test('concurrency permits are released after errors and cancellation does not commit', async () => {
  let running = 0, peak = 0;
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true,
    async translate(segments) {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5)); running--;
      if (segments[0]!.text === 'fail') throw new Error('fixture failure');
      return segments;
    } };
  const broker = new TranslationBroker(provider, undefined, 2);
  const result = await broker.translate({ segments: ['fail', 'okay', 'again'].map((text, i) => ({ id: String(i), text })), targetLanguage: 'fr' });
  assert.equal(peak, 2); assert.equal(result.results.length, 2); assert.equal(result.errors.length, 1);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  assert.match((await broker.translate({ segments: [{ id: 'last', text: 'late' }], targetLanguage: 'fr' }, controller.signal)).errors[0]!.message, /cancelled/);
});

test('duplicate text shares work within a request without merging segment identities', async () => {
  let calls = 0;
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true,
    async translate(segments) { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return segments; } };
  const broker = new TranslationBroker(provider);
  const result = await broker.translate({ segments: [{ id: 'a', text: 'Repeated paragraph' }, { id: 'b', text: 'Repeated paragraph' }], targetLanguage: 'fr' });
  assert.equal(calls, 1);
  assert.deepEqual(result.results.map(item => item.id), ['a', 'b']);
});

test('aborting a queued request removes it without waiting for an occupied permit', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true,
    async translate(segments) { calls.push(segments[0]!.text); if (calls.length === 1) { started(); await gate; } return segments; } };
  const broker = new TranslationBroker(provider, undefined, 1);
  const first = broker.translate({ segments: [{ id: 'first', text: 'Occupied' }], targetLanguage: 'fr' });
  await ready;
  const controller = new AbortController();
  const second = broker.translate({ segments: [{ id: 'second', text: 'Cancelled' }], targetLanguage: 'fr' }, controller.signal);
  controller.abort(new Error('cancelled while queued'));
  const cancelled = await second;
  assert.match(cancelled.errors[0]!.message, /cancelled while queued/);
  release(); await first;
  const third = await broker.translate({ segments: [{ id: 'third', text: 'Next' }], targetLanguage: 'fr' });
  assert.equal(third.errors.length, 0);
  assert.deepEqual(calls, ['Occupied', 'Next']);
});
