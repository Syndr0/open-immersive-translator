export interface Settings {
  backendUrl: string;
  readerUrl: string;
  targetLanguage: string;
  sourceLanguage: string;
  theme: 'subtle' | 'accent';
}

export const defaults: Settings = {
  backendUrl: 'http://127.0.0.1:8787',
  readerUrl: 'http://127.0.0.1:8787',
  targetLanguage: 'zh-Hans',
  sourceLanguage: 'auto',
  theme: 'subtle',
};

export function loopbackUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Use an HTTP localhost or 127.0.0.1 origin, for example http://127.0.0.1:8787.');
  }
  return url.origin;
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...defaults, ...(stored.settings ?? {}) } as Settings;
  settings.backendUrl = loopbackUrl(settings.backendUrl);
  settings.readerUrl = loopbackUrl(settings.readerUrl);
  return settings;
}
