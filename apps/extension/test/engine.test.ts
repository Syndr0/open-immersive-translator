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
