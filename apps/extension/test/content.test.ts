import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/content.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0]!.text;
const selector = '[data-oit-owned="launcher"][data-oit-launcher]';
const settings = { targetLanguage: 'fr', sourceLanguage: 'auto', theme: 'subtle' };
type Listener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => void;

function page(t: TestContext) {
  const dom = new JSDOM('<main><p id="source">Read this paragraph and keep <code>npm test</code>.</p></main>', { url: 'https://example.org/article', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const messages: Array<{ type: string }> = [], listeners: Listener[] = [];
  const jobs = new Map<string, Array<{ id: string; text: string }>>();
  const dispatch = (message: unknown) => { for (const listener of listeners) listener(message, {}, () => {}); };
  Object.assign(dom.window, { chrome: { runtime: {
    onMessage: { addListener(listener: Listener) { listeners.push(listener); } },
    async sendMessage(message: { type: string; segments?: Array<{ id: string; text: string }>; jobId?: string }) {
      messages.push(message);
      if (message.type === 'oit:launcher-start') { dispatch({ type: 'oit:start', settings }); return { ok: true }; }
      if (message.type === 'oit:launcher-restore') { dispatch({ type: 'oit:restore' }); return { ok: true }; }
      if (message.type === 'oit:translation-start') { const jobId = `fixture-${jobs.size}`; jobs.set(jobId, message.segments!); return { jobId }; }
      if (message.type === 'oit:translation-status') {
        const results = jobs.get(message.jobId!)!.map(segment => ({ ...segment, text: `Traduit: ${segment.text}` }));
        return { id: message.jobId, status: 'completed', completed: results.length, total: results.length, result: { results, errors: [] } };
      }
      return { ok: true };
    },
  } } });
  return { window: dom.window, document: dom.window.document, messages, listeners, dispatch, install: () => dom.window.eval(bundle) };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Content-script condition did not settle');
}

test('automatic content boot stays passive and shared start/restore messages preserve one launcher', async t => {
  const fixture = page(t);
  const original = fixture.document.querySelector('#source')!.innerHTML;
  fixture.install(); fixture.install();
  assert.equal(fixture.document.querySelectorAll(selector).length, 1);
  assert.equal(fixture.listeners.length, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.document.querySelector('[data-oit-owned="translation"]'), null);
  const launcher = fixture.document.querySelector(selector)!;
  const translate = launcher.shadowRoot!.querySelector('[data-action="translate"]') as HTMLButtonElement;
  const restore = launcher.shadowRoot!.querySelector('[data-action="restore"]') as HTMLButtonElement;
  assert.equal(translate.getAttribute('aria-label'), 'Translate this page');
  assert.equal(restore.hidden, true);
  // Page scripts can reach the open shadow root, but synthetic clicks cannot
  // authorize a provider request. Trusted clicks are covered in browser tests.
  translate.click();
  assert.equal(fixture.messages.length, 0);
  for (let cycle = 0; cycle < 2; cycle++) {
    fixture.dispatch({ type: 'oit:start', settings });
    await waitFor(() => fixture.document.querySelector('[data-oit-owned="translation"]')?.textContent?.startsWith('Traduit:') === true);
    assert.equal(fixture.document.querySelector('#source')!.innerHTML, original);
    assert.equal(fixture.document.querySelector('[data-oit-owned="translation"] code')?.textContent, 'npm test');
    assert.equal(restore.hidden, false);
    fixture.dispatch({ type: 'oit:restore' });
    await waitFor(() => fixture.document.querySelector('[data-oit-owned="translation"]') === null && !translate.disabled);
    assert.equal(fixture.document.querySelector(selector), launcher);
    assert.equal(fixture.document.querySelectorAll(selector).length, 1);
    assert.equal(translate.getAttribute('aria-label'), 'Translate this page');
  }
  assert.equal(fixture.messages.filter(message => message.type === 'oit:launcher-start').length, 0);
  assert.equal(fixture.messages.filter(message => message.type === 'oit:launcher-restore').length, 0);
  assert.equal(fixture.messages.filter(message => message.type === 'oit:translation-start').length, 2);
});

test('toolbar start uses the same persistent launcher without creating another control', async t => {
  const fixture = page(t);
  fixture.install();
  const launcher = fixture.document.querySelector(selector)!;
  fixture.dispatch({ type: 'oit:start', settings });
  await waitFor(() => fixture.document.querySelector('[data-oit-owned="translation"]')?.textContent?.startsWith('Traduit:') === true);
  fixture.dispatch({ type: 'oit:restore' });
  assert.equal(fixture.document.querySelector('[data-oit-owned="translation"]'), null);
  assert.equal(fixture.document.querySelector(selector), launcher);
  assert.equal(fixture.document.querySelectorAll(selector).length, 1);
  assert.equal(fixture.messages.some(message => message.type === 'oit:launcher-start'), false);
});

test('content boot before body readiness mounts once when the document becomes ready', async t => {
  const fixture = page(t);
  fixture.document.body.remove();
  fixture.install();
  assert.equal(fixture.document.querySelector(selector), null);
  assert.equal(fixture.messages.length, 0);
  fixture.document.documentElement.append(fixture.document.createElement('body'));
  fixture.document.dispatchEvent(new fixture.window.Event('DOMContentLoaded'));
  fixture.document.dispatchEvent(new fixture.window.Event('DOMContentLoaded'));
  assert.equal(fixture.document.querySelectorAll(selector).length, 1);
  assert.equal(fixture.messages.length, 0);
});

test('programmatic subframe injection stays passive and leaves the launcher in the top frame', t => {
  const fixture = page(t);
  const frame = fixture.document.createElement('iframe');
  fixture.document.body.append(frame);
  const child = frame.contentWindow!;
  let registrations = 0, requests = 0;
  Object.assign(child, { chrome: { runtime: { onMessage: { addListener() { registrations++; } }, async sendMessage() { requests++; return {}; } } } });
  (child as unknown as { eval(source: string): void }).eval(bundle);
  assert.equal(registrations, 1);
  assert.equal(child.document.querySelector(selector), null);
  assert.equal(requests, 0);
});
