import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createPageControls } from '../src/page-controls';
import { PageTranslator, type PageStatus } from '../src/engine';

const translating: PageStatus = { state: 'translating', total: 2, translated: 1, failed: 0, pending: 1 };
const ready: PageStatus = { state: 'ready', total: 2, translated: 2, failed: 0, pending: 0 };
const idle: PageStatus = { state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 };
const selector = '[data-oit-owned="launcher"][data-oit-launcher]';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('unchanged paragraphs finish without claiming a translation or leaving a spinner', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const root = window.document.querySelector(selector)!.shadowRoot!;
  controls.update({ state: 'ready', total: 2, translated: 0, skipped: 2, failed: 0, pending: 0 });
  assert.equal(root.querySelector('.label')?.textContent, 'Unchanged');
  assert.equal(root.querySelector('[role="status"]')?.textContent, '0 of 2 paragraphs translated · 2 unchanged');
  assert.equal(root.querySelector('[data-role="progress"]')?.textContent, '2/2');
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), false);
  controls.remove(); window.close();
});

test('deferred content shows Ready without a spinner and active work resumes before final completion', () => {
  const window = new JSDOM('<p>Public source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const root = window.document.querySelector(selector)!.shadowRoot!;
  controls.update({ state: 'waiting', total: 2, translated: 1, failed: 0, pending: 1 });
  const translate = root.querySelector('[data-action="translate"]') as HTMLButtonElement;
  assert.equal(root.querySelector('.label')?.textContent, 'Ready');
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), false);
  assert.equal(translate.getAttribute('aria-busy'), 'false');
  assert.equal(translate.disabled, false);
  assert.match(root.querySelector('[role="status"]')!.textContent!, /1 of 2.*1 remaining.*Scroll to translate more/);
  controls.update(translating);
  assert.equal(root.querySelector('.label')?.textContent, 'Translating');
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), true);
  assert.equal(translate.getAttribute('aria-busy'), 'true');
  controls.update(ready);
  assert.equal(root.querySelector('.label')?.textContent, 'Translated');
  assert.equal(root.querySelector('[role="status"]')?.textContent, '2 of 2 paragraphs translated');
  controls.remove(); window.close();
});

test('launcher exists while idle without invoking actions or altering original content', () => {
  const window = new JSDOM('<main><p>Original source.</p></main>').window;
  const original = window.document.querySelector('p')!;
  const html = original.outerHTML;
  let starts = 0; let restores = 0;
  const controls = createPageControls(window.document, { start: () => { starts++; }, restore: () => { restores++; } });
  const host = window.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  const button = root.querySelector('[data-action="translate"]') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-label'), 'Translate this page');
  assert.equal(button.disabled, false);
  assert.equal(root.querySelector('[data-action="restore"]')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('[data-role="progress"]')?.hasAttribute('hidden'), true);
  assert.equal(starts, 0); assert.equal(restores, 0);
  assert.equal(window.document.querySelector('p'), original);
  assert.equal(original.outerHTML, html);
  controls.remove(); window.close();
});

test('page scripts cannot start or restore translation through synthetic shadow button clicks', async () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  let starts = 0; let restores = 0;
  const controls = createPageControls(window.document, { start: () => { starts++; }, restore: () => { restores++; } });
  const root = window.document.querySelector(selector)!.shadowRoot!;
  const translate = root.querySelector('[data-action="translate"]') as HTMLButtonElement;
  translate.click();
  translate.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  controls.update(ready);
  const restore = root.querySelector('[data-action="restore"]') as HTMLButtonElement;
  restore.click();
  restore.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  await settle();
  assert.equal(starts, 0); assert.equal(restores, 0);
  assert.equal(root.querySelector('[data-role="progress"]')?.textContent, '2/2');
  controls.remove(); window.close();
});

test('active progress is visible and idle status returns the same launcher to Translate', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  controls.update({ state: 'translating', total: 6, translated: 2, failed: 1, pending: 3 });
  assert.equal(root.querySelector('[data-role="status"]')?.textContent, '2 of 6 paragraphs translated · 1 unavailable · 3 remaining');
  assert.equal(root.querySelector('[data-role="progress"]')?.textContent, '2/6');
  assert.equal(root.querySelector('[data-action="restore"]')?.hasAttribute('hidden'), false);
  assert.equal((root.querySelector('[data-action="translate"]') as HTMLButtonElement).disabled, true);
  controls.update(ready);
  assert.equal((root.querySelector('[data-action="translate"]') as HTMLButtonElement).disabled, false);
  controls.update(idle);
  assert.equal(window.document.querySelector(selector), host);
  assert.equal(root.querySelector('[data-action="translate"]')?.getAttribute('aria-label'), 'Translate this page');
  assert.equal(root.querySelector('[data-action="restore"]')?.hasAttribute('hidden'), true);
  controls.remove(); window.close();
});

for (const replacement of ['fresh', 'clone'] as const) {
  test(`launcher survives ${replacement} body replacement without waiting for another status update`, async () => {
    const window = new JSDOM('<main><p>Original source.</p></main>').window;
    const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
    controls.update(translating);
    const original = window.document.querySelector(selector)!;
    const button = original.shadowRoot!.querySelector('[data-action="restore"]');
    const body = replacement === 'clone' ? window.document.body.cloneNode(true) as HTMLElement : window.document.createElement('body');
    if (replacement === 'fresh') body.innerHTML = '<main><p>Replacement source.</p></main>';
    window.document.body.replaceWith(body);
    await settle();
    assert.equal(window.document.querySelectorAll(selector).length, 1);
    assert.equal(window.document.querySelector(selector), original);
    assert.equal(original.parentElement, window.document.body);
    assert.equal(original.shadowRoot!.querySelector('[data-action="restore"]'), button);
    controls.update(ready);
    assert.equal(original.shadowRoot!.querySelector('[data-role="status"]')?.textContent, '2 of 2 paragraphs translated');
    controls.update(idle);
    assert.equal(original.shadowRoot!.querySelector('[data-action="translate"]')?.getAttribute('aria-label'), 'Translate this page');
    controls.remove(); window.close();
  });
}

test('a body created later receives the idle launcher and inert copies are removed', async () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  window.document.body.remove();
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const body = window.document.createElement('body'); window.document.documentElement.append(body);
  await settle();
  const original = window.document.querySelector(selector)!;
  assert.ok(original);
  body.append(original.cloneNode(true));
  await settle();
  assert.equal(window.document.querySelectorAll(selector).length, 1);
  assert.equal(window.document.querySelector(selector), original);
  controls.remove(); window.close();
});

test('engine Restore clears translations while retaining the independent launcher', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const original = window.document.querySelector(selector)!;
  new PageTranslator(window.document).restore();
  controls.update(idle);
  assert.equal(window.document.querySelector(selector), original);
  controls.remove(); window.close();
});

test('errors are plain text and a later idle report clears them without removing the launcher', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  controls.showError('<img src=x onerror=bad()> Service unavailable.');
  assert.equal(host.shadowRoot!.querySelector('[data-role="status"]')?.textContent, '<img src=x onerror=bad()> Service unavailable.');
  assert.equal(host.shadowRoot!.querySelector('img'), null);
  assert.equal(host.shadowRoot!.querySelector('.label')?.textContent, 'Retry');
  controls.update(idle);
  assert.equal(host.shadowRoot!.querySelector('.label')?.textContent, 'Translate');
  assert.equal(window.document.querySelector(selector), host);
  controls.remove(); window.close();
});

test('paragraph failures appear once in the launcher with Retry and clear on recovery or Restore', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  controls.update({ state: 'ready', total: 150, translated: 0, failed: 150, pending: 0, error: 'Cannot reach the local service.' });
  const retry = root.querySelector('[data-action="translate"]') as HTMLButtonElement;
  assert.equal(retry.disabled, false);
  assert.equal(retry.getAttribute('aria-label'), 'Retry page translation');
  assert.equal(root.querySelector('.label')?.textContent, 'Retry');
  assert.equal(root.querySelector('[data-role="progress"]')?.textContent, '0/150');
  assert.match(root.querySelector('[data-role="status"]')!.textContent!, /150 unavailable.*Cannot reach the local service.*Choose Retry/);
  assert.equal(root.querySelectorAll('[role="status"]').length, 1);
  assert.equal(root.querySelector('.rail')?.classList.contains('has-error'), true);
  assert.equal(window.document.querySelector('p')?.textContent, 'Original source.');
  controls.update(translating);
  assert.equal(root.querySelector('.rail')?.classList.contains('has-error'), false);
  assert.equal(root.querySelector('[data-role="status"]')?.textContent?.includes('Cannot reach'), false);
  controls.update(ready);
  assert.equal(root.querySelector('.label')?.textContent, 'Translated');
  controls.update(idle);
  assert.equal(root.querySelector('.label')?.textContent, 'Translate');
  assert.equal(root.querySelector('[data-role="status"]')?.textContent?.includes('unavailable'), false);
  assert.equal(window.document.querySelector(selector), host);
  controls.remove(); window.close();
});

test('remove permanently disables reattachment and clears inert cloned launchers', async () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const original = window.document.querySelector(selector)!;
  window.document.body.replaceWith(window.document.body.cloneNode(true));
  controls.remove();
  controls.update(translating); controls.update(ready); controls.showError('Ignored after removal');
  await settle();
  assert.equal(window.document.querySelector(selector), null);
  assert.equal(original.isConnected, false);
  window.close();
});

test('an old instance cannot remove or reattach over a newer launcher', async () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const old = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const current = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  old.remove(); old.update(translating);
  await settle();
  assert.equal(window.document.querySelector(selector), host);
  assert.equal(window.document.querySelectorAll(selector).length, 1);
  current.remove(); window.close();
});
