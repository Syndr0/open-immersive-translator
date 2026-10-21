import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protect, restore, splitText, TranslationBroker, type Provider, type Segment, type TranslationResponse } from '../src/index.ts';

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

test('opt-in batching translates distinct paragraphs in one call with stable IDs and aliases', async () => {
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
    async translate(segments) { calls.push(segments); return segments.map(segment => ({ ...segment, text: `fr: ${segment.text}` })).reverse(); } };
  const broker = new TranslationBroker(provider);
  const segments = ['One `code` paragraph.', 'Second $x$ paragraph.', 'A third paragraph.', 'One `code` paragraph.'].map((text, index) => ({ id: `p${index}`, text }));
  const result = await broker.translate({ segments, targetLanguage: 'fr' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 3);
  assert.deepEqual(result.results.map(({ id, text }) => ({ id, text })), segments.map(segment => ({ ...segment, text: `fr: ${segment.text}` })));
  assert.deepEqual(result.errors, []);
  const cached = await broker.translate({ segments, targetLanguage: 'fr' });
  assert.ok(cached.results.every(result => result.cached));
  assert.equal(calls.length, 1);
});

test('batch character and item budgets preserve long Unicode blocks and protected chunks', async () => {
  const calls: Segment[][] = [];
  let running = 0, peak = 0;
  const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 3, maxCharacters: 100 },
    async translate(segments) {
      calls.push(segments); running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 2)); running--;
      return [...segments].reverse();
    } };
  const long = `${'😀 natural words. '.repeat(20)}keep \`code()\` and $E=mc^2$.`;
  const segments = [{ id: 'long', text: long }, { id: 'alias', text: long }, { id: 'short', text: 'A short paragraph.' }, { id: 'other', text: 'Another paragraph.' }];
  const result = await new TranslationBroker(provider).translate({ segments, targetLanguage: 'fr' });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.results.map(({ id, text }) => ({ id, text })), segments);
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => call.length <= 3 && call.reduce((sum, segment) => sum + segment.text.length, 0) <= 100));
  assert.ok(calls.flat().every(segment => !/^\uDC00|[\uD800-\uDBFF]$/.test(segment.text)));
  assert.equal(new Set(calls.flat().map(segment => segment.id)).size, calls.flat().length);
  assert.equal(calls.flat().some(segment => segment.id.startsWith('alias:')), false);
  assert.equal(peak, 2);
});

test('progress exposes cache hits and out-of-order completions with independent cumulative snapshots', async () => {
  const pending = new Map<string, { finish: () => void }>();
  let gated = false;
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true,
    async translate(segments) {
      if (gated) await new Promise<void>(resolve => { pending.set(segments[0]!.text, { finish: resolve }); });
      return segments.map(segment => ({ ...segment, text: `fr: ${segment.text}` }));
    } };
  const broker = new TranslationBroker(provider);
  await broker.translate({ segments: [{ id: 'warm', text: 'Cached' }], targetLanguage: 'fr' });
  gated = true;
  const snapshots: TranslationResponse[] = [];
  const segments = [{ id: 'slow', text: 'Slow' }, { id: 'cache', text: 'Cached' }, { id: 'fast', text: 'Fast' }, { id: 'alias', text: 'Fast' }, { id: 'blank', text: ' ' }];
  const resultPromise = broker.translate({ segments, targetLanguage: 'fr' }, undefined, snapshot => { snapshots.push(snapshot); });
  assert.deepEqual(snapshots.map(snapshot => snapshot.results.map(result => result.id)), [['cache'], ['cache', 'blank']]);
  snapshots[0]!.results[0]!.text = 'observer mutation';
  snapshots[0]!.results.push({ id: 'injected', text: 'injected' });
  pending.get('Fast')!.finish();
  await new Promise(resolve => setImmediate(resolve));
  const partial = snapshots.at(-1)!;
  assert.deepEqual(partial.results.map(result => result.id), ['cache', 'fast', 'alias', 'blank']);
  assert.equal(partial.results[0]!.text, 'fr: Cached');
  assert.equal(partial.results[0]!.cached, true);
  assert.equal(partial.results[1]!.cached, false);
  assert.notStrictEqual(partial.results[0], snapshots[1]!.results[0]);
  pending.get('Slow')!.finish();
  const result = await resultPromise;
  assert.deepEqual(result.results.map(result => result.id), segments.map(segment => segment.id));
  assert.deepEqual(result.errors, []);
  assert.notStrictEqual(result.results, snapshots.at(-1)!.results);
  assert.deepEqual(snapshots[1]!.results.map(result => result.id), ['cache', 'blank']);
});

test('a marker-invalid batch member fails its aliases while valid peers alone enter cache', async () => {
  let corrupt = true;
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
    async translate(segments) {
      calls.push(segments);
      return segments.map(segment => ({ ...segment, text: corrupt && segment.text.includes('Bad') ? 'Bad missing token' : segment.text }));
    } };
  const broker = new TranslationBroker(provider);
  const request = { segments: [{ id: 'bad', text: 'Bad `code`' }, { id: 'good', text: 'Good $x$' }, { id: 'alias', text: 'Bad `code`' }], targetLanguage: 'fr' };
  const snapshots: TranslationResponse[] = [];
  const first = await broker.translate(request, undefined, snapshot => { snapshots.push(snapshot); });
  assert.deepEqual(first.results.map(result => result.id), ['good']);
  assert.deepEqual(first.errors.map(error => error.id), ['bad', 'alias']);
  assert.ok(first.errors.every(error => /protected/.test(error.message)));
  assert.ok(snapshots.some(snapshot => snapshot.errors.length === 2 && snapshot.results.length === 0));
  assert.equal(calls.length, 1);
  corrupt = false;
  const second = await broker.translate(request);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.results.map(result => result.cached), [false, true, false]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.length, 1);
  assert.ok((await broker.translate(request)).results.every(result => result.cached));
  assert.equal(calls.length, 2);
});

for (const mode of ['missing', 'duplicate', 'unknown'] as const) {
  test(`a ${mode} batch ID set fails the batch without partial cache commits or hidden retries`, async () => {
    let calls = 0;
    const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
      async translate(segments) {
        calls++;
        return mode === 'missing' ? segments.slice(1) : segments.map((segment, index) => ({ ...segment, id: index === 1 ? (mode === 'duplicate' ? segments[0]!.id : 'unknown') : segment.id }));
      } };
    const broker = new TranslationBroker(provider);
    const request = { segments: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], targetLanguage: 'fr' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await broker.translate(request);
      assert.equal(result.results.length, 0);
      assert.deepEqual(result.errors.map(error => error.id), ['a', 'b']);
      assert.ok(result.errors.every(error => /segment IDs/.test(error.message)));
      assert.equal(calls, attempt + 1);
    }
  });
}

test('cancelled batches discard late output and remove queued work without caching aliases', async () => {
  let release!: () => void;
  let first = true;
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 2, maxCharacters: 100 },
    async translate(segments) {
      calls.push(segments);
      if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
      return segments;
    } };
  const broker = new TranslationBroker(provider, undefined, 1);
  const request = { segments: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }, { id: 'alias', text: 'One' }, { id: 'queued', text: 'Three' }], targetLanguage: 'fr' };
  const controller = new AbortController();
  const snapshots: TranslationResponse[] = [];
  const pending = broker.translate(request, controller.signal, snapshot => { snapshots.push(snapshot); });
  controller.abort(new Error('batch cancelled'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(snapshots.some(snapshot => snapshot.errors.some(error => error.id === 'queued')));
  assert.equal(calls.length, 1);
  release();
  const cancelled = await pending;
  assert.deepEqual(cancelled.results, []);
  assert.deepEqual(cancelled.errors.map(error => error.id), request.segments.map(segment => segment.id));
  assert.ok(cancelled.errors.every(error => /batch cancelled/.test(error.message)));
  const recovered = await broker.translate(request);
  assert.deepEqual(recovered.errors, []);
  assert.ok(recovered.results.every(result => result.cached === false));
  assert.equal(calls.length, 3);
});

test('long-block progress waits for every chunk and cancellation keeps only finished peers', async () => {
  let release!: () => void;
  let hold = true;
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'batch', model: 'v1', configured: true, batch: { maxSegments: 2, maxCharacters: 100 },
    async translate(segments) {
      calls.push(segments);
      if (hold && calls.length === 2) await new Promise<void>(resolve => { release = resolve; });
      return segments;
    } };
  const broker = new TranslationBroker(provider);
  const long = 'words '.repeat(45);
  const request = { segments: [{ id: 'short', text: 'Done' }, { id: 'long', text: long }, { id: 'alias', text: long }], targetLanguage: 'fr' };
  const snapshots: TranslationResponse[] = [];
  const controller = new AbortController();
  const pending = broker.translate(request, controller.signal, snapshot => { snapshots.push(snapshot); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshots.at(-1)!.results.map(result => result.id), ['short']);
  controller.abort(new Error('long cancelled')); release();
  const cancelled = await pending;
  assert.deepEqual(cancelled.results.map(result => result.id), ['short']);
  assert.deepEqual(cancelled.errors.map(error => error.id), ['long', 'alias']);
  hold = false;
  const recovered = await broker.translate(request);
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.results.map(result => result.cached), [true, false, false]);
  assert.equal(recovered.results[1]!.text, long);
});

test('progress observer exceptions do not change results or poison cached output', async () => {
  const provider: Provider = { kind: 'fixture', model: 'v1', configured: true, async translate(segments) { return segments; } };
  const broker = new TranslationBroker(provider);
  const request = { segments: [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }], targetLanguage: 'fr' };
  const first = await broker.translate(request, undefined, snapshot => { snapshot.results.length = 0; throw new Error('observer failed'); });
  assert.deepEqual(first.results.map(result => result.text), ['One', 'Two']);
  assert.deepEqual(first.errors, []);
  assert.ok((await broker.translate(request)).results.every(result => result.cached));
});

test('explicit provider errors fail only their aliases while successful peers are cached and failures remain retryable', async () => {
  let unavailable = true;
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'batch-errors', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
    async translate(segments) {
      calls.push(segments);
      return segments.map(segment => unavailable && segment.text.includes('Unavailable')
        ? { id: segment.id, error: 'Fixture translation unavailable.' }
        : { ...segment, text: `fr: ${segment.text}` }).reverse();
    } };
  const broker = new TranslationBroker(provider);
  const request = { segments: [{ id: 'bad', text: 'Unavailable `code` paragraph' }, { id: 'good', text: 'Available $x$ paragraph' }, { id: 'bad-alias', text: 'Unavailable `code` paragraph' }, { id: 'good-alias', text: 'Available $x$ paragraph' }], targetLanguage: 'fr' };
  const snapshots: TranslationResponse[] = [];
  const first = await broker.translate(request, undefined, snapshot => {
    snapshots.push(structuredClone(snapshot));
    if (snapshot.errors[0]) snapshot.errors[0].message = 'observer mutation';
  });
  assert.deepEqual(first.results.map(result => result.id), ['good', 'good-alias']);
  assert.ok(first.results.every(result => result.text === 'fr: Available $x$ paragraph'));
  assert.deepEqual(first.errors, [{ id: 'bad', message: 'Fixture translation unavailable.' }, { id: 'bad-alias', message: 'Fixture translation unavailable.' }]);
  assert.ok(snapshots.some(snapshot => snapshot.errors.length === 2));
  assert.deepEqual(snapshots.at(-1), first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 2);

  const retry = await broker.translate(request);
  assert.deepEqual(retry.results.map(result => result.cached), [true, true]);
  assert.deepEqual(retry.errors, first.errors);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.length, 1);
  assert.match(calls[1]![0]!.text, /Unavailable/);
  unavailable = false;
  const recovered = await broker.translate(request);
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.results.map(result => result.cached), [false, true, false, true]);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.length, 1);
  assert.ok((await broker.translate(request)).results.every(result => result.cached));
  assert.equal(calls.length, 3);
});

test('an explicit failed long chunk cannot cache a partially translated block or its duplicate aliases', async () => {
  let failMiddle = true;
  const calls: Segment[][] = [];
  const provider: Provider = { kind: 'chunk-errors', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
    async translate(segments) {
      calls.push(segments);
      return segments.map(segment => failMiddle && segment.id === 'long:1'
        ? { id: segment.id, error: 'The middle chunk is unavailable.' }
        : { ...segment }).reverse();
    } };
  const broker = new TranslationBroker(provider);
  const long = `${'Long paragraph words. '.repeat(360)}Keep \`code()\` and $E=mc^2$.`;
  const request = { segments: [{ id: 'long', text: long }, { id: 'peer', text: 'A complete peer with `code`.' }, { id: 'alias', text: long }], targetLanguage: 'fr' };
  const snapshots: TranslationResponse[] = [];
  const first = await broker.translate(request, undefined, snapshot => { snapshots.push(snapshot); });
  assert.deepEqual(first.results.map(result => result.id), ['peer']);
  assert.deepEqual(first.errors, [{ id: 'long', message: 'The middle chunk is unavailable.' }, { id: 'alias', message: 'The middle chunk is unavailable.' }]);
  assert.ok(snapshots.every(snapshot => snapshot.results.every(result => !['long', 'alias'].includes(result.id))));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.some(segment => segment.id === 'long:0'));
  assert.ok(calls[0]!.some(segment => segment.id === 'long:2'));
  assert.equal(calls[0]!.some(segment => segment.id.startsWith('alias:')), false);

  failMiddle = false;
  const recovered = await broker.translate(request);
  assert.deepEqual(recovered.errors, []);
  assert.deepEqual(recovered.results.map(result => result.cached), [false, true, false]);
  assert.equal(recovered.results[0]!.text, long);
  assert.equal(recovered.results[2]!.text, long);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.every(segment => segment.id.startsWith('long:')));
  assert.ok(calls[1]!.some(segment => segment.id === 'long:0'), 'successful chunks of a failed original block must also be retried');
  assert.ok((await broker.translate(request)).results.every(result => result.cached));
  assert.equal(calls.length, 2);
});

for (const malformed of [
  { name: 'non-string error', value: { error: 42 } },
  { name: 'blank error', value: { error: ' \n ' } },
  { name: 'null error', value: { error: null } },
  { name: 'both text and error', value: { text: 'Ambiguous success', error: 'Ambiguous failure' } },
] as const) {
  test(`a ${malformed.name} envelope fails atomically before caching a preceding valid peer`, async () => {
    let invalid = true;
    const calls: Segment[][] = [];
    const provider: Provider = { kind: 'malformed-errors', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
      async translate(segments) {
        calls.push(segments);
        return segments.map((segment, index) => invalid && index === 1 ? { id: segment.id, ...malformed.value } : { ...segment }) as unknown as Awaited<ReturnType<Provider['translate']>>;
      } };
    const broker = new TranslationBroker(provider);
    const request = { segments: [{ id: 'valid-first', text: 'Valid peer `code`' }, { id: 'invalid-second', text: 'Invalid peer $x$' }], targetLanguage: 'fr' };
    const result = await broker.translate(request);
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.errors.map(error => error.id), ['valid-first', 'invalid-second']);
    assert.equal(calls.length, 1, 'malformed output must not trigger hidden retries');
    invalid = false;
    const recovered = await broker.translate(request);
    assert.deepEqual(recovered.errors, []);
    assert.deepEqual(recovered.results.map(result => result.cached), [false, false]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.length, 2, 'the earlier valid peer must not have entered cache from the malformed batch');
    assert.ok((await broker.translate(request)).results.every(result => result.cached));
    assert.equal(calls.length, 2);
  });
}

test('explicit error entries still require the exact unique batch ID set', async () => {
  for (const wrongId of ['unknown', 'duplicate']) {
    let invalid = true, calls = 0;
    const provider: Provider = { kind: 'wrong-error-id', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
      async translate(segments) {
        calls++;
        return invalid ? [{ ...segments[0]! }, { id: wrongId === 'unknown' ? 'not-requested' : segments[0]!.id, error: 'Unavailable' }] : segments;
      } };
    const broker = new TranslationBroker(provider);
    const request = { segments: [{ id: 'a', text: 'First' }, { id: 'b', text: 'Second' }], targetLanguage: 'fr' };
    const result = await broker.translate(request);
    assert.deepEqual(result.results, []);
    assert.deepEqual(result.errors.map(error => error.id), ['a', 'b']);
    assert.equal(calls, 1);
    invalid = false;
    const recovered = await broker.translate(request);
    assert.ok(recovered.results.every(result => result.cached === false));
    assert.equal(calls, 2);
  }
});

test('cancellation discards late explicit failures and successful peers without caching either', async () => {
  let release!: () => void;
  let first = true, calls = 0;
  const provider: Provider = { kind: 'cancel-errors', model: 'v1', configured: true, batch: { maxSegments: 8, maxCharacters: 12_000 },
    async translate(segments) {
      calls++;
      if (first) {
        first = false;
        await new Promise<void>(resolve => { release = resolve; });
        return [{ ...segments[0]! }, { id: segments[1]!.id, error: 'Late provider failure' }];
      }
      return segments;
    } };
  const broker = new TranslationBroker(provider);
  const request = { segments: [{ id: 'good', text: 'Good paragraph' }, { id: 'bad', text: 'Unavailable paragraph' }], targetLanguage: 'fr' };
  const controller = new AbortController();
  const pending = broker.translate(request, controller.signal);
  controller.abort(new Error('Request cancelled before provider completion')); release();
  const result = await pending;
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.errors.map(error => error.id), ['good', 'bad']);
  assert.ok(result.errors.every(error => /cancelled before provider completion/.test(error.message)));
  const recovered = await broker.translate(request);
  assert.deepEqual(recovered.errors, []);
  assert.ok(recovered.results.every(result => result.cached === false));
  assert.equal(calls, 2);
});
