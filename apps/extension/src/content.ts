import { PageTranslator, type PageStatus } from './engine';
import type { Settings } from './settings';
import { translateThroughJobs } from './transport';
import { createPageControls, type PageControls } from './page-controls';
import { translateNeeded } from './language';
import { LAUNCHER_KEY, hiddenOn, hideLauncher, readLauncherPrefs, savePlacement, showLauncher, type LauncherPrefs } from './launcher-prefs';

declare global { var __oitContentInstalled: boolean | undefined; }

if (!globalThis.__oitContentInstalled) {
  globalThis.__oitContentInstalled = true;
  const engine = new PageTranslator(document);
  const storage = globalThis.chrome?.storage?.local;
  const site = location.hostname;
  let controls: PageControls | undefined;
  // Hidden until reload: a toolbar "Show page button" brings it back.
  let hiddenForPage = false;
  let prefs: LauncherPrefs = {};
  const report = (status: PageStatus) => {
    controls?.update(status);
    void chrome.runtime.sendMessage({ type: 'oit:status', status }).catch(() => {});
  };
  const command = async (type: string) => {
    const reply = await chrome.runtime.sendMessage({ type });
    if (reply?.error) throw new Error(reply.error);
  };
  const unmount = () => { controls?.remove(); controls = undefined; };
  const sync = () => {
    if (window.top !== window || !document.body) return;
    if (hiddenForPage || hiddenOn(prefs, site)) { unmount(); return; }
    if (controls) return;
    controls = createPageControls(document, {
      start: () => command('oit:launcher-start'),
      restore: () => { engine.restore(); return command('oit:launcher-restore'); },
      place: placement => { prefs = { ...prefs, placement }; return savePlacement(storage, placement); },
      hide: scope => {
        if (scope === 'page') { hiddenForPage = true; sync(); return; }
        prefs = scope === 'everywhere' ? { ...prefs, hiddenEverywhere: true } : { ...prefs, hiddenSites: [...(prefs.hiddenSites ?? []), site] };
        sync();
        return hideLauncher(storage, scope, site);
      },
    }, { placement: prefs.placement, site, language: globalThis.chrome?.i18n?.getUILanguage?.() });
    controls.update(engine.status());
  };

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'oit:start') {
      const settings = message.settings as Settings;
      engine.start({ targetLanguage: settings.targetLanguage, theme: settings.theme, onStatus: report,
        translate: (segments, signal, onProgress) => translateNeeded({ segments, targetLanguage: settings.targetLanguage, sourceLanguage: settings.sourceLanguage }, signal,
          (input, signal, progress) => translateThroughJobs(input, signal, async message => {
          const reply = await chrome.runtime.sendMessage(message);
          if (reply?.error) throw new Error(reply.error);
          return reply;
        }, 500, progress), onProgress),
      });
      controls?.update(engine.status());
      respond({ ok: true });
    } else if (message.type === 'oit:restore') {
      engine.restore(); respond({ ok: true });
    } else if (message.type === 'oit:page-status') respond(engine.status());
    else if (message.type === 'oit:launcher-visibility' && window.top === window) respond({ hidden: !controls });
    else if (message.type === 'oit:show-launcher' && window.top === window) {
      hiddenForPage = false;
      prefs = { ...prefs, hiddenEverywhere: false, hiddenSites: (prefs.hiddenSites ?? []).filter(value => value !== site) };
      sync();
      void showLauncher(storage, site).finally(() => respond({ ok: true }));
      return true;
    }
    return false;
  });
  // A hide or show chosen in another tab applies here too.
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !(LAUNCHER_KEY in changes)) return;
    const next = (changes[LAUNCHER_KEY].newValue ?? {}) as LauncherPrefs;
    const moved = JSON.stringify(next.placement) !== JSON.stringify(prefs.placement);
    prefs = next;
    // Re-create only for a move made in another tab, so the button there follows.
    if (moved && controls) { unmount(); }
    sync();
  });
  // Declarative injection is passive: no settings, scan or translation request
  // occurs until the user chooses Translate (or starts through the toolbar).
  const mount = () => { void readLauncherPrefs(storage).then(value => { prefs = value; sync(); }); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
