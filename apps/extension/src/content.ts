import { PageTranslator, type PageStatus } from './engine';
import type { Settings } from './settings';
import { translateThroughJobs } from './transport';
import { createPageControls, type PageControls } from './page-controls';
import { translateNeeded } from './language';

declare global { var __oitContentInstalled: boolean | undefined; }

if (!globalThis.__oitContentInstalled) {
  globalThis.__oitContentInstalled = true;
  const engine = new PageTranslator(document);
  let controls: PageControls | undefined;
  const report = (status: PageStatus) => {
    controls?.update(status);
    void chrome.runtime.sendMessage({ type: 'oit:status', status }).catch(() => {});
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
    return false;
  });
  // Declarative injection is passive: no settings, scan or translation request
  // occurs until the user chooses Translate (or starts through the toolbar).
  const mount = () => {
    if (window.top !== window || controls) return;
    const command = async (type: string) => {
      const reply = await chrome.runtime.sendMessage({ type });
      if (reply?.error) throw new Error(reply.error);
    };
    controls = createPageControls(document, {
      start: () => command('oit:launcher-start'),
      restore: () => { engine.restore(); return command('oit:launcher-restore'); },
    });
    controls.update(engine.status());
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
