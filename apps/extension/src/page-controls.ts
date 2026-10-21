import type { PageStatus } from './engine';
import { OWNED } from './dom';

export interface PageControlActions {
  start(): void | Promise<void>;
  restore(): void | Promise<void>;
}
export interface PageControls {
  update(status: PageStatus): void;
  showError(message: string): void;
  remove(): void;
}

const SELECTOR = `[${OWNED}="launcher"][data-oit-launcher]`;
const instances = new WeakMap<Document, PageControls>();
const idle = (): PageStatus => ({ state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 });
let nextControlId = 0;

/** A user-action entry point only: mounting never starts translation or network work. */
export function createPageControls(document: Document, actions: PageControlActions): PageControls {
  instances.get(document)?.remove();
  let active = true;
  let value = idle();
  let starting = false;
  let restoring = false;
  let error = '';
  let actionVersion = 0;
  const instanceId = `${Date.now().toString(36)}-${++nextControlId}`;
  const host = document.createElement('div');
  host.setAttribute(OWNED, 'launcher');
  host.setAttribute('data-oit-launcher', '');
  host.setAttribute('data-oit-control-instance', instanceId);
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; display: block; position: fixed; right: 12px; top: 50%; transform: translateY(-50%);
      z-index: 2147483646; width: 64px; max-width: calc(100vw - 24px); color-scheme: light;
      font: 11px/1.4 system-ui, -apple-system, sans-serif; direction: ltr; writing-mode: horizontal-tb;
      isolation: isolate; }
    *, *::before, *::after { box-sizing: border-box; }
    .rail { display: flex; flex-direction: column; width: 64px; border: 1px solid #d2d2d2; border-radius: 12px;
      background: #fff; color: #222; box-shadow: 0 3px 16px #0002; overflow: hidden; }
    button { appearance: none; margin: 0; border: 0; background: transparent; color: inherit; font: inherit;
      cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:focus-visible { outline: 2px solid #b31b1b; outline-offset: -4px; }
    button:hover:not(:disabled) { background: #f4f4f4; }
    button:disabled { cursor: default; }
    .translate { display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 100%; min-height: 66px; gap: 4px; padding: 10px 3px 9px; }
    .glyph { position: relative; width: 26px; height: 23px; font-size: 18px; line-height: 1; font-weight: 650; }
    .glyph b { position: absolute; left: 0; top: 0; font-weight: 650; }
    .glyph i { position: absolute; right: 0; bottom: 0; font-size: 14px; font-style: normal; color: #b31b1b; background: #fff; }
    .label { font-size: 9px; line-height: 1.25; font-weight: 550; }
    .progress { font-size: 9px; line-height: 1.2; color: #777; font-variant-numeric: tabular-nums; }
    .restore { display: flex; align-items: center; justify-content: center; gap: 3px; width: 100%; min-height: 44px;
      padding: 7px 3px; border-top: 1px solid #e2e2e2; font-size: 9px; color: #a31a1a; }
    .restore-icon { font-size: 17px; line-height: 1; }
    .restore:disabled { color: #888; }
    [hidden] { display: none !important; }
    .tooltip { position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
      width: max-content; max-width: min(240px, calc(100vw - 100px)); padding: 9px 11px; border: 1px solid #d7d7d7;
      border-radius: 7px; background: #fff; color: #555; box-shadow: 0 3px 16px #0001; font-size: 11px; line-height: 1.6;
      pointer-events: none; opacity: 0; visibility: hidden; overflow-wrap: anywhere; }
    :host(:hover) .tooltip, :host(:focus-within) .tooltip { opacity: 1; visibility: visible; }
    .tooltip strong { display: block; color: #222; font-weight: 600; margin-bottom: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .working .glyph { width: 18px; height: 18px; border: 2px solid #dedede; border-right-color: #b31b1b;
      border-radius: 50%; animation: oit-control-spin 1s linear infinite; }
    .working .glyph > * { display: none; }
    .has-error .label { color: #a31a1a; }
    @keyframes oit-control-spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) { :host { right: 8px; } }
    @media (prefers-reduced-motion: reduce) { .working .glyph { animation: none; } }
    @media print { :host { display: none !important; } }
  `;

  const rail = document.createElement('div'); rail.className = 'rail';
  rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', 'Open Immersive Translator page controls');
  const translate = document.createElement('button'); translate.type = 'button'; translate.className = 'translate';
  translate.setAttribute('data-action', 'translate');
  const glyph = document.createElement('span'); glyph.className = 'glyph'; glyph.setAttribute('aria-hidden', 'true');
  const firstGlyph = document.createElement('b'); firstGlyph.textContent = 'A';
  const secondGlyph = document.createElement('i'); secondGlyph.textContent = '文'; glyph.append(firstGlyph, secondGlyph);
  const label = document.createElement('span'); label.className = 'label';
  const progress = document.createElement('span'); progress.className = 'progress'; progress.setAttribute('data-role', 'progress');
  translate.append(glyph, label, progress);
  const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'restore';
  restore.setAttribute('data-action', 'restore'); restore.setAttribute('aria-label', 'Restore original page');
  const restoreIcon = document.createElement('span'); restoreIcon.className = 'restore-icon'; restoreIcon.setAttribute('aria-hidden', 'true'); restoreIcon.textContent = '↶';
  const restoreLabel = document.createElement('span'); restoreLabel.textContent = 'Restore'; restore.append(restoreIcon, restoreLabel);
  const status = document.createElement('span'); status.className = 'sr-only';
  status.id = `oit-page-status-${instanceId}`; status.setAttribute('data-role', 'status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  translate.setAttribute('aria-describedby', status.id);
  const tooltip = document.createElement('div'); tooltip.className = 'tooltip'; tooltip.setAttribute('aria-hidden', 'true');
  const title = document.createElement('strong'); title.textContent = 'Open Translate';
  const detail = document.createElement('span'); tooltip.append(title, detail);
  rail.append(translate, restore); root.append(style, rail, status, tooltip);

  function attach() {
    if (!active || !document.body) return;
    for (const candidate of document.querySelectorAll(SELECTOR)) if (candidate !== host) candidate.remove();
    if (host.parentElement !== document.body) document.body.append(host);
  }

  function summary(): string {
    if (error) return error;
    if (restoring) return 'Restoring the original page…';
    if (starting) return 'Starting translation…';
    if (value.state === 'idle') return 'Translate this page with your configured translation service.';
    return `${value.translated} of ${value.total} paragraphs translated${value.failed ? ` · ${value.failed} unavailable` : ''}${value.pending ? ` · ${value.pending} remaining` : ''}`;
  }

  function render() {
    if (!active) return;
    const working = starting || value.state === 'translating';
    const hasTranslation = value.state !== 'idle';
    rail.classList.toggle('working', working && !restoring);
    rail.classList.toggle('has-error', !!error);
    translate.disabled = working || restoring;
    translate.setAttribute('aria-label', hasTranslation ? value.state === 'translating' ? 'Translation in progress' : 'Translate this page again' : 'Translate this page');
    translate.setAttribute('aria-busy', String(working));
    label.textContent = restoring ? 'Restoring' : starting ? 'Starting' : value.state === 'translating' ? 'Translating' : error ? 'Retry' : hasTranslation ? 'Translated' : 'Translate';
    progress.textContent = `${value.translated}/${value.total}`;
    progress.hidden = !hasTranslation || starting || restoring;
    restore.hidden = !hasTranslation && !restoring;
    restore.disabled = restoring;
    const text = summary(); status.textContent = text; detail.textContent = text;
    translate.title = hasTranslation && !working ? 'Translate this page again' : text;
    restore.title = 'Remove translations and show the original page';
  }

  function showError(message: string) {
    if (!active) return;
    error = message.trim().slice(0, 600) || 'Translation could not start. Check your translation service and try again.';
    starting = false; restoring = false; render(); attach();
  }

  translate.addEventListener('click', event => {
    // The page can reach an open shadow root. Synthetic events must not spend
    // the user's configured-provider allowance or change translation state.
    if (!event.isTrusted || !active || translate.disabled) return;
    const version = ++actionVersion;
    starting = true; error = ''; render();
    void (async () => {
      try {
        await actions.start();
        if (active && version === actionVersion) { starting = false; render(); }
      } catch (caught) {
        if (active && version === actionVersion) showError(caught instanceof Error ? caught.message : 'Translation could not start. Please try again.');
      }
    })();
  });
  restore.addEventListener('click', event => {
    if (!event.isTrusted || !active || restoring) return;
    const version = ++actionVersion;
    restoring = true; starting = false; error = ''; render();
    void (async () => {
      try {
        await actions.restore();
        if (active && version === actionVersion) { value = idle(); restoring = false; render(); attach(); }
      } catch (caught) {
        if (active && version === actionVersion) showError(caught instanceof Error ? caught.message : 'The original page could not be restored. Please try again.');
      }
    })();
  });
  // Avoid triggering the site's own click or keyboard shortcuts from this UI.
  root.addEventListener('click', event => event.stopPropagation());
  root.addEventListener('keydown', event => event.stopPropagation());

  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(records => {
    if (!active) return;
    const replacement = !document.body || host.parentElement !== document.body;
    const duplicate = records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node as Element).matches(SELECTOR) && node !== host));
    if (replacement || duplicate) attach();
  }) : undefined;
  observer?.observe(document, { childList: true, subtree: true });

  const controls: PageControls = {
    update(next) {
      if (!active) return;
      value = { ...next };
      if (next.state !== 'idle') starting = false;
      error = '';
      render(); attach();
    },
    showError,
    remove() {
      active = false; ++actionVersion; observer?.disconnect(); host.remove();
      for (const candidate of document.querySelectorAll(SELECTOR)) if (candidate.getAttribute('data-oit-control-instance') === instanceId) candidate.remove();
      if (instances.get(document) === controls) instances.delete(document);
    },
  };
  instances.set(document, controls);
  render(); attach();
  return controls;
}
