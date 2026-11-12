import { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { type Health, jsonOptions, request } from './api';
import { type TranslationKey, type UiMessage, showMessage, uiError, useI18n } from './i18n';

const KINDS = ['google-free', 'google', 'ollama', 'compatible', 'codex'] as const;
type Kind = typeof KINDS[number];
interface SettingsResponse {
  active: Health['provider'];
  provider: {
    kind: string;
    ollama: { baseUrl: string; model: string };
    compatible: { baseUrl: string; model: string; hasApiKey: boolean };
    google: { hasApiKey: boolean };
    codex: { model: string };
  };
}
type TestResult = { ok: true; text: string } | { ok: false; error: string };

export const SERVICE_NAMES: Record<string, TranslationKey> = {
  'google-free': 'googleFreeTranslation', google: 'googleTranslation', ollama: 'localTranslation',
  compatible: 'compatibleTranslation', codex: 'codexTranslation', demo: 'demoProvider',
};
const HINTS: Record<Kind, TranslationKey> = {
  'google-free': 'hintGoogleFree', google: 'hintGoogle', ollama: 'hintOllama', compatible: 'hintCompatible', codex: 'hintCodex',
};
const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

/** Pick, try and save the translation service. Keys go to the local server and are never read back. */
export function ProviderSettings({ language, onChanged }: { language: string; onChanged: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [ollama, setOllama] = useState({ baseUrl: '', model: '' });
  const [compatible, setCompatible] = useState({ baseUrl: '', model: '', apiKey: '' });
  const [googleKey, setGoogleKey] = useState('');
  const [codexModel, setCodexModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; message: UiMessage } | null>(null);

  function adopt(next: SettingsResponse) {
    setSettings(next);
    setKind(isKind(next.provider.kind) ? next.provider.kind : null);
    setOllama(next.provider.ollama);
    setCompatible({ baseUrl: next.provider.compatible.baseUrl, model: next.provider.compatible.model, apiKey: '' });
    setGoogleKey(''); setCodexModel(next.provider.codex.model);
  }
  useEffect(() => {
    const controller = new AbortController();
    request<SettingsResponse>('/api/settings', { signal: controller.signal }).then(adopt)
      .catch(() => { if (!controller.signal.aborted) setStatus({ tone: 'error', message: { key: 'apiNotConnected' } }); });
    return () => controller.abort();
  }, []);

  // Only the selected service's fields are sent; a blank key means "keep the saved one".
  const input = (selected: Kind, removeKey = false) => ({
    kind: selected,
    ...(selected === 'ollama' ? { ollama }
      : selected === 'compatible' ? { compatible: { baseUrl: compatible.baseUrl, model: compatible.model, ...(removeKey ? { apiKey: '' } : compatible.apiKey ? { apiKey: compatible.apiKey } : {}) } }
      : selected === 'google' ? { google: removeKey ? { apiKey: '' } : googleKey ? { apiKey: googleKey } : {} }
      : selected === 'codex' ? { codex: { model: codexModel } } : {}),
  });

  const server = kind === 'ollama' ? ollama.baseUrl : kind === 'compatible' ? compatible.baseUrl : '';
  // Bumped to refetch suggestions for the same server, e.g. once it has been started.
  const [modelsRefresh, setModelsRefresh] = useState(0);
  const modelsFor = useRef('');
  useEffect(() => {
    if (modelsFor.current !== `${kind}|${server}`) { modelsFor.current = `${kind}|${server}`; setModels([]); }
    if (!server || (kind !== 'ollama' && kind !== 'compatible')) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      request<{ models: string[] }>('/api/settings/provider/models', jsonOptions(input(kind), controller.signal))
        .then((result) => setModels(result.models)).catch(() => {});
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
    // Suggestions depend on the server only; typing a key or model must not refetch them.
  }, [kind, server, modelsRefresh]);

  async function test() {
    if (!kind) return;
    setBusy('test'); setStatus(null);
    try {
      const result = await request<TestResult>('/api/settings/provider/test', jsonOptions({ ...input(kind), targetLanguage: language }));
      setStatus(result.ok ? { tone: 'ok', message: { key: 'testPassed', parameters: { text: result.text } } } : { tone: 'error', message: { raw: result.error } });
    } catch (caught) { setStatus({ tone: 'error', message: uiError(caught) }); }
    finally { setBusy(null); }
  }
  async function save(removeKey = false) {
    if (!kind) return;
    setBusy('save'); setStatus(null);
    try {
      const next = await request<SettingsResponse>('/api/settings/provider', { ...jsonOptions(input(kind, removeKey)), method: 'PUT' });
      adopt(next); onChanged(); setModelsRefresh((value) => value + 1);
      setStatus(next.active.configured ? { tone: 'ok', message: { key: 'serviceSaved' } } : { tone: 'error', message: { key: 'providerIncomplete' } });
    } catch (caught) { setStatus({ tone: 'error', message: uiError(caught) }); }
    finally { setBusy(null); }
  }

  const hasKey = kind === 'compatible' ? settings?.provider.compatible.hasApiKey : kind === 'google' ? settings?.provider.google.hasApiKey : false;
  const keyField = (value: string, change: (value: string) => void) => <label className="field">
    <span>{t('fieldApiKey')}</span>
    <span className="field-row">
      <input type="password" autoComplete="off" spellCheck={false} value={value} placeholder={hasKey ? t('keySaved') : ''} onChange={(event) => change(event.target.value)} />
      {hasKey && <button type="button" className="text-button" disabled={!!busy} onClick={() => void save(true)}>{t('removeKey')}</button>}
    </span>
  </label>;
  const modelField = (value: string, change: (value: string) => void) => <label className="field">
    <span>{t('fieldModel')}</span>
    <input value={value} list={`${id}-models`} autoComplete="off" spellCheck={false} onFocus={() => setModelsRefresh((count) => count + 1)} onChange={(event) => change(event.target.value)} />
  </label>;
  const incomplete = !status && !!settings && !settings.active.configured && settings.active.kind === kind;

  return <form className="provider-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className="service-list" role="radiogroup" aria-label={t('ownProvider')}>
      {KINDS.map((option) => <label key={option} className={`service-option ${kind === option ? 'selected' : ''}`}>
        <input type="radio" name={`${id}-service`} value={option} checked={kind === option} disabled={!settings} onChange={() => { setKind(option); setStatus(null); }} />
        <span>{t(SERVICE_NAMES[option])}</span>
        {settings?.active.kind === option && <Check size={16} aria-label={t('serviceInUse')} />}
      </label>)}
    </div>
    {kind && <div className="service-fields">
      <p className="field-hint">{t(HINTS[kind])}{kind === 'google' && <> <a href="https://docs.cloud.google.com/translate/docs/setup" target="_blank" rel="noopener noreferrer">{t('googleSetupDocs')} ↗</a></>}</p>
      {kind === 'ollama' && <>
        <label className="field"><span>{t('fieldServer')}</span><input type="url" value={ollama.baseUrl} autoComplete="off" spellCheck={false} onChange={(event) => setOllama({ ...ollama, baseUrl: event.target.value })} /></label>
        {modelField(ollama.model, (model) => setOllama({ ...ollama, model }))}
      </>}
      {kind === 'compatible' && <>
        <label className="field"><span>{t('fieldServer')}</span><input type="url" value={compatible.baseUrl} autoComplete="off" spellCheck={false} onChange={(event) => setCompatible({ ...compatible, baseUrl: event.target.value })} /></label>
        {modelField(compatible.model, (model) => setCompatible({ ...compatible, model }))}
        {keyField(compatible.apiKey, (apiKey) => setCompatible({ ...compatible, apiKey }))}
      </>}
      {kind === 'google' && keyField(googleKey, setGoogleKey)}
      {kind === 'codex' && modelField(codexModel, setCodexModel)}
      <datalist id={`${id}-models`}>{models.map((name) => <option key={name} value={name} />)}</datalist>
    </div>}
    <div className="service-actions">
      <button type="button" className="button outline" disabled={!kind || !!busy} onClick={() => void test()}>{busy === 'test' && <LoaderCircle size={15} className="spin" />}{t('testService')}</button>
      <button type="submit" className="button primary" disabled={!kind || !!busy}>{busy === 'save' && <LoaderCircle size={15} className="spin" />}{t('saveService')}</button>
    </div>
    <p className={`service-status ${status?.tone ?? (incomplete ? 'error' : '')}`} role="status" aria-live="polite">{status ? showMessage(status.message, t) : incomplete ? t('providerIncomplete') : ''}</p>
  </form>;
}
