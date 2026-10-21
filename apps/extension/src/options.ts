import { getSettings, loopbackUrl, type Settings } from './settings';
import { bindAgentHelp } from './agent-help';

bindAgentHelp();

const field = (id: string) => document.getElementById(id)! as HTMLInputElement;
const message = document.getElementById('message')!;
void getSettings().then(settings => {
  field('backend').value = settings.backendUrl;
  field('reader-url').value = settings.readerUrl;
  field('target').value = settings.targetLanguage;
  field('source').value = settings.sourceLanguage;
  field('theme').value = settings.theme;
}).catch(error => { message.textContent = String(error); });

document.getElementById('form')!.addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const settings: Settings = {
      backendUrl: loopbackUrl(field('backend').value.trim()),
      readerUrl: loopbackUrl(field('reader-url').value.trim()),
      targetLanguage: field('target').value.trim(),
      sourceLanguage: field('source').value.trim(),
      theme: field('theme').value === 'accent' ? 'accent' : 'subtle',
    };
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,34}$/.test(settings.targetLanguage) || !/^[a-zA-Z][a-zA-Z0-9-]{0,34}$/.test(settings.sourceLanguage)) throw new Error('Use language tags such as auto, en or zh-Hans.');
    await chrome.storage.local.set({ settings });
    message.textContent = 'Saved. Start translation again to apply these settings.';
  })().catch(error => { message.textContent = error instanceof Error ? error.message : String(error); });
});
