import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { PageTranslator, type TranslationReply } from '../src/engine';

async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for DOM state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('bilingual mode preserves original node identity/listeners and restores completely', async () => {
  const window = new JSDOM('<p>Read <a href="/article">the article</a> now.</p>', { url: 'https://example.com' }).window;
  const document = window.document;
  const paragraph = document.querySelector('p')!;
  const link = document.querySelector('a')!;
  let clicks = 0; link.addEventListener('click', event => { event.preventDefault(); clicks++; });
  const engine = new PageTranslator(document);
  engine.start({ targetLanguage: 'zh-Hans', theme: 'subtle', translate: async segments => ({ results: segments.map(segment => ({ ...segment, text: segment.text.replace('Read', '阅读') })), errors: [] }) });
  await waitFor(() => engine.status().translated === 1);
  assert.equal(document.querySelector('p'), paragraph);
  assert.equal(paragraph.querySelector('a'), link);
  assert.equal(paragraph.textContent, 'Read the article now.');
  link.click(); assert.equal(clicks, 1);
  assert.equal(document.querySelectorAll('[data-oit-owned]').length, 1);
  engine.restore();
  assert.equal(document.querySelectorAll('[data-oit-owned]').length, 0);
  assert.equal(paragraph.textContent, 'Read the article now.');
  assert.equal(engine.status().state, 'idle');
  window.close();
});

test('restore invalidates a response that arrives after cancellation', async () => {
  const window = new JSDOM('<p>Original sentence.</p>').window;
  const engine = new PageTranslator(window.document);
  let finish: ((reply: TranslationReply) => void) | undefined;
  let request: Array<{ id: string; text: string }> = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => { request = segments; return new Promise(resolve => { finish = resolve; }); } });
  await waitFor(() => !!finish);
  engine.restore();
  finish!({ results: request.map(segment => ({ id: segment.id, text: 'Late translation' })), errors: [] });
  await sleep(60);
  assert.equal(window.document.querySelector('[data-oit-owned]'), null);
  assert.equal(window.document.body.textContent, 'Original sentence.');
  window.close();
});

test('host edit while pending discards old result and translates the new source', async () => {
  const window = new JSDOM('<p>First source.</p>').window;
  const engine = new PageTranslator(window.document);
  let finish: ((reply: TranslationReply) => void) | undefined;
  let first: Array<{ id: string; text: string }> = [];
  let calls = 0;
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    calls++;
    if (calls === 1) { first = segments; return new Promise(resolve => { finish = resolve; }); }
    return { results: segments.map(segment => ({ id: segment.id, text: 'New result' })), errors: [] };
  } });
  await waitFor(() => !!finish);
  window.document.querySelector('p')!.textContent = 'Other source.'; // same length is still a change
  finish!({ results: first.map(segment => ({ id: segment.id, text: 'Stale result' })), errors: [] });
  await waitFor(() => window.document.querySelector('[data-oit-owned]')?.textContent === 'New result');
  assert.equal(window.document.body.textContent?.includes('Stale result'), false);
  assert.equal(calls, 2);
  engine.restore(); window.close();
});

test('new dynamic paragraphs translate once and own DOM changes do not loop', async () => {
  const window = new JSDOM('<main><p>First paragraph.</p></main>').window;
  const engine = new PageTranslator(window.document);
  let calls = 0;
  engine.start({ targetLanguage: 'es', theme: 'accent', translate: async segments => {
    calls++; return { results: segments.map(segment => ({ ...segment, text: `Translated ${segment.text}` })), errors: [] };
  } });
  await waitFor(() => engine.status().translated === 1);
  const next = window.document.createElement('p'); next.textContent = 'Second paragraph.';
  window.document.querySelector('main')!.append(next);
  await waitFor(() => engine.status().translated === 2);
  await sleep(600);
  assert.equal(calls, 2);
  assert.equal(window.document.querySelectorAll('[data-oit-owned]').length, 2);
  engine.restore(); window.close();
});

test('invalid protected output fails visibly without damaging source', async () => {
  const window = new JSDOM('<p>Keep <code>x=1</code> unchanged.</p>').window;
  const engine = new PageTranslator(window.document);
  engine.start({ targetLanguage: 'de', theme: 'subtle', translate: async segments => ({ results: segments.map(segment => ({ id: segment.id, text: 'Dropped the code marker' })), errors: [] }) });
  await waitFor(() => engine.status().failed === 1);
  assert.equal(window.document.querySelector('p')?.textContent, 'Keep x=1 unchanged.');
  assert.equal(window.document.querySelector('.oit-error')?.textContent, 'Translation unavailable');
  engine.restore(); window.close();
});

test('protected inline source changes refresh local clones even when provider text stays identical', async () => {
  const window = new JSDOM('<p>Keep <code>x=1</code> unchanged.</p>').window;
  const engine = new PageTranslator(window.document);
  const requests: string[] = [];
  engine.start({ targetLanguage: 'de', theme: 'subtle', translate: async segments => {
    requests.push(...segments.map(segment => segment.text));
    return { results: segments.map(segment => ({ id: segment.id, text: segment.text })), errors: [] };
  } });
  await waitFor(() => engine.status().translated === 1);
  window.document.querySelector('p code')!.textContent = 'x=2';
  await waitFor(() => window.document.querySelector('[data-oit-owned] code')?.textContent === 'x=2');
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  engine.restore(); window.close();
});

test('bare body prose receives a wrapper inside the body', async () => {
  const window = new JSDOM('Bare prose without a paragraph element.').window;
  const engine = new PageTranslator(window.document);
  engine.start({ targetLanguage: 'de', theme: 'subtle', translate: async segments => ({ results: segments.map(segment => ({ id: segment.id, text: 'Translated prose' })), errors: [] }) });
  await waitFor(() => engine.status().translated === 1);
  assert.equal(window.document.querySelector('[data-oit-owned]')?.parentElement, window.document.body);
  engine.restore(); window.close();
});

test('a source paragraph hidden by the host removes its visible translation', async () => {
  const window = new JSDOM('<p>Visible source.</p>').window;
  const engine = new PageTranslator(window.document);
  engine.start({ targetLanguage: 'de', theme: 'subtle', translate: async segments => ({ results: segments.map(segment => ({ id: segment.id, text: 'Visible translation' })), errors: [] }) });
  await waitFor(() => engine.status().translated === 1);
  window.document.querySelector('p')!.hidden = true;
  await waitFor(() => !window.document.querySelector('[data-oit-owned]'));
  assert.equal(engine.status().total, 0);
  engine.restore(); window.close();
});

test('completed paragraphs render during a running batch and stale progress cannot survive Restore', async () => {
  const window = new JSDOM('<main><p>First public paragraph.</p><p>Second public paragraph.</p></main>').window;
  const engine = new PageTranslator(window.document);
  let notify!: (reply: TranslationReply) => void;
  let finish!: (reply: TranslationReply) => void;
  let input: Array<{ id: string; text: string }> = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: (segments, _signal, onProgress) => {
    input = segments; notify = onProgress!;
    return new Promise(resolve => { finish = resolve; });
  } });
  await waitFor(() => !!finish);
  assert.equal(window.document.querySelectorAll('[data-oit-pending="true"]').length, 2);
  const first = { results: [{ id: input[0]!.id, text: 'First translation' }], errors: [] };
  notify(first);
  assert.equal(engine.status().translated, 1);
  assert.equal(window.document.querySelector('[data-oit-owned]')?.textContent, 'First translation');
  assert.equal(window.document.querySelectorAll('[data-oit-pending="true"]').length, 1);
  notify(first);
  assert.equal(window.document.querySelectorAll('[data-oit-owned]').length, 2);
  engine.restore();
  const completed = { results: input.map(segment => ({ id: segment.id, text: 'Late translation' })), errors: [] };
  notify(completed); finish(completed);
  await sleep(60);
  assert.equal(window.document.querySelector('[data-oit-owned]'), null);
  assert.equal(window.document.querySelector('p')?.textContent, 'First public paragraph.');
  window.close();
});

test('a later batch failure retains already rendered valid paragraphs', async () => {
  const window = new JSDOM('<p>First source.</p><p>Second source.</p>').window;
  const engine = new PageTranslator(window.document);
  let notify!: (reply: TranslationReply) => void, reject!: (error: Error) => void;
  let input: Array<{ id: string; text: string }> = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: (segments, _signal, onProgress) => {
    input = segments; notify = onProgress!;
    return new Promise((_resolve, fail) => { reject = fail; });
  } });
  await waitFor(() => !!reject);
  notify({ results: [{ id: input[0]!.id, text: 'Valid completed translation' }], errors: [] });
  reject(new Error('The remaining translation failed'));
  await waitFor(() => engine.status().failed === 1);
  assert.equal(engine.status().translated, 1);
  assert.equal(window.document.querySelector('[data-oit-owned]')?.textContent, 'Valid completed translation');
  assert.equal(window.document.querySelectorAll('.oit-error').length, 1);
  engine.restore(); window.close();
});

test('visible reading content is requested before a long navigation menu', async () => {
  const window = new JSDOM(`<header><nav>${Array.from({ length: 12 }, (_, i) => `<a href="/${i}">Menu label ${i}</a>`).join(' ')}</nav></header><main><h1>Paper title</h1><p>A public research paragraph.</p></main>`).window;
  const engine = new PageTranslator(window.document);
  const calls: string[][] = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    calls.push(segments.map(segment => segment.text));
    return { results: segments, errors: [] };
  } });
  await waitFor(() => engine.status().state === 'ready');
  assert.equal(calls[0]![0], 'Paper title');
  assert.equal(calls[0]![1], 'A public research paragraph.');
  engine.restore(); window.close();
});

test('large page discovery yields and Restore cancels scheduled scan work', async () => {
  const window = new JSDOM(`<main>${Array.from({ length: 200 }, (_, i) => `<p>Public paragraph ${i}.</p>`).join('')}</main>`).window;
  const engine = new PageTranslator(window.document);
  let calls = 0;
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    calls++; return { results: segments, errors: [] };
  } });
  assert.ok(engine.status().total < 200, 'discovery must yield before serializing the entire page');
  engine.restore();
  await sleep(80);
  assert.equal(engine.status().total, 0);
  assert.equal(calls, 0);
  assert.equal(window.document.querySelector('[data-oit-owned]'), null);
  assert.equal(window.document.querySelectorAll('p').length, 200);
  window.close();
});

test('host-cloned pending translations are discarded and Restore removes every owned clone', async () => {
  const window = new JSDOM('<main><p>Public source paragraph.</p></main>').window;
  const engine = new PageTranslator(window.document);
  const finish: Array<() => void> = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: segments => new Promise(resolve => {
    finish.push(() => resolve({ results: segments.map(segment => ({ id: segment.id, text: 'Valid translation' })), errors: [] }));
  }) });
  await waitFor(() => finish.length === 1);
  window.document.body.replaceWith(window.document.body.cloneNode(true));
  await sleep(320);
  engine.restore();
  for (const resolve of finish) resolve();
  await sleep(80);
  assert.equal(window.document.querySelector('[data-oit-owned]'), null);
  assert.equal(window.document.querySelector('p')?.textContent, 'Public source paragraph.');
  window.close();
});

test('a cloned completed body is translated once without keeping duplicate injected results', async () => {
  const window = new JSDOM('<main><p>Public source paragraph.</p></main>').window;
  const engine = new PageTranslator(window.document);
  let calls = 0;
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    calls++; return { results: segments.map(segment => ({ id: segment.id, text: 'Valid translation' })), errors: [] };
  } });
  await waitFor(() => engine.status().translated === 1);
  window.document.body.replaceWith(window.document.body.cloneNode(true));
  await waitFor(() => calls === 2 && engine.status().translated === 1);
  assert.equal(window.document.querySelectorAll('[data-oit-owned="translation"]').length, 1);
  engine.restore();
  assert.equal(window.document.querySelector('[data-oit-owned]'), null);
  window.close();
});

test('a reading batch can translate more than eight paragraphs together', async () => {
  const window = new JSDOM(`<main>${Array.from({ length: 20 }, (_, i) => `<p>Public reading paragraph number ${i}.</p>`).join('')}</main>`).window;
  const engine = new PageTranslator(window.document);
  const batches: number[] = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    batches.push(segments.length);
    return { results: segments, errors: [] };
  } });
  await waitFor(() => engine.status().translated === 20);
  assert.ok(batches.some(count => count > 8), 'reading batches should no longer stop after eight paragraphs');
  assert.ok(batches.every(count => count <= 32), 'page batches remain bounded');
  engine.restore(); window.close();
});

test('document-root text added by another extension never becomes a translation host', async () => {
  const window = new JSDOM('<!doctype html><html><head><title>Private metadata label</title></head><body><main><p>Public reading paragraph.</p></main></body></html>').window;
  const document = window.document;
  const engine = new PageTranslator(document);
  const requested: string[] = [];
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: async segments => {
    requested.push(...segments.map(segment => segment.text));
    return { results: segments.map(segment => ({ ...segment, text: 'Translated public paragraph.' })), errors: [] };
  } });
  await waitFor(() => engine.status().translated === 1);
  document.documentElement.append(document.createTextNode('External extension portal label'));
  const metadata = document.createElement('meta'); metadata.name = 'test-root-mutation'; document.head.append(metadata);
  await sleep(350);
  assert.deepEqual(requested, ['Public reading paragraph.']);
  assert.equal(document.children.length, 1);
  assert.equal(document.documentElement.tagName, 'HTML');
  assert.equal(document.querySelectorAll('[data-oit-owned="translation"]').length, 1);
  engine.restore();
  assert.equal(document.querySelectorAll('[data-oit-owned="translation"]').length, 0);
  assert.equal(document.querySelector('p')?.textContent, 'Public reading paragraph.');
  assert.ok(document.documentElement.textContent?.includes('External extension portal label'));
  window.close();
});

test('a pending paragraph moved outside body receives no late translation overlay', async () => {
  const window = new JSDOM('<main><p>Source moved by another extension.</p></main>').window;
  const document = window.document;
  const paragraph = document.querySelector('p')!;
  const engine = new PageTranslator(document);
  let finish!: () => void;
  engine.start({ targetLanguage: 'fr', theme: 'subtle', translate: segments => new Promise(resolve => {
    finish = () => resolve({ results: segments.map(segment => ({ ...segment, text: 'Late translation' })), errors: [] });
  }) });
  await waitFor(() => !!finish);
  document.documentElement.append(paragraph);
  finish();
  await waitFor(() => engine.status().total === 0);
  assert.equal(document.querySelector('[data-oit-owned="translation"]'), null);
  assert.equal(paragraph.textContent, 'Source moved by another extension.');
  engine.restore(); window.close();
});
