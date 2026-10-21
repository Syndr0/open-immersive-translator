import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationBroker } from '@oit/core';
import { providerFromEnv } from '../src/provider.ts';

const API_KEY = 'test-only-google-key';
const google = (key: string | undefined = API_KEY) => providerFromEnv({ TRANSLATION_PROVIDER: 'google', GOOGLE_TRANSLATE_API_KEY: key });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const valid = (translatedText = 'Bonjour') => ({ data: { translations: [{ translatedText }] } });
const signal = () => new AbortController().signal;

test('Google requires a configured key and never makes an unauthenticated request', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('A request must not be made'); });
  for (const key of [undefined, '', '   ']) {
    const provider = providerFromEnv({ TRANSLATION_PROVIDER: 'google', GOOGLE_TRANSLATE_API_KEY: key });
    assert.equal(provider.kind, 'google');
    assert.equal(provider.model, 'nmt');
    assert.equal(provider.configured, false);
    await assert.rejects(() => provider.translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), /Set GOOGLE_TRANSLATE_API_KEY on the server/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('Google uses the fixed official endpoint, header key, ordered text array and one-pass entity decoding', async context => {
  const requests: Array<{ url: string; headers: Headers; input: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), input: JSON.parse(String(init?.body)), signal: init?.signal });
    return json({ data: { translations: [
      { translatedText: 'Voici &quot;un&quot; &amp; &#39;deux&#39; &#x1F642; &eacute; &#10218;OIT_0&#10219;' },
      { translatedText: '&lt;img src=x onerror=bad()&gt; &amp;amp; &notAnEntity;' },
    ] } });
  });
  const provider = google(` ${API_KEY} `);
  const inputs = [{ id: 'first', text: 'First ⟪OIT_0⟫' }, { id: 'second', text: 'Second' }];
  const result = await provider.translate(inputs, 'auto', 'zh-Hans', signal());
  assert.equal(provider.configured, true);
  assert.deepEqual(result, [
    { id: 'first', text: 'Voici "un" & \'deux\' 🙂 é ⟪OIT_0⟫' },
    { id: 'second', text: '<img src=x onerror=bad()> &amp; &notAnEntity;' },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, 'https://translation.googleapis.com/language/translate/v2');
  assert.equal(requests[0]!.url.includes(API_KEY), false);
  assert.equal(requests[0]!.headers.get('x-goog-api-key'), API_KEY);
  assert.equal(requests[0]!.headers.get('authorization'), null);
  assert.deepEqual(requests[0]!.input, { q: inputs.map(item => item.text), target: 'zh-CN', format: 'text', model: 'nmt' });
  assert.ok(requests[0]!.signal instanceof AbortSignal);
});

test('Google maps both explicit Chinese language variants without sending auto as a source', async context => {
  const inputs: Record<string, unknown>[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    inputs.push(JSON.parse(String(init?.body)));
    return json(valid());
  });
  const provider = google();
  await provider.translate([{ id: 'one', text: '你好' }], 'zh-Hans', 'zh-Hant', signal());
  await provider.translate([{ id: 'two', text: 'Hello' }], 'AUTO', 'fr', signal());
  assert.equal(inputs[0]!.source, 'zh-CN');
  assert.equal(inputs[0]!.target, 'zh-TW');
  assert.equal('source' in inputs[1]!, false);
  assert.equal(inputs[1]!.target, 'fr');
});

test('Google integrates with the broker to restore math, code, URLs and browser inline markers', async context => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body)) as { q: string[] };
    return json(valid(`Traduit: ${input.q[0]!.replace(/⟪/g, '&#10218;').replace(/⟫/g, '&#10219;')}`));
  });
  const source = 'Keep $E=mc^2$, `code()` and https://example.com. [[OIT_OPEN_0]]Read[[OIT_CLOSE_0]] [[OIT_KEEP_1]]';
  const result = await new TranslationBroker(google()).translate({ segments: [{ id: 'prose', text: source }], targetLanguage: 'fr' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.results[0]!.text, `Traduit: ${source}`);
  assert.equal(result.results[0]!.text.includes('⟪OIT_'), false);
});

for (const [name, envelope] of [
  ['missing list', {}],
  ['wrong count', { data: { translations: [] } }],
  ['null item', { data: { translations: [null] } }],
  ['nonstring text', { data: { translations: [{ translatedText: 42 }] } }],
  ['empty text', valid('   ')],
] as const) {
  test(`Google rejects an invalid response: ${name}`, async context => {
    const fetch = context.mock.method(globalThis, 'fetch', async () => json(envelope));
    await assert.rejects(() => google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), /Google Cloud Translation returned/);
    assert.equal(fetch.mock.callCount(), 2);
  });
}

for (const [name, text] of [
  ['dropped', 'No marker'],
  ['duplicated', '⟪OIT_0⟫ ⟪OIT_0⟫'],
  ['invented', '⟪OIT_0⟫ ⟪OIT_1⟫'],
] as const) {
  test(`Google fails safely when a protected marker is ${name}`, async context => {
    context.mock.method(globalThis, 'fetch', async () => json(valid(text)));
    await assert.rejects(() => google().translate([{ id: 'one', text: 'Keep ⟪OIT_0⟫' }], 'auto', 'fr', signal()), /protected math\/code\/link token/);
  });
}

test('Google retries rate limits, then accepts a valid response', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? json({}, 429) : json(valid()));
  assert.deepEqual(await google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), [{ id: 'one', text: 'Bonjour' }]);
  assert.equal(calls, 2);
});

test('Google retries a server failure but does not retry permanent auth errors or expose response bodies', async context => {
  let calls = 0;
  let status = 503;
  context.mock.method(globalThis, 'fetch', async () => { calls++; return json({ error: { message: `secret ${API_KEY}` } }, status); });
  await assert.rejects(() => google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), /HTTP 503/);
  assert.equal(calls, 2);
  calls = 0; status = 403;
  await assert.rejects(() => google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 403/);
    assert.match(error.message, /API key/);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('Google sanitizes transport diagnostics that could contain a credential', async context => {
  context.mock.method(globalThis, 'fetch', async () => { throw new Error(`Invalid header ${API_KEY}`); });
  await assert.rejects(() => google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cannot reach Google Cloud Translation/);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  });
});

test('Google rejects malformed JSON without exposing response text', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response(`invalid JSON ${API_KEY}`));
  await assert.rejects(() => google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', signal()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid JSON/);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  });
});

test('Google cancellation aborts an in-flight fetch without retrying', async context => {
  let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  const fetch = context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted fixture fetch')), { once: true });
    begun();
  }));
  const controller = new AbortController();
  const pending = google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', controller.signal);
  await started;
  controller.abort(new Error('Translation cancelled'));
  await assert.rejects(() => pending, /Translation cancelled/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('Google discards a late response even if a transport ignores cancellation', async context => {
  let release!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', async () => new Promise<Response>(resolve => { release = resolve; }));
  const controller = new AbortController();
  const pending = google().translate([{ id: 'one', text: 'Hello' }], 'auto', 'fr', controller.signal);
  controller.abort(new Error('Translation cancelled'));
  release(json(valid()));
  await assert.rejects(() => pending, /Translation cancelled/);
});

test('Google rejects oversized direct batches before sending a request', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => json(valid()));
  await assert.rejects(() => google().translate(Array.from({ length: 129 }, (_, index) => ({ id: String(index), text: 'Hello' })), 'auto', 'fr', signal()), /at most 128 strings/);
  assert.equal(fetch.mock.callCount(), 0);
});
