import type { PageStatus } from './engine';
import { OWNED } from './dom';

export type HideScope = 'page' | 'site' | 'everywhere';
/** Side of the viewport, and the button's vertical centre as a fraction of the viewport height. */
export interface LauncherPlacement { side: 'left' | 'right'; top: number }
export interface PageControlActions {
  start(): void | Promise<void>;
  restore(): void | Promise<void>;
  hide?(scope: HideScope): void | Promise<void>;
  place?(placement: LauncherPlacement): void | Promise<void>;
}
export interface PageControlOptions { placement?: LauncherPlacement; site?: string; language?: string }
export interface PageControls {
  update(status: PageStatus): void;
  showError(message: string): void;
  remove(): void;
}

const SELECTOR = `[${OWNED}="launcher"][data-oit-launcher]`;
const SIZE = 40, WIDTH = 46, MARGIN = 8, DRAG_THRESHOLD = 6, HOVER_DELAY = 400, EXIT_DELAY = 160, LONG_PRESS = 500;
export const DEFAULT_PLACEMENT: LauncherPlacement = { side: 'right', top: 0.6 };
const instances = new WeakMap<Document, PageControls>();
const idle = (): PageStatus => ({ state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 });
let nextControlId = 0;

const STRINGS = {
  en: {
    group: 'Open Immersive Translator page controls', translate: 'Translate this page', restore: 'Restore original page',
    retry: 'Retry page translation', again: 'Translate again', original: 'Show original', retryFailed: 'Retry failed', hide: 'Hide button',
    hidePage: 'Hide until reload', hideSite: (site: string) => `Hide on ${site}`, hideEverywhere: 'Hide everywhere',
    idle: 'Translate this page with your configured translation service.',
    starting: 'Starting translation…', restoring: 'Restoring the original page…',
    counts: (translated: number, total: number) => `${translated} of ${total} paragraphs translated`,
    current: (n: number) => `${n} already in the target language`, failed: (n: number) => `${n} unavailable`, pending: (n: number) => `${n} remaining`,
    scroll: 'Scroll to translate more.', failure: 'Some paragraphs could not be translated.', preserved: 'Original text is preserved.',
    startError: 'Translation could not start. Check your translation service and try again.',
    restoreError: 'The original page could not be restored. Please try again.',
  },
  zh: {
    group: 'Open Immersive Translator 页面控件', translate: '翻译此页面', restore: '显示原文',
    retry: '重试翻译', again: '重新翻译', original: '显示原文', retryFailed: '重试失败段落', hide: '隐藏按钮',
    hidePage: '本次隐藏', hideSite: (site: string) => `在 ${site} 上隐藏`, hideEverywhere: '全部网站隐藏',
    idle: '使用已配置的翻译服务翻译此页面。可拖动按钮。',
    starting: '正在开始翻译…', restoring: '正在恢复原文…',
    counts: (translated: number, total: number) => `已翻译 ${translated}/${total} 段`,
    current: (n: number) => `${n} 段已是目标语言`, failed: (n: number) => `${n} 段失败`, pending: (n: number) => `${n} 段待翻译`,
    scroll: '滚动页面以翻译更多内容。', failure: '部分段落无法翻译。', preserved: '原文已保留。',
    startError: '无法开始翻译。请检查翻译服务后重试。',
    restoreError: '无法恢复原文，请重试。',
  },
};
type Strings = typeof STRINGS.en;
const stringsFor = (language = ''): Strings => /^zh\b/i.test(language) ? STRINGS.zh : STRINGS.en;

function validPlacement(value: LauncherPlacement | undefined): LauncherPlacement {
  if (!value || (value.side !== 'left' && value.side !== 'right') || !Number.isFinite(value.top)) return { ...DEFAULT_PLACEMENT };
  return { side: value.side, top: Math.min(1, Math.max(0, value.top)) };
}

const CHECK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2 5 8.6l4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICONS: Record<string, string> = {
  again: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  original: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.8h2.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hide: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

const STYLE = `
  :host { all: initial; display: block; position: fixed; z-index: 2147483646; width: ${WIDTH}px; height: ${SIZE}px; color-scheme: light dark;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    direction: ltr; writing-mode: horizontal-tb; isolation: isolate; touch-action: none;
    --bg: #fff; --text: #0f1419; --muted: #536471; --border: #cfd9de; --hover: #f7f9f9; --on-text: #fff;
    --success: #00ba7c; --danger: #f4212e; --focus: #1d9bf0; --shadow: 0 0 15px rgba(101,119,134,.2), 0 0 3px 1px rgba(101,119,134,.15); }
  @media (prefers-color-scheme: dark) {
    :host { --bg: #000; --text: #e7e9ea; --muted: #71767b; --border: #2f3336; --hover: #16181c; --on-text: #0f1419;
      --shadow: 0 0 15px rgba(255,255,255,.12), 0 0 3px 1px rgba(255,255,255,.08); }
  }
  *, *::before, *::after { box-sizing: border-box; }
  [hidden] { display: none !important; }
  svg { display: block; width: 100%; height: 100%; }
  button { appearance: none; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit;
    cursor: pointer; -webkit-tap-highlight-color: transparent; }
  button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  button:disabled { cursor: default; }
  .rail { position: relative; width: ${WIDTH}px; height: ${SIZE}px; }
  .main { display: flex; align-items: center; justify-content: flex-start; width: ${WIDTH}px; height: ${SIZE}px; padding-left: 5px;
    border: 1px solid var(--border); border-right: 0; border-radius: ${SIZE / 2}px 0 0 ${SIZE / 2}px;
    background: var(--bg); box-shadow: var(--shadow); }
  .left .main { justify-content: flex-end; padding: 0 5px 0 0; border-right: 1px solid var(--border); border-left: 0; border-radius: 0 ${SIZE / 2}px ${SIZE / 2}px 0; }
  .main:hover:not(:disabled) { background: var(--hover); }
  .main:focus-visible { outline-offset: -3px; }
  .dragging .main { justify-content: center; padding: 0; border: 1px solid var(--border); border-radius: ${SIZE / 2}px; cursor: grabbing; }
  .icon { position: relative; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
    background: var(--text); color: var(--on-text); }
  .glyph { position: relative; width: 15px; height: 14px; line-height: 1; }
  .glyph b { position: absolute; left: 0; top: 0; font-size: 11px; font-weight: 800; }
  .glyph i { position: absolute; right: 0; bottom: 0; font-size: 8px; font-style: normal; font-weight: 700; opacity: .8; }
  .icon::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid transparent; }
  .working .icon::after { border-top-color: var(--text); animation: oit-control-spin .9s linear infinite; }
  .badge { position: absolute; right: -3px; bottom: -3px; display: grid; place-items: center; width: 13px; height: 13px; padding: 2px;
    border-radius: 50%; background: var(--success); color: #fff; box-shadow: 0 0 0 2px var(--bg); font-size: 9px; font-weight: 800; line-height: 1; }
  .has-error .badge { background: var(--danger); }
  .panel { position: absolute; top: 50%; right: calc(100% + 6px); display: flex; align-items: center; gap: 6px;
    transform: translate(4px, -50%); opacity: 0; visibility: hidden; transition: opacity .15s, transform .15s, visibility 0s .15s; }
  .left .panel { right: auto; left: calc(100% + 6px); flex-direction: row-reverse; transform: translate(-4px, -50%); }
  .expanded:not(.dragging) .panel { opacity: 1; visibility: visible; transform: translate(0, -50%); transition: opacity .15s, transform .15s; }
  .round { display: grid; place-items: center; width: 28px; height: 28px; padding: 6px; border: 1px solid var(--border); border-radius: 50%;
    background: var(--bg); color: var(--text); box-shadow: var(--shadow); }
  .round:hover { background: var(--hover); }
  .round[data-action="hide"] { color: var(--muted); }
  .card { width: max-content; max-width: min(240px, calc(100vw - ${WIDTH + 120}px)); padding: 8px 12px; border: 1px solid var(--border); border-radius: 14px;
    background: var(--bg); color: var(--text); box-shadow: var(--shadow); overflow-wrap: anywhere; }
  .menu { position: absolute; right: calc(100% + 6px); display: flex; flex-direction: column; padding: 4px; }
  .left .menu { right: auto; left: calc(100% + 6px); }
  .menu.top { top: 0; } .menu.bottom { bottom: 0; }
  .menu button { min-height: 32px; padding: 0 10px; border-radius: 10px; text-align: left; font-weight: 600; white-space: nowrap; }
  .menu button:hover { background: var(--hover); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @keyframes oit-control-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .working .icon::after { animation: none; } .panel { transition: none !important; } }
  @media print { :host { display: none !important; } }
`;

/** A user-action entry point only: mounting never starts translation or network work. */
export function createPageControls(document: Document, actions: PageControlActions, options: PageControlOptions = {}): PageControls {
  instances.get(document)?.remove();
  const view = document.defaultView!;
  const t = stringsFor(options.language ?? view.navigator?.language);
  const site = options.site || document.location?.hostname || '';
  let placement = validPlacement(options.placement);
  let active = true;
  let value = idle();
  let starting = false;
  let restoring = false;
  let error = '';
  let actionVersion = 0;
  let expanded = false;
  let choosingHide = false;
  const timers = { open: 0, close: 0, press: 0 };
  const instanceId = `${Date.now().toString(36)}-${++nextControlId}`;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
    const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element;
  };
  const button = (className: string, action: string, text: string) => {
    const element = make('button', className, text); element.type = 'button'; element.setAttribute('data-action', action); return element;
  };

  const host = make('div');
  host.setAttribute(OWNED, 'launcher');
  host.setAttribute('data-oit-launcher', '');
  host.setAttribute('data-oit-control-instance', instanceId);
  const root = host.attachShadow({ mode: 'open' });
  const style = make('style'); style.textContent = STYLE;

  const rail = make('div', 'rail');
  rail.setAttribute('role', 'group'); rail.setAttribute('aria-label', t.group);
  const main = button('main', 'main', '');
  const icon = make('span', 'icon'); icon.setAttribute('aria-hidden', 'true');
  const glyph = make('span', 'glyph'); glyph.append(make('b', '', 'A'), make('i', '', '文'));
  // State lives on the icon: a check once translated, "!" after a failure, a ring while working.
  const badge = make('span', 'badge');
  icon.append(glyph, badge); main.append(icon);

  const round = (action: string, label: string, svg: string) => {
    const element = button('round', action, ''); element.setAttribute('aria-label', label); element.title = label;
    element.innerHTML = svg; return element;
  };
  const panel = make('div', 'panel');
  // Only a failure reason is ever written out; counts go to screen readers alone.
  const detail = make('span', 'card detail'); detail.setAttribute('data-role', 'detail'); detail.hidden = true;
  const again = round('again', t.again, ICONS.again);
  const retryFailed = round('retry', t.retryFailed, ICONS.again);
  const original = round('original', t.original, ICONS.original);
  const hide = round('hide', t.hide, ICONS.hide); hide.setAttribute('aria-expanded', 'false');
  panel.append(detail, again, retryFailed, original, hide);
  const choices = make('div', 'card menu'); choices.hidden = true;
  choices.append(button('', 'hide-page', t.hidePage), button('', 'hide-site', t.hideSite(site)), button('', 'hide-everywhere', t.hideEverywhere));
  if (!site) choices.querySelector('[data-action="hide-site"]')!.remove();

  const status = make('span', 'sr-only');
  status.id = `oit-page-status-${instanceId}`; status.setAttribute('data-role', 'status');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  main.setAttribute('aria-describedby', status.id);
  rail.append(main, panel, choices); root.append(style, rail, status);

  function attach() {
    if (!active || !document.body) return;
    for (const candidate of document.querySelectorAll(SELECTOR)) if (candidate !== host) candidate.remove();
    if (host.parentElement !== document.body) document.body.append(host);
  }

  function position(x?: number, y?: number) {
    const height = view.innerHeight || 600, width = view.innerWidth || 800;
    const clampTop = (top: number) => Math.round(Math.min(Math.max(top, MARGIN), Math.max(MARGIN, height - SIZE - MARGIN)));
    const set = (name: string, next: string) => host.style.setProperty(name, next, 'important');
    if (x !== undefined && y !== undefined) {
      set('top', `${clampTop(y - SIZE / 2)}px`);
      set('left', `${Math.round(Math.min(Math.max(x - WIDTH / 2, 0), width - WIDTH))}px`); set('right', 'auto');
      return;
    }
    const top = clampTop(placement.top * height - SIZE / 2);
    set('top', `${top}px`);
    set(placement.side === 'left' ? 'left' : 'right', '0'); set(placement.side === 'left' ? 'right' : 'left', 'auto');
    rail.classList.toggle('left', placement.side === 'left');
    // Open the hide menu toward the larger part of the viewport.
    choices.classList.toggle('top', top + SIZE / 2 <= height / 2);
    choices.classList.toggle('bottom', top + SIZE / 2 > height / 2);
  }

  const working = () => starting || value.state === 'translating';
  const hasTranslation = () => value.state !== 'idle';
  // Nothing translated yet because the start or every paragraph failed: the main button retries.
  const retryFromMain = () => (!!error && !hasTranslation())
    || (hasTranslation() && !working() && !restoring && value.translated === 0 && !value.skipped && value.failed > 0);

  function summary(): string {
    if (error) return error;
    if (restoring) return t.restoring;
    if (starting) return t.starting;
    if (value.state === 'idle') return t.idle;
    const counts = [t.counts(value.translated, value.total),
      value.skipped ? t.current(value.skipped) : '', value.failed ? t.failed(value.failed) : '', value.pending ? t.pending(value.pending) : '']
      .filter(Boolean).join(' · ');
    if (value.state === 'waiting') return value.failed ? `${counts}. ${value.error || t.failure} ${t.scroll}` : `${counts}. ${t.scroll}`;
    if (value.failed && !value.pending) return `${counts}. ${value.error || t.failure} ${t.preserved}`;
    return counts;
  }

  function stateName(): string {
    if (error) return 'error';
    if (restoring) return 'restoring';
    if (starting) return 'starting';
    if (value.state === 'idle' || value.state === 'translating' || value.state === 'waiting') return value.state;
    if (value.failed && !value.translated) return 'error';
    if (value.failed) return 'partial';
    if (value.skipped && !value.translated) return 'current';
    return 'translated';
  }

  function render() {
    if (!active) return;
    const busy = working();
    // A start that failed before anything was translated is retried from the main button;
    // otherwise, once translation exists, the main button is a translation/original toggle.
    const startFailed = retryFromMain();
    const failures = !!error || (value.failed > 0 && !busy && !restoring);
    rail.classList.toggle('working', busy && !restoring);
    rail.classList.toggle('has-error', failures);
    rail.classList.toggle('expanded', expanded);
    main.disabled = starting || restoring;
    main.setAttribute('aria-label', startFailed ? t.retry : hasTranslation() ? t.restore : t.translate);
    main.setAttribute('aria-busy', String(busy));
    main.setAttribute('aria-expanded', String(expanded));
    rail.setAttribute('data-state', stateName());
    badge.hidden = busy || restoring || (!hasTranslation() && !error);
    badge.innerHTML = failures ? '!' : CHECK;
    status.textContent = summary();
    const reason = error || (failures ? value.error || '' : '');
    detail.textContent = reason; detail.hidden = !reason;
    retryFailed.hidden = !(hasTranslation() && value.failed > 0 && !busy && !restoring) || startFailed;
    original.hidden = !(startFailed && hasTranslation());
    again.hidden = !hasTranslation() || busy || restoring || !retryFailed.hidden || startFailed;
    panel.hidden = choosingHide;
    choices.hidden = !choosingHide || !expanded;
    hide.setAttribute('aria-expanded', String(choosingHide));
  }

  function setExpanded(next: boolean) {
    view.clearTimeout(timers.open); view.clearTimeout(timers.close);
    if (expanded === next) return;
    expanded = next;
    if (!next) choosingHide = false;
    render();
  }

  function showError(message: string) {
    if (!active) return;
    error = message.trim().slice(0, 600) || t.startError;
    starting = false; restoring = false; render(); attach();
  }

  function run(kind: 'start' | 'restore') {
    const version = ++actionVersion;
    if (kind === 'start') { starting = true; } else { restoring = true; starting = false; }
    error = ''; render();
    void (async () => {
      try {
        await (kind === 'start' ? actions.start() : actions.restore());
        if (!active || version !== actionVersion) return;
        if (kind === 'start') starting = false; else { value = idle(); restoring = false; }
        render(); attach();
      } catch (caught) {
        if (active && version === actionVersion) showError(caught instanceof Error ? caught.message : kind === 'start' ? t.startError : t.restoreError);
      }
    })();
  }

  // Pointer handling: hover reveals the panel after a delay, a drag moves the
  // button and snaps it to the nearest side, and a long touch press opens the panel.
  let press: { id: number; x: number; y: number; dragging: boolean; touch: boolean } | undefined;
  let suppressClick = false;
  let quietFocus = false;
  rail.addEventListener('pointerenter', event => {
    if (!event.isTrusted || event.pointerType === 'touch') return;
    view.clearTimeout(timers.close);
    if (!expanded) timers.open = view.setTimeout(() => setExpanded(true), HOVER_DELAY);
  });
  rail.addEventListener('pointerleave', event => {
    if (!event.isTrusted || event.pointerType === 'touch' || press?.dragging) return;
    view.clearTimeout(timers.open);
    // Stay open only for keyboard focus inside; a mouse click's focus does not hold the panel.
    let keyboard = false;
    try { keyboard = !!root.activeElement?.matches(':focus-visible'); } catch { /* Older engines. */ }
    if (expanded && !keyboard) timers.close = view.setTimeout(() => setExpanded(false), EXIT_DELAY);
  });
  main.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0) return;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false, touch: event.pointerType === 'touch' };
    if (press.touch) timers.press = view.setTimeout(() => { suppressClick = true; setExpanded(true); }, LONG_PRESS);
    // The pointer leaves the 40px button within one move, so follow it on the window.
    view.addEventListener('pointermove', onMove, true);
    view.addEventListener('pointerup', endPress, true);
    view.addEventListener('pointercancel', endPress, true);
  });
  function onMove(event: PointerEvent) {
    if (!event.isTrusted || !press || event.pointerId !== press.id) return;
    if (!press.dragging) {
      if (Math.abs(event.clientX - press.x) <= DRAG_THRESHOLD && Math.abs(event.clientY - press.y) <= DRAG_THRESHOLD) return;
      press.dragging = true;
      view.clearTimeout(timers.press);
      try { main.setPointerCapture(event.pointerId); } catch { /* The pointer may already be gone. */ }
      setExpanded(false);
      rail.classList.add('dragging');
    }
    event.preventDefault();
    position(event.clientX, event.clientY);
  }
  function stopFollowing() {
    view.removeEventListener('pointermove', onMove, true);
    view.removeEventListener('pointerup', endPress, true);
    view.removeEventListener('pointercancel', endPress, true);
  }
  function endPress(event: PointerEvent) {
    if (!press || event.pointerId !== press.id) return;
    view.clearTimeout(timers.press);
    stopFollowing();
    if (press.dragging) {
      suppressClick = true;
      rail.classList.remove('dragging');
      const width = view.innerWidth || 800, height = view.innerHeight || 600;
      placement = { side: event.clientX < width / 2 ? 'left' : 'right', top: Math.min(1, Math.max(0, event.clientY / height)) };
      position();
      void Promise.resolve(actions.place?.(placement)).catch(() => {});
    }
    press = undefined;
  }
  main.addEventListener('contextmenu', event => { if (press?.touch) event.preventDefault(); });
  const outside = (event: Event) => { if (expanded && !event.composedPath().includes(host)) setExpanded(false); };
  document.addEventListener('pointerdown', outside, true);
  rail.addEventListener('focusin', () => {
    // Keyboard focus reveals the panel; a mouse click focuses without it.
    if (quietFocus) return;
    try { if (root.activeElement?.matches(':focus-visible')) setExpanded(true); } catch { setExpanded(true); }
  });
  rail.addEventListener('focusout', event => {
    if (!rail.contains(event.relatedTarget as Node | null) && !rail.matches(':hover')) setExpanded(false);
  });
  const onResize = () => { if (active) position(); };
  view.addEventListener('resize', onResize);

  main.addEventListener('click', event => {
    // The page can reach an open shadow root. Synthetic events must not spend
    // the user's configured-provider allowance or change translation state.
    if (!event.isTrusted || !active || main.disabled) return;
    if (suppressClick) { suppressClick = false; return; }
    if (retryFromMain()) run('start');
    else if (hasTranslation()) run('restore');
    else run('start');
  });
  rail.addEventListener('click', event => {
    const target = (event.target as Element).closest('button');
    if (!event.isTrusted || !active || !target || target === main) return;
    const action = target.getAttribute('data-action');
    if (action === 'again' || action === 'retry') run('start');
    else if (action === 'original') run('restore');
    else if (action === 'hide') { choosingHide = true; render(); choices.querySelector('button')?.focus(); }
    else if (action?.startsWith('hide-')) {
      const scope = action.slice(5) as HideScope;
      choosingHide = false;
      void Promise.resolve(actions.hide?.(scope)).catch(() => {});
    }
  });
  // Avoid triggering the site's own click or keyboard shortcuts from this UI.
  root.addEventListener('click', event => event.stopPropagation());
  root.addEventListener('keydown', event => {
    event.stopPropagation();
    if ((event as KeyboardEvent).key === 'Escape' && expanded) { setExpanded(false); quietFocus = true; main.focus(); quietFocus = false; }
  });

  const Observer = view.MutationObserver;
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
      for (const timer of Object.values(timers)) view.clearTimeout(timer);
      document.removeEventListener('pointerdown', outside, true);
      stopFollowing();
      view.removeEventListener('resize', onResize);
      for (const candidate of document.querySelectorAll(SELECTOR)) if (candidate.getAttribute('data-oit-control-instance') === instanceId) candidate.remove();
      if (instances.get(document) === controls) instances.delete(document);
    },
  };
  instances.set(document, controls);
  position(); render(); attach();
  return controls;
}
