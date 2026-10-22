import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationBroker } from '@oit/core';
import { providerFromEnv } from '../src/provider.ts';

const provider = () => providerFromEnv({ TRANSLATION_PROVIDER: 'google-free' });
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('free Google batches escaped HTML paragraphs at the no-key gtx endpoint and decodes text once', async context => {
  const requests: { url: URL; headers: Headers; method?: string; queries: string[] }[] = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: new URL(String(url)), method: init?.method, headers: new Headers(init?.headers), queries: new URLSearchParams(String(init?.body)).getAll('q') });
    assert.equal(init?.credentials, 'omit');
    return json(['Bonjour <code translate="no">⟪OIT_0⟫</code> &amp;amp; text', '&lt;em&gt;literal text&lt;/em&gt;']);
  });
  const free = provider();
  assert.equal(free.kind, 'google-free'); assert.equal(free.model, 'web-unofficial'); assert.equal(free.configured, true);
  assert.deepEqual(free.batch, { maxSegments: 32, maxCharacters: 12000 });
  assert.deepEqual(await free.translate([{ id: 'a', text: 'Hello ⟪OIT_0⟫ &amp; text' }, { id: 'b', text: 'Second' }], 'en', 'fr', signal()), [{ id: 'a', text: 'Bonjour ⟪OIT_0⟫ &amp; text' }, { id: 'b', text: '<em>literal text</em>' }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url.origin + requests[0]!.url.pathname, 'https://translate.googleapis.com/translate_a/t');
  assert.deepEqual([...requests[0]!.url.searchParams], [['client', 'gtx'], ['dt', 't'], ['sl', 'en'], ['tl', 'fr'], ['format', 'html']]);
  assert.equal(requests[0]!.method, 'POST');
  assert.deepEqual(requests[0]!.queries, ['Hello <code translate="no">⟪OIT_0⟫</code> &amp;amp; text', 'Second']);
  assert.deepEqual([...requests[0]!.headers], [['accept-encoding', 'identity'], ['content-type', 'application/x-www-form-urlencoded;charset=UTF-8']]);
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
  test(`free Google recovers a ${name} without losing valid peers`, async context => {
    const batches: string[][] = [];
    context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const queries = new URLSearchParams(String(init?.body)).getAll('q'); batches.push(queries);
      return json(batches.length === 1 ? [['Un titre correct', 'en'], [translated, 'en']] : [['Conserver', 'en']]);
    });
    const result = await provider().translate([{ id: 'title', text: 'A valid title' }, { id: 'a', text: 'Keep ⟪OIT_0⟫' }], 'auto', 'fr', signal());
    assert.deepEqual(result, [{ id: 'title', text: 'Un titre correct' }, { id: 'a', text: 'Conserver ⟪OIT_0⟫' }]);
    assert.deepEqual(batches, [['A valid title', 'Keep <code translate="no">⟪OIT_0⟫</code>'], ['Keep']]);
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

test('recovery retains exact inline identities, punctuation and whitespace while translating only prose', async context => {
  const batches: string[][] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const queries = new URLSearchParams(String(init?.body)).getAll('q'); batches.push(queries);
    return json(batches.length === 1 ? ['Bad output without markers'] : ['Lire', 'cette recherche', ',\n garder']);
  });
  const source = 'Read ⟪OIT_0⟫this research⟪OIT_1⟫,\n keep ⟪OIT_2⟫.';
  const result = await provider().translate([{ id: 'paragraph', text: source }], 'en', 'fr', signal());
  assert.deepEqual(result, [{ id: 'paragraph', text: 'Lire ⟪OIT_0⟫cette recherche⟪OIT_1⟫,\n garder ⟪OIT_2⟫.' }]);
  assert.equal(batches[0]!.length, 1);
  assert.ok(batches[0]![0]!.includes('<code translate="no">⟪OIT_0⟫</code>'));
  assert.deepEqual(batches.slice(1), [['Read', 'this research', ',\n keep']]);
});

test('HTML mode preserves a complete inline paragraph with no fragment-recovery request', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(new URLSearchParams(String(init?.body)).getAll('q'), [
      'Read <code translate="no">⟪OIT_0⟫</code>this research<code translate="no">⟪OIT_1⟫</code> &amp; keep <code translate="no">⟪OIT_2⟫</code>.',
    ]);
    return json(['Lire <code translate="no">⟪OIT_0⟫</code>cette recherche<code translate="no">⟪OIT_1⟫</code> &amp; conserver <code translate="no">⟪OIT_2⟫</code>.']);
  });
  const result = await provider().translate([{ id: 'paragraph', text: 'Read ⟪OIT_0⟫this research⟪OIT_1⟫ & keep ⟪OIT_2⟫.' }], 'en', 'fr', signal());
  assert.deepEqual(result, [{ id: 'paragraph', text: 'Lire ⟪OIT_0⟫cette recherche⟪OIT_1⟫ & conserver ⟪OIT_2⟫.' }]);
  assert.equal(fetch.mock.callCount(), 1);
});

test('literal source markup stays text and cannot be mistaken for a protected envelope', async context => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const [text] = new URLSearchParams(String(init?.body)).getAll('q');
    assert.equal(text, '&lt;code translate="no"&gt;example&lt;/code&gt; &amp;lt;reader&amp;gt; &lt;script&gt;literal&lt;/script&gt;');
    return json([text]);
  });
  const source = '<code translate="no">example</code> &lt;reader&gt; <script>literal</script>';
  assert.deepEqual(await provider().translate([{ id: 'literal', text: source }], 'en', 'fr', signal()), [{ id: 'literal', text: source }]);
});

test('unexpected provider HTML fails only its paragraph and never escapes as a successful translation', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => json(++calls === 1
    ? ['Titre valide', '<code translate="no" onclick="bad()">⟪OIT_0⟫</code>']
    : ['<img src=x onerror=bad()>']));
  const result = await provider().translate([{ id: 'good', text: 'A title' }, { id: 'bad', text: 'Keep ⟪OIT_0⟫' }], 'en', 'fr', signal());
  assert.deepEqual(result[0], { id: 'good', text: 'Titre valide' });
  assert.ok('error' in result[1]!);
  assert.equal(calls, 2);
});

test('entity-only blank translations cannot succeed or displace valid peer results', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => json(++calls === 1 ? ['Titre valide', '&#32;&nbsp;'] : ['&#x20;']));
  const result = await provider().translate([{ id: 'good', text: 'A title' }, { id: 'bad', text: 'A paragraph' }], 'en', 'fr', signal());
  assert.deepEqual(result[0], { id: 'good', text: 'Titre valide' });
  assert.ok('error' in result[1]!);
  assert.equal(calls, 2);
});

test('recovery rate limits affect only the failed paragraph and successful peers remain cached', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    const queries = new URLSearchParams(String(init?.body)).getAll('q');
    if (calls === 1) return json(queries.map((text, index) => [index === 0 ? 'Titre correct' : 'Missing marker', 'en']));
    if (calls === 2) return json({ error: 'Private diagnostic' }, 429);
    return json(queries.map(text => [`Traduit: ${text}`, 'en']));
  });
  const broker = new TranslationBroker(provider());
  const request = { targetLanguage: 'fr', segments: [{ id: 'title', text: 'A valid title' }, { id: 'paragraph', text: 'Keep `code()` unchanged.' }, { id: 'alias', text: 'Keep `code()` unchanged.' }] };
  const first = await broker.translate(request);
  assert.deepEqual(first.results.map(result => result.id), ['title']);
  assert.deepEqual(first.errors.map(error => error.id), ['paragraph', 'alias']);
  assert.ok(first.errors.every(error => /rate limited/.test(error.message) && !error.message.includes('Private')));
  assert.equal(calls, 2, 'rate limiting must not trigger immediate repeated recovery');
  const retry = await broker.translate(request);
  assert.deepEqual(retry.errors, []);
  assert.deepEqual(retry.results.map(result => result.cached), [true, false, false]);
  assert.ok(retry.results[1]!.text.includes('`code()`'));
  assert.equal(calls, 3);
});

test('malformed or invented recovery results fail only their owner without leaking raw data', async context => {
  for (const recovery of [[], [['Invented ⟪OIT_999⟫', 'en']]]) {
    let calls = 0;
    context.mock.method(globalThis, 'fetch', async () => json(++calls === 1 ? [['Titre', 'en'], ['Lost marker', 'en']] : recovery));
    const result = await provider().translate([{ id: 'title', text: 'A valid title' }, { id: 'bad', text: 'Keep ⟪OIT_0⟫.' }], 'auto', 'fr', signal());
    assert.deepEqual(result[0], { id: 'title', text: 'Titre' });
    assert.equal(result[1]!.id, 'bad');
    assert.ok('error' in result[1]!);
    assert.equal(calls, 2);
    context.mock.restoreAll();
  }
});

test('recovery batches more than 32 prose fragments without transmitting protected markers', async context => {
  const source = Array.from({ length: 40 }, (_, i) => `word${i}⟪OIT_${i}⟫ `).join('');
  const batches: string[][] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const queries = new URLSearchParams(String(init?.body)).getAll('q'); batches.push(queries);
    return json(batches.length === 1 ? ['Lost markers'] : queries.map(text => `fr:${text}`));
  });
  const result = await provider().translate([{ id: 'many-links', text: source }], 'en', 'fr', signal());
  assert.deepEqual(batches.map(batch => batch.length), [1, 32, 8]);
  assert.ok(batches.slice(1).flat().every(text => !text.includes('⟪OIT_')));
  assert.deepEqual(result, [{ id: 'many-links', text: Array.from({ length: 40 }, (_, i) => `fr:word${i}⟪OIT_${i}⟫ `).join('') }]);
});

test('marker-only and punctuation units stay local without a provider request', async context => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Do not send protected-only input'); });
  const segments = [{ id: 'math', text: '⟪OIT_0⟫, ⟪OIT_1⟫.' }, { id: 'numeric', text: '1234 / 5678' }];
  assert.deepEqual(await provider().translate(segments, 'auto', 'fr', signal()), segments);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Restore aborts token recovery and discards even completed primary peers', async context => {
  const controller = new AbortController();
  let release!: (response: Response) => void;
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? json([['Titre', 'en'], ['Lost token', 'en']])
    : new Promise<Response>(resolve => { release = resolve; }));
  const pending = provider().translate([{ id: 'title', text: 'A title' }, { id: 'bad', text: 'Keep ⟪OIT_0⟫' }], 'auto', 'fr', controller.signal);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('Restored during token recovery'));
  release(json([['Conserver', 'en']]));
  await assert.rejects(pending, /Restored during token recovery/);
  assert.equal(calls, 2);
});

test('a shared recovery rate limit stops requests for later paragraph groups', async context => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls++;
    const queries = new URLSearchParams(String(init?.body)).getAll('q');
    return calls === 1 ? json(queries.map(() => 'Missing markers')) : json({}, 429);
  });
  const source = (count: number) => Array.from({ length: count }, (_, i) => `word${i}⟪OIT_${i}⟫ `).join('');
  const result = await provider().translate([{ id: 'first', text: source(33) }, { id: 'later', text: source(16) }], 'en', 'fr', signal());
  assert.equal(calls, 2);
  assert.ok(result.every(item => 'error' in item && /rate limited/.test(item.error)));
});
