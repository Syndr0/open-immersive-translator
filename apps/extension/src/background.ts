import { getSettings, type Settings } from './settings';
import type { PageStatus } from './engine';
import { FrameRegistry } from './frames';

const frames = new FrameRegistry(chrome.storage.session);
const statuses = new Map<number, Map<number, PageStatus>>();

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const settings = await getSettings();
  const response = await fetch(`${settings.backendUrl}${path}`, {
    ...init, signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? body.error ?? `Server returned ${response.status}.`);
  return body;
}

async function start(tabId: number): Promise<unknown> {
  const settings = await getSettings();
  // Injection is granted only after the user opens the extension on this tab.
  let injected: chrome.scripting.InjectionResult[];
  try {
    injected = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch {
    injected = await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
  const frameIds = injected.map(item => item.frameId);
  await chrome.scripting.insertCSS({ target: { tabId, frameIds }, files: ['content.css'] });
  await frames.remember(tabId, frameIds);
  statuses.set(tabId, new Map());
  const replies = await Promise.allSettled(frameIds.map(frameId => chrome.tabs.sendMessage(tabId, { type: 'oit:start', settings }, { frameId })));
  if (replies.every(reply => reply.status === 'rejected')) throw new Error('This page does not allow extension translation. Try a regular website tab.');
  return { ok: true, frames: replies.filter(reply => reply.status === 'fulfilled').length };
}

async function restore(tabId: number): Promise<unknown> {
  await Promise.allSettled((await frames.get(tabId)).map(frameId => chrome.tabs.sendMessage(tabId, { type: 'oit:restore' }, { frameId })));
  statuses.delete(tabId);
  return { ok: true };
}

async function status(tabId: number): Promise<PageStatus> {
  // Asking the content scripts also recovers state after a worker suspension.
  const fresh = await Promise.allSettled((await frames.get(tabId)).map(frameId => chrome.tabs.sendMessage(tabId, { type: 'oit:page-status' }, { frameId })));
  const values = fresh.filter((value): value is PromiseFulfilledResult<PageStatus> => value.status === 'fulfilled' && !!value.value?.state).map(value => value.value);
  if (!values.length) return { state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 };
  return values.reduce((combined, value) => ({
    state: combined.state === 'translating' || value.state === 'translating' ? 'translating' : value.state === 'ready' || combined.state === 'ready' ? 'ready' : 'idle',
    total: combined.total + value.total, translated: combined.translated + value.translated,
    failed: combined.failed + value.failed, pending: combined.pending + value.pending,
  }), { state: 'idle', total: 0, translated: 0, failed: 0, pending: 0 } as PageStatus);
}

async function handle(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (message.type === 'oit:status') {
    if (sender.tab?.id !== undefined) {
      const byFrame = statuses.get(sender.tab.id) ?? new Map();
      byFrame.set(sender.frameId ?? 0, message.status as PageStatus);
      statuses.set(sender.tab.id, byFrame);
    }
    return { ok: true };
  }
  if (message.type === 'oit:translation-start') {
    if (!sender.tab) throw new Error('Translation requests must come from a translated tab.');
    return request('/api/translation-jobs', { method: 'POST', body: JSON.stringify({ segments: message.segments, targetLanguage: message.targetLanguage, sourceLanguage: message.sourceLanguage }) });
  }
  if (message.type === 'oit:translation-status' || message.type === 'oit:translation-cancel') {
    if (!sender.tab) throw new Error('Translation requests must come from a translated tab.');
    if (typeof message.jobId !== 'string' || !/^[0-9a-f-]{36}$/.test(message.jobId)) throw new Error('Invalid translation job ID.');
    return request(`/api/jobs/${message.jobId}${message.type === 'oit:translation-cancel' ? '/cancel' : ''}`, { method: message.type === 'oit:translation-cancel' ? 'POST' : 'GET' });
  }
  // Commands are accepted only from this extension's own pages.
  if (sender.tab) throw new Error('This command is available only in the extension popup.');
  if (message.type === 'oit:health') return request('/api/health');
  if (message.type === 'oit:settings') return getSettings();
  if (message.type === 'oit:save-settings') {
    const old = await getSettings();
    const settings = { ...old, ...(message.settings as Partial<Settings>) };
    await chrome.storage.local.set({ settings });
    return { ok: true };
  }
  if (message.type === 'oit:start-tab') return start(Number(message.tabId));
  if (message.type === 'oit:restore-tab') return restore(Number(message.tabId));
  if (message.type === 'oit:tab-status') return status(Number(message.tabId));
  if (message.type === 'oit:reader') {
    const settings = await getSettings();
    await chrome.tabs.create({ url: settings.readerUrl });
    return { ok: true };
  }
  throw new Error('Unknown extension command.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  void handle(message as Record<string, unknown>, sender).then(respond).catch(error => respond({ error: error instanceof Error ? error.message : 'Extension request failed.' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => { void frames.forget(tabId).catch(() => {}); statuses.delete(tabId); });
