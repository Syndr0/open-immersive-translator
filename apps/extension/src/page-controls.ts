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
      z-index: 2147483646; width: 56px; max-width: calc(100vw - 24px); color-scheme: light dark;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      direction: ltr; writing-mode: horizontal-tb; isolation: isolate;
      --bg: #fff; --text: #0f1419; --muted: #536471; --border: #cfd9de; --hover: rgba(15,20,25,.06);
      --danger: #f4212e; --focus: #1d9bf0; --shadow: 0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15); }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #000; --text: #e7e9ea; --muted: #71767b; --border: #2f3336; --hover: rgba(231,233,234,.1);
        --shadow: 0 0 15px rgba(255,255,255,.12), 0 0 3px 1px rgba(255,255,255,.08); }
    }
    *, *::before, *::after { box-sizing: border-box; }
    .rail { display: flex; flex-direction: column; width: 56px; border: 1px solid var(--border); border-radius: 28px;
      background: var(--bg); color: var(--text); box-shadow: var(--shadow); overflow: hidden; }
    button { appearance: none; margin: 0; border: 0; background: transparent; color: inherit; font: inherit;
      cursor: pointer; -webkit-tap-highlight-color: transparent; }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: -4px; }
    button:hover:not(:disabled) { background: var(--hover); }
    button:disabled { cursor: default; }
    .translate { display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 100%; min-height: 64px; gap: 4px; padding: 12px 2px 10px; }
    .glyph { position: relative; width: 24px; height: 22px; font-size: 17px; line-height: 1; font-weight: 800; }
    .glyph b { position: absolute; left: 0; top: 0; font-weight: 800; }
    .glyph i { position: absolute; right: 0; bottom: 0; font-size: 13px; font-style: normal; font-weight: 700; color: var(--muted); background: var(--bg); }
    .label { font-size: 11px; line-height: 1.2; font-weight: 700; }
    .progress { font-size: 11px; line-height: 1.2; color: var(--muted); font-variant-numeric: tabular-nums; }
    .restore { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; width: 100%;
      min-height: 48px; padding: 8px 2px; border-top: 1px solid var(--border); font-size: 11px; font-weight: 700; color: var(--muted); }
    .restore:hover:not(:disabled) { color: var(--text); }
    .restore-icon { font-size: 16px; line-height: 1; }
    [hidden] { display: none !important; }
    .tooltip { position: absolute; right: calc(100% + 10px); top: 50%; transform: translateY(-50%);
      width: max-content; max-width: min(260px, calc(100vw - 100px)); padding: 10px 12px; border-radius: 12px;
      background: var(--text); color: var(--bg); box-shadow: var(--shadow); font-size: 13px; line-height: 1.5;
      pointer-events: none; opacity: 0; visibility: hidden; overflow-wrap: anywhere; transition: opacity .15s; }
    :host(:hover) .tooltip, :host(:focus-within) .tooltip, .rail.has-error ~ .tooltip { opacity: 1; visibility: visible; }
    .tooltip strong { display: block; font-weight: 700; margin-bottom: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
      clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .working .glyph { width: 18px; height: 18px; border: 2px solid var(--border); border-right-color: var(--text);
      border-radius: 50%; animation: oit-control-spin 1s linear infinite; }
    .working .glyph > * { display: none; }
    .has-error .label { color: var(--danger); }
    @keyframes oit-control-spin { to { transform: rotate(360deg); } }
    @media (max-width: 480px) { :host { right: 8px; } }
    @media (prefers-reduced-motion: reduce) { .working .glyph { animation: none; } .tooltip { transition: none; } }
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
    const counts = `${value.translated} of ${value.total} paragraphs translated${value.skipped ? ` · ${value.skipped} unchanged` : ''}${value.failed ? ` · ${value.failed} unavailable` : ''}${value.pending ? ` · ${value.pending} remaining` : ''}`;
    if (value.state === 'waiting') return value.failed
      ? `${counts}. ${value.error || 'Some paragraphs could not be translated.'} Choose Retry to try again, or scroll to translate more.`
      : `${counts}. Scroll to translate more.`;
    if (value.failed && !value.pending) return `${counts}. ${value.error || 'Some paragraphs could not be translated.'} Original text is preserved. Choose Retry to try again.`;
    return counts;
  }

  function render() {
    if (!active) return;
    const working = starting || value.state === 'translating';
    const hasTranslation = value.state !== 'idle';
    const retry = !!error || (value.failed > 0 && !working && !restoring);
    rail.classList.toggle('working', working && !restoring);
    rail.classList.toggle('has-error', retry);
    translate.disabled = working || restoring;
    translate.setAttribute('aria-label', retry ? 'Retry page translation' : hasTranslation ? value.state === 'translating' ? 'Translation in progress' : 'Translate this page again' : 'Translate this page');
    translate.setAttribute('aria-busy', String(working));
    label.textContent = restoring ? 'Restoring' : starting ? 'Starting' : value.state === 'translating' ? 'Translating' : retry ? 'Retry' : value.state === 'waiting' ? 'Ready' : value.skipped && !value.translated ? 'Unchanged' : hasTranslation ? 'Translated' : 'Translate';
    progress.textContent = `${value.translated + (value.skipped || 0)}/${value.total}`;
    progress.hidden = !hasTranslation || starting || restoring;
    restore.hidden = !hasTranslation && !restoring;
    restore.disabled = restoring;
    const text = summary(); status.textContent = text; detail.textContent = text;
    translate.title = retry || value.state === 'waiting' ? text : hasTranslation && !working ? 'Translate this page again' : text;
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
