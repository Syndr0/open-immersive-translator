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
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'current');
  assert.equal(root.querySelector('[role="status"]')?.textContent, '0 of 2 paragraphs translated · 2 already in the target language');
  assert.equal(root.querySelector('[data-role="detail"]')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), false);
  controls.remove(); window.close();
});

test('deferred content shows the waiting state without a spinner and active work resumes before final completion', () => {
  const window = new JSDOM('<p>Public source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const root = window.document.querySelector(selector)!.shadowRoot!;
  controls.update({ state: 'waiting', total: 2, translated: 1, failed: 0, pending: 1 });
  const translate = root.querySelector('[data-action="main"]') as HTMLButtonElement;
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'waiting');
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), false);
  assert.equal(translate.getAttribute('aria-busy'), 'false');
  assert.equal(translate.disabled, false);
  assert.match(root.querySelector('[role="status"]')!.textContent!, /1 of 2.*1 remaining.*Scroll to translate more/);
  controls.update(translating);
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'translating');
  assert.equal(root.querySelector('.rail')?.classList.contains('working'), true);
  assert.equal(translate.getAttribute('aria-busy'), 'true');
  controls.update(ready);
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'translated');
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
  const button = root.querySelector('[data-action="main"]') as HTMLButtonElement;
  assert.equal(button.getAttribute('aria-label'), 'Translate this page');
  assert.equal(button.disabled, false);
  assert.equal(button.title, '');
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('.badge')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('.rail')?.classList.contains('expanded'), false);
  assert.equal(root.querySelector('[data-role="progress"]'), null);
  assert.equal(root.querySelector('[data-role="detail"]')?.hasAttribute('hidden'), true);
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
  const main = root.querySelector('[data-action="main"]') as HTMLButtonElement;
  main.click();
  main.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
  controls.update(ready);
  main.click();
  (root.querySelector('[data-action="again"]') as HTMLButtonElement).click();
  (root.querySelector('[data-action="hide"]') as HTMLButtonElement).click();
  assert.equal(root.querySelector('.menu')?.hasAttribute('hidden'), true);
  await settle();
  assert.equal(starts, 0); assert.equal(restores, 0);
  controls.remove(); window.close();
});

test('the main button toggles to the original during and after translation and returns to Translate when idle', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  controls.update({ state: 'translating', total: 6, translated: 2, failed: 1, pending: 3 });
  assert.equal(root.querySelector('[data-role="status"]')?.textContent, '2 of 6 paragraphs translated · 1 unavailable · 3 remaining');
  assert.equal(root.querySelector('[data-role="detail"]')?.hasAttribute('hidden'), true);
  const main = root.querySelector('[data-action="main"]') as HTMLButtonElement;
  assert.equal(main.disabled, false);
  assert.equal(main.getAttribute('aria-label'), 'Restore original page');
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('.badge')?.hasAttribute('hidden'), true);
  controls.update(ready);
  assert.equal(main.getAttribute('aria-label'), 'Restore original page');
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), false);
  assert.equal(root.querySelector('.badge')?.hasAttribute('hidden'), false);
  controls.update(idle);
  assert.equal(window.document.querySelector(selector), host);
  assert.equal(main.getAttribute('aria-label'), 'Translate this page');
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), true);
  controls.remove(); window.close();
});

for (const replacement of ['fresh', 'clone'] as const) {
  test(`launcher survives ${replacement} body replacement without waiting for another status update`, async () => {
    const window = new JSDOM('<main><p>Original source.</p></main>').window;
    const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
    controls.update(translating);
    const original = window.document.querySelector(selector)!;
    const button = original.shadowRoot!.querySelector('[data-action="again"]');
    const body = replacement === 'clone' ? window.document.body.cloneNode(true) as HTMLElement : window.document.createElement('body');
    if (replacement === 'fresh') body.innerHTML = '<main><p>Replacement source.</p></main>';
    window.document.body.replaceWith(body);
    await settle();
    assert.equal(window.document.querySelectorAll(selector).length, 1);
    assert.equal(window.document.querySelector(selector), original);
    assert.equal(original.parentElement, window.document.body);
    assert.equal(original.shadowRoot!.querySelector('[data-action="again"]'), button);
    controls.update(ready);
    assert.equal(original.shadowRoot!.querySelector('[data-role="status"]')?.textContent, '2 of 2 paragraphs translated');
    controls.update(idle);
    assert.equal(original.shadowRoot!.querySelector('[data-action="main"]')?.getAttribute('aria-label'), 'Translate this page');
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
  assert.equal(host.shadowRoot!.querySelector('.rail')?.getAttribute('data-state'), 'error');
  assert.equal(host.shadowRoot!.querySelector('[data-action="main"]')?.getAttribute('aria-label'), 'Retry page translation');
  assert.equal(host.shadowRoot!.querySelector('.badge')?.hasAttribute('hidden'), false);
  // The details wait in the panel instead of covering the page.
  assert.equal(host.shadowRoot!.querySelector('.rail')?.classList.contains('expanded'), false);
  controls.update(idle);
  assert.equal(host.shadowRoot!.querySelector('.rail')?.getAttribute('data-state'), 'idle');
  assert.equal(window.document.querySelector(selector), host);
  controls.remove(); window.close();
});

test('paragraph failures appear once in the launcher with Retry and clear on recovery or Restore', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} });
  const host = window.document.querySelector(selector)!;
  const root = host.shadowRoot!;
  controls.update({ state: 'ready', total: 150, translated: 0, failed: 150, pending: 0, error: 'Cannot reach the local service.' });
  const retry = root.querySelector('[data-action="main"]') as HTMLButtonElement;
  assert.equal(retry.disabled, false);
  assert.equal(retry.getAttribute('aria-label'), 'Retry page translation');
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'error');
  assert.equal(root.querySelector('[data-action="original"]')?.hasAttribute('hidden'), false);
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), true);
  assert.equal(root.querySelector('[data-role="detail"]')?.textContent, 'Cannot reach the local service.');
  assert.match(root.querySelector('[data-role="status"]')!.textContent!, /150 unavailable.*Cannot reach the local service.*Original text is preserved/);
  assert.equal(root.querySelectorAll('[role="status"]').length, 1);
  assert.equal(root.querySelector('.rail')?.classList.contains('has-error'), true);
  assert.equal(window.document.querySelector('p')?.textContent, 'Original source.');
  controls.update(translating);
  assert.equal(root.querySelector('.rail')?.classList.contains('has-error'), false);
  assert.equal(root.querySelector('[data-role="status"]')?.textContent?.includes('Cannot reach'), false);
  controls.update({ state: 'ready', total: 2, translated: 1, failed: 1, pending: 0 });
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'partial');
  assert.equal(retry.getAttribute('aria-label'), 'Restore original page');
  assert.equal(root.querySelector('[data-action="retry"]')?.hasAttribute('hidden'), false);
  assert.equal(root.querySelector('[data-action="again"]')?.hasAttribute('hidden'), true);
  controls.update(ready);
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'translated');
  controls.update(idle);
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'idle');
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

test('a saved placement puts the button on that edge and an invalid one falls back to the right', () => {
  const window = new JSDOM('<p>Original source.</p>', { pretendToBeVisual: true }).window;
  const left = createPageControls(window.document, { start: () => {}, restore: () => {} }, { placement: { side: 'left', top: 0 } });
  let host = window.document.querySelector(selector) as HTMLElement;
  assert.equal(host.style.getPropertyValue('left'), '0px');
  assert.equal(host.style.getPropertyValue('right'), 'auto');
  assert.equal(host.style.getPropertyValue('top'), '8px');
  assert.equal(host.shadowRoot!.querySelector('.rail')?.classList.contains('left'), true);
  left.remove();
  const fallback = createPageControls(window.document, { start: () => {}, restore: () => {} }, { placement: { side: 'up' as 'left', top: Number.NaN } });
  host = window.document.querySelector(selector) as HTMLElement;
  assert.equal(host.style.getPropertyValue('right'), '0px');
  assert.equal(host.shadowRoot!.querySelector('.rail')?.classList.contains('left'), false);
  fallback.remove(); window.close();
});

test('synthetic pointer events cannot drag the button', () => {
  const window = new JSDOM('<p>Original source.</p>', { pretendToBeVisual: true }).window;
  let placed = 0;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {}, place: () => { placed++; } });
  const host = window.document.querySelector(selector) as HTMLElement;
  const main = host.shadowRoot!.querySelector('[data-action="main"]')!;
  const before = host.getAttribute('style');
  const Pointer = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? window.MouseEvent;
  for (const [type, x] of [['pointerdown', 700], ['pointermove', 100], ['pointerup', 100]] as const) main.dispatchEvent(new Pointer(type, { bubbles: true, clientX: x, clientY: 100, button: 0 }));
  assert.equal(host.getAttribute('style'), before);
  assert.equal(placed, 0);
  controls.remove(); window.close();
});

test('labels follow a Chinese browser language', () => {
  const window = new JSDOM('<p>Original source.</p>').window;
  const controls = createPageControls(window.document, { start: () => {}, restore: () => {} }, { language: 'zh-CN', site: 'example.org' });
  const root = window.document.querySelector(selector)!.shadowRoot!;
  assert.equal(root.querySelector('[data-action="main"]')?.getAttribute('aria-label'), '翻译此页面');
  assert.equal(root.querySelector('[data-action="hide-site"]')?.textContent, '在 example.org 上隐藏');
  controls.update({ state: 'ready', total: 3, translated: 3, failed: 0, pending: 0 });
  assert.equal(root.querySelector('.rail')?.getAttribute('data-state'), 'translated');
  assert.equal(root.querySelector('[role="status"]')?.textContent, '已翻译 3/3 段');
  controls.remove(); window.close();
});
