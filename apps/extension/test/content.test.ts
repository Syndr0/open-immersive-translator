import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../src/content.ts', import.meta.url))], bundle: true, write: false, platform: 'browser', format: 'iife' })).outputFiles[0]!.text;
const selector = '[data-oit-owned="launcher"][data-oit-launcher]';
const settings = { targetLanguage: 'fr', sourceLanguage: 'auto', theme: 'subtle' };
type Listener = (message: unknown, sender: unknown, respond: (value: unknown) => void) => void;

function page(t: TestContext, stored: Record<string, unknown> = {}) {
  const dom = new JSDOM('<main><p id="source">Read this paragraph and keep <code>npm test</code>.</p></main>', { url: 'https://example.org/article', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const messages: Array<{ type: string }> = [], listeners: Listener[] = [];
  const jobs = new Map<string, Array<{ id: string; text: string }>>();
  let offline = false;
  const dispatch = (message: unknown, respond: (value: unknown) => void = () => {}) => { for (const listener of listeners) listener(message, {}, respond); };
  const data: Record<string, unknown> = structuredClone(stored);
  const changeListeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];
  const storage = {
    async get(key: string) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(items: Record<string, unknown>) {
      Object.assign(data, structuredClone(items));
      const changes = Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: structuredClone(value) }]));
      for (const listener of changeListeners) listener(changes, 'local');
    },
  };
  Object.assign(dom.window, { chrome: { storage: { local: storage, onChanged: { addListener: (listener: typeof changeListeners[number]) => changeListeners.push(listener) } }, runtime: {
    onMessage: { addListener(listener: Listener) { listeners.push(listener); } },
    async sendMessage(message: { type: string; segments?: Array<{ id: string; text: string }>; jobId?: string }) {
      messages.push(message);
      if (message.type === 'oit:launcher-start') { dispatch({ type: 'oit:start', settings }); return { ok: true }; }
      if (message.type === 'oit:launcher-restore') { dispatch({ type: 'oit:restore' }); return { ok: true }; }
      if (message.type === 'oit:translation-start') { if (offline) return { error: 'Cannot reach the local translation service.' }; const jobId = `fixture-${jobs.size}`; jobs.set(jobId, message.segments!); return { jobId }; }
      if (message.type === 'oit:translation-status') {
        const results = jobs.get(message.jobId!)!.map(segment => ({ ...segment, text: `Traduit: ${segment.text}` }));
        return { id: message.jobId, status: 'completed', completed: results.length, total: results.length, result: { results, errors: [] } };
      }
      return { ok: true };
    },
  } } });
  return { window: dom.window, document: dom.window.document, messages, listeners, dispatch, data, storage, setOffline: (value: boolean) => { offline = value; }, install: () => dom.window.eval(bundle) };
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
  await waitFor(() => fixture.document.querySelector(selector) !== null);
  assert.equal(fixture.document.querySelectorAll(selector).length, 1);
  assert.equal(fixture.listeners.length, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(fixture.messages.length, 0);
  assert.equal(fixture.document.querySelector('[data-oit-owned="translation"]'), null);
  const launcher = fixture.document.querySelector(selector)!;
  const translate = launcher.shadowRoot!.querySelector('[data-action="main"]') as HTMLButtonElement;
  const again = launcher.shadowRoot!.querySelector('[data-action="again"]') as HTMLButtonElement;
  assert.equal(translate.getAttribute('aria-label'), 'Translate this page');
  assert.equal(again.hidden, true);
  // Page scripts can reach the open shadow root, but synthetic clicks cannot
  // authorize a provider request. Trusted clicks are covered in browser tests.
  translate.click();
  assert.equal(fixture.messages.length, 0);
  for (let cycle = 0; cycle < 2; cycle++) {
    fixture.dispatch({ type: 'oit:start', settings });
    await waitFor(() => fixture.document.querySelector('[data-oit-owned="translation"]')?.textContent?.startsWith('Traduit:') === true);
    assert.equal(fixture.document.querySelector('#source')!.innerHTML, original);
    assert.equal(fixture.document.querySelector('[data-oit-owned="translation"] code')?.textContent, 'npm test');
    assert.equal(again.hidden, false);
    assert.equal(translate.getAttribute('aria-label'), 'Restore original page');
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
  await waitFor(() => fixture.document.querySelector(selector) !== null);
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
  await waitFor(() => fixture.document.querySelector(selector) !== null);
  await new Promise(resolve => setTimeout(resolve, 20));
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

test('mid-job service failure stays in the single launcher and recovery clears stale errors', async t => {
  const fixture = page(t);
  const original = fixture.document.querySelector('main')!.innerHTML;
  fixture.install(); fixture.setOffline(true);
  await waitFor(() => fixture.document.querySelector(selector) !== null);
  fixture.dispatch({ type: 'oit:start', settings });
  const host = fixture.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  await waitFor(() => root.querySelector('[data-action="main"]')?.getAttribute('aria-label') === 'Retry page translation');
  assert.equal(fixture.document.querySelector('[data-oit-owned="translation"]'), null);
  assert.equal(fixture.document.querySelectorAll(selector).length, 1);
  assert.equal(fixture.document.querySelector('main')!.innerHTML, original);
  assert.match(root.querySelector('[role="status"]')!.textContent!, /0 of 1.*1 unavailable.*Cannot reach the local translation service/);
  fixture.setOffline(false); fixture.dispatch({ type: 'oit:start', settings });
  await waitFor(() => fixture.document.querySelector('[data-oit-owned="translation"]')?.textContent?.startsWith('Traduit:') === true);
  assert.equal(root.querySelector('[role="status"]')?.textContent, '1 of 1 paragraphs translated');
  assert.equal(root.querySelector('.rail')?.classList.contains('has-error'), false);
  assert.equal(fixture.document.querySelector('.oit-error'), null);
  fixture.dispatch({ type: 'oit:restore' });
  assert.equal(fixture.document.querySelector('main')!.innerHTML, original);
  assert.equal(root.querySelector('[data-action="main"]')?.getAttribute('aria-label'), 'Translate this page');
});

test('a site or everywhere hide keeps the button away, and the toolbar brings it back', async t => {
  const fixture = page(t, { launcher: { hiddenSites: ['example.org'], placement: { side: 'left', top: 0.2 } } });
  fixture.install();
  const visibility = () => new Promise(resolve => fixture.dispatch({ type: 'oit:launcher-visibility' }, resolve));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fixture.document.querySelector(selector), null);
  assert.equal(JSON.stringify(await visibility()), '{"hidden":true}');
  // Show from the toolbar clears the site hide and keeps the saved position.
  await new Promise(resolve => { for (const listener of fixture.listeners) assert.equal(listener({ type: 'oit:show-launcher' }, {}, resolve), true); });
  const host = fixture.document.querySelector(selector) as HTMLElement;
  assert.ok(host);
  assert.equal(host.style.getPropertyValue('left'), '0px');
  assert.equal(JSON.stringify((fixture.data.launcher as { hiddenSites: string[] }).hiddenSites), '[]');
  assert.equal(JSON.stringify(await visibility()), '{"hidden":false}');
  // Another tab choosing "Hide everywhere" removes it here as well.
  await fixture.storage.set({ launcher: { ...(fixture.data.launcher as object), hiddenEverywhere: true } });
  assert.equal(fixture.document.querySelector(selector), null);
  await fixture.storage.set({ launcher: { ...(fixture.data.launcher as object), hiddenEverywhere: false } });
  assert.ok(fixture.document.querySelector(selector));
  assert.equal(fixture.messages.length, 0);
});
