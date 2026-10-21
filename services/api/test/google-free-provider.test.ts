import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationBroker } from '@oit/core';
import { providerFromEnv } from '../src/provider.ts';

const provider = () => providerFromEnv({ TRANSLATION_PROVIDER: 'google-free' });
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('free Google batches repeated q at a fixed endpoint without credentials or HTML decoding', async context => {
  const requests: { url: URL; headers: Headers; method?: string; queries: string[] }[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(url)), method: init?.method, headers: new Headers(init?.headers), queries: new URLSearchParams(String(init?.body)).getAll('q') });
    return json(['Bonjour ⟪OIT_0⟫ &amp; text', '<em>literal text</em>']);
  });
  const free = provider();
  assert.equal(free.kind, 'google-free'); assert.equal(free.model, 'web-unofficial'); assert.equal(free.configured, true);
  assert.deepEqual(free.batch, { maxSegments: 32, maxCharacters: 12000 });
  assert.deepEqual(await free.translate([{ id: 'a', text: 'Hello ⟪OIT_0⟫ &amp; text' }, { id: 'b', text: 'Second' }], 'en', 'fr', signal()), [{ id: 'a', text: 'Bonjour ⟪OIT_0⟫ &amp; text' }, { id: 'b', text: '<em>literal text</em>' }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url.origin + requests[0]!.url.pathname, 'https://clients5.google.com/translate_a/t');
  assert.deepEqual([...requests[0]!.url.searchParams], [['client', 'dict-chrome-ex'], ['sl', 'en'], ['tl', 'fr']]);
  assert.equal(requests[0]!.method, 'POST');
  assert.deepEqual(requests[0]!.queries, ['Hello ⟪OIT_0⟫ &amp; text', 'Second']);
  assert.deepEqual([...requests[0]!.headers], [['content-type', 'application/x-www-form-urlencoded;charset=UTF-8']]);
});

test('free Google maps Chinese variants and interprets auto language result pairs', async context => {
  const languages: string[][] = [];
  context.mock.method(globalThis, 'fetch', async (url: unknown) => {
    const query = new URL(String(url)).searchParams;
    languages.push([query.get('sl')!, query.get('tl')!]);
    return json(query.get('sl') === 'auto' ? [['你好', 'en']] : ['繁體中文']);
  });
  assert.deepEqual(await provider().translate([{ id: 'a', text: 'Hello' }], 'auto', 'zh-Hans', signal()), [{ id: 'a', text: '你好' }]);
  await provider().translate([{ id: 'a', text: '简体中文' }], 'zh-Hans', 'zh-Hant', signal());
  assert.deepEqual(languages, [['auto', 'zh-CN'], ['zh-CN', 'zh-TW']]);
});

test('free Google short-circuits same-language input without a network request', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Should not fetch'); });
  const segments = [{ id: 'a', text: 'Already translated ⟪OIT_0⟫' }];
  assert.deepEqual(await provider().translate(segments, 'zh-Hans', 'zh-CN', signal()), segments);
  assert.equal(fetch.mock.callCount(), 0);
});

test('free Google broker batches many identified segments and restores code/math/inline tokens', async context => {
  const batches: string[][] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const queries = new URLSearchParams(String(init?.body)).getAll('q'); batches.push(queries);
    return json(queries.map(text => [`Traduit: ${text}`, 'en']));
  });
  const source = 'Keep $E=mc^2$, `code()` and https://example.com. [[OIT_OPEN_0]]Read[[OIT_CLOSE_0]] [[OIT_KEEP_1]]';
  const segments = Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, text: `${i}: ${source}` }));
  const result = await new TranslationBroker(provider()).translate({ segments, targetLanguage: 'fr' });
  assert.deepEqual(batches.map(batch => batch.length), [32, 32, 16]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.results.length, 80);
  assert.equal(result.results[0]!.text, `Traduit: 0: ${source}`);
  assert.equal(result.results[79]!.id, 'p79');
});

for (const [name, envelope] of [
  ['missing list', {}], ['wrong count', []], ['null entry', [null]],
  ['nonstring text', [[42, 'en']]], ['blank text', [['   ', 'en']]],
  ['missing detected language', [['Bonjour']]], ['invalid detected language', [['Bonjour', 42]]],
] as const) {
  test(`free Google rejects ${name} without retry or leaked raw response`, async context => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => json(envelope));
    await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'auto', 'fr', signal()), /unofficial Google free endpoint returned/);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

for (const [name, translated] of [
  ['lost marker', 'Aucun marqueur'], ['duplicated marker', '⟪OIT_0⟫ ⟪OIT_0⟫'],
  ['invented marker', '⟪OIT_0⟫ ⟪OIT_1⟫'], ['malformed marker', '⟪OIT_0⟫ ⟪OIT_broken⟫'],
] as const) {
  test(`free Google rejects ${name}`, async context => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => json([[translated, 'en']]));
    await assert.rejects(() => provider().translate([{ id: 'a', text: 'Keep ⟪OIT_0⟫' }], 'auto', 'fr', signal()), /protected math\/code\/link token/);
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test('free Google never retries rate limiting or forbidden responses and never falls back', async context => {
  let status = 429;
  const fetch = context.mock.method(globalThis, 'fetch', async () => json({ error: 'Private provider diagnostic' }, status));
  await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'fr', signal()), /rate limited/);
  assert.equal(fetch.mock.callCount(), 1); status = 403;
  await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'fr', signal()), /HTTP 403/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('free Google retries one transient server failure then accepts the batch', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? json({}, 503) : json(['Bonjour']));
  assert.deepEqual(await provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'fr', signal()), [{ id: 'a', text: 'Bonjour' }]);
  assert.equal(calls, 2);
});

test('free Google sanitizes transport errors and malformed JSON', async context => {
  let mode = 'network';
  context.mock.method(globalThis, 'fetch', async () => { if (mode === 'network') throw new Error('private request text'); return new Response('private invalid body'); });
  const assertSafe = (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message.includes('private'), false); assert.match(error.message, /unofficial Google free endpoint/); return true; };
  await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'fr', signal()), assertSafe);
  mode = 'json';
  await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'fr', signal()), assertSafe);
});

test('free Google aborts without retry and discards a late ignored-abort response', async context => {
  let release!: (response: Response) => void;
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const pending = provider().translate([{ id: 'a', text: 'Hello' }], 'auto', 'fr', controller.signal);
  controller.abort(new Error('Restored')); release(json([['Bonjour', 'en']]));
  await assert.rejects(() => pending, /Restored/); assert.equal(fetch.mock.callCount(), 1);
});

test('free Google rejects oversized or invalid direct batches before fetching', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => json(['Unused']));
  for (const segments of [
    Array.from({ length: 33 }, (_, i) => ({ id: String(i), text: 'Hello' })),
    [{ id: 'a', text: 'a'.repeat(12001) }],
    [{ id: 'a', text: 'Hello' }, { id: 'a', text: 'Duplicate' }],
    [{ id: 'a', text: '' }],
  ]) await assert.rejects(() => provider().translate(segments, 'auto', 'fr', signal()));
  await assert.rejects(() => provider().translate([{ id: 'a', text: 'Hello' }], 'en', 'auto', signal()), /explicit target/);
  assert.equal(fetch.mock.callCount(), 0);
});
