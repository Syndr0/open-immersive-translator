import { defaults, type Settings } from './settings';
import type { PageStatus } from './engine';
import { bindAgentHelp } from './agent-help';

bindAgentHelp();

const element = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
const language = element<HTMLSelectElement>('language');
const translate = element<HTMLButtonElement>('translate');
const error = element('error');
const connection = element('connection');
const status = element('status');
let tabId: number | undefined;

async function send(message: Record<string, unknown>): Promise<any> {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply?.error) throw new Error(reply.error);
  return reply;
}
async function updateStatus(): Promise<void> {
  if (tabId === undefined) return;
  const value = await send({ type: 'oit:tab-status', tabId }) as PageStatus;
  status.textContent = value.state === 'idle' ? 'The original page stays intact.' : `${value.translated} of ${value.total} paragraphs translated${value.failed ? ` · ${value.failed} unavailable` : ''}${value.pending ? ' · Scroll to translate more' : ''}`;
}
async function action(task: () => Promise<unknown>): Promise<void> {
  error.textContent = '';
  translate.disabled = true;
  try { await task(); await updateStatus(); }
  catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'The request failed.'; }
  finally { translate.disabled = false; }
}

language.addEventListener('change', () => { void action(() => send({ type: 'oit:save-settings', settings: { targetLanguage: language.value } })); });
translate.addEventListener('click', () => { void action(async () => {
  if (tabId === undefined) throw new Error('Open a regular website tab first.');
  await send({ type: 'oit:save-settings', settings: { targetLanguage: language.value } });
  await send({ type: 'oit:start-tab', tabId });
}); });
element('restore').addEventListener('click', () => { void action(() => send({ type: 'oit:restore-tab', tabId })); });
element('reader').addEventListener('click', () => { void action(() => send({ type: 'oit:reader' })); });
element('settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });

void (async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tabs[0]?.id;
  const settings: Settings = await send({ type: 'oit:settings' }).catch(() => defaults);
  if (![...language.options].some(option => option.value === settings.targetLanguage)) language.add(new Option(settings.targetLanguage, settings.targetLanguage));
  language.value = settings.targetLanguage;
  try {
    const health = await send({ type: 'oit:health' });
    connection.classList.add('ok');
    connection.textContent = health.provider?.configured === false ? 'Setup needed · Use Copy for your agent below' : health.provider?.kind === 'demo' ? 'DEMO MODE · Test output, not real translation' : `${health.provider?.kind ?? 'Local server'} · ${health.provider?.model ?? 'Connected'}`;
  } catch {
    connection.textContent = 'Service unavailable · Use Copy for your agent below';
  }
  await updateStatus().catch(() => {});
  setInterval(() => { void updateStatus().catch(() => {}); }, 1200);
})().catch(cause => { error.textContent = String(cause); });
