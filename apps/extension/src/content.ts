import { PageTranslator, type PageStatus } from './engine';
import type { Settings } from './settings';
import { translateThroughJobs } from './transport';

declare global { var __oitContentInstalled: boolean | undefined; }

if (!globalThis.__oitContentInstalled) {
  globalThis.__oitContentInstalled = true;
  const engine = new PageTranslator(document);
  const report = (status: PageStatus) => {
    void chrome.runtime.sendMessage({ type: 'oit:status', status }).catch(() => {});
  };
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'oit:start') {
      const settings = message.settings as Settings;
      engine.start({ targetLanguage: settings.targetLanguage, theme: settings.theme, onStatus: report,
        translate: (segments, signal) => translateThroughJobs({ segments, targetLanguage: settings.targetLanguage, sourceLanguage: settings.sourceLanguage }, signal, async message => {
          const reply = await chrome.runtime.sendMessage(message);
          if (reply?.error) throw new Error(reply.error);
          return reply;
        }),
      });
      respond({ ok: true });
    } else if (message.type === 'oit:restore') {
      engine.restore(); respond({ ok: true });
    } else if (message.type === 'oit:page-status') respond(engine.status());
    return false;
  });
}
