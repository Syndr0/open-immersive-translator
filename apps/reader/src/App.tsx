import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, Check, Columns2, Copy, FileText, Globe2, Languages, LoaderCircle,
  Menu, MessageSquareText, Pencil, Plus, Printer, RefreshCw, Trash2, Upload, X,
} from 'lucide-react';
import {
  type DocumentBlock, type DocumentResponse, type DocumentSummary, type Health, type ReadingDocument,
  type TranslationJob, MAX_UPLOAD_BYTES, isAborted, jsonOptions, readRecentIds,
  request, wait, writeRecentIds,
} from './api';
import { I18nProvider, LocalizedError, type TranslationKey, type UiMessage, showMessage, uiError, useI18n } from './i18n';
import { buildAgentPrompt, type AgentPromptKind } from './agent-prompts';
import { readReaderLink } from './reader-links';

const LANGUAGES = [
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
] as const;
type Mode = 'bilingual' | 'translated' | 'source';
type Panel = 'settings' | 'extension' | 'document-agent' | null;

const PROVIDER_NAMES: Record<string, TranslationKey> = {
  codex: 'codexTranslation', ollama: 'localTranslation', 'google-free': 'googleFreeTranslation', google: 'googleTranslation', demo: 'demoProvider',
};
const languageName = (value: string) => LANGUAGES.find(([code]) => code === value)?.[1] ?? value;
const isRunning = (job: TranslationJob | null) => !!job && ['queued', 'running'].includes(job.status);
const summarize = ({ id, name, format, pageCount, blocks, createdAt }: ReadingDocument): DocumentSummary => ({ id, name, format, pageCount, blockCount: blocks.length, createdAt });
const documentPath = (id: string, language: string) => `/api/documents/${encodeURIComponent(id)}?targetLanguage=${encodeURIComponent(language)}`;

function ReaderApp() {
  const { locale, setLocale, t } = useI18n();
  const [initialLink] = useState(() => readReaderLink(window.location.search));
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [library, setLibrary] = useState<DocumentSummary[]>([]);
  const [document, setDocument] = useState<ReadingDocument | null>(null);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [target, setTarget] = useState(initialLink.targetLanguage);
  const [mode, setMode] = useState<Mode>('bilingual');
  const [busy, setBusy] = useState<'upload' | 'load' | null>(null);
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [error, setError] = useState<UiMessage>(initialLink.invalid ? { key: 'invalidDocumentLink' } : '');
  const [notice, setNotice] = useState<UiMessage>('');
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [original, setOriginal] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const epoch = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const activeJob = useRef<string | null>(null);

  const beginAction = useCallback(() => {
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    return { generation: ++epoch.current, signal: controller.signal };
  }, []);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try { setHealth(await request<Health>('/api/health')); }
    catch { setHealth(null); }
    finally { setHealthLoading(false); }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const controller = new AbortController();
    const generation = epoch.current;
    const requested = initialLink.requestedDocument && !initialLink.invalid ? initialLink.documentId : undefined;
    if (requested || (!initialLink.requestedDocument && !initialLink.invalid && readRecentIds().length)) setBusy('load');
    void (async () => {
      let documents: DocumentSummary[] = [];
      try { documents = (await request<{ documents: DocumentSummary[] }>('/api/documents', { signal: controller.signal })).documents; }
      catch { /* An offline server leaves the library empty; the banner explains why. */ }
      if (controller.signal.aborted || generation !== epoch.current) return;
      setLibrary(documents);
      // A link that names a document never silently falls back to a different one.
      const id = initialLink.requestedDocument || initialLink.invalid ? requested : readRecentIds().find((recent) => documents.some((item) => item.id === recent));
      if (id) {
        try {
          const response = await request<DocumentResponse>(documentPath(id, initialLink.targetLanguage), { signal: controller.signal });
          if (controller.signal.aborted || generation !== epoch.current) return;
          setDocument(response.document);
          setUnits(response.translations?.targetLanguage === initialLink.targetLanguage ? response.translations.units : {});
          writeRecentIds([id, ...readRecentIds()]);
        } catch {
          if (controller.signal.aborted || generation !== epoch.current) return;
          if (requested) setError({ key: 'documentLinkUnavailable' });
        }
      }
      setBusy(null);
    })();
    return () => { controller.abort(); actionController.current?.abort(); };
  }, [initialLink, refreshHealth]);

  useEffect(() => {
    if (!document) return;
    const url = new URL(window.location.href);
    url.searchParams.set('document', document.id);
    url.searchParams.set('targetLanguage', target);
    window.history.replaceState(window.history.state, '', url);
  }, [document?.id, target]);

  useEffect(() => {
    globalThis.document.title = document ? `${document.name} · ${t('appName')}` : t('appName');
  }, [document, t]);

  // Modal: focus moves in, Tab stays inside, Escape closes, focus returns to the opener.
  useEffect(() => {
    if (!panel) return;
    const opener = globalThis.document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPanel(null); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button, a[href], summary, textarea, select, input')].filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (globalThis.document.activeElement === first || globalThis.document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('keydown', handleKey); opener?.focus?.(); };
  }, [panel]);

  function remember(next: ReadingDocument) {
    setLibrary((previous) => previous.some((item) => item.id === next.id) ? previous : [summarize(next), ...previous]);
    writeRecentIds([next.id, ...readRecentIds()]);
  }

  async function cancelPrevious() {
    const id = activeJob.current;
    activeJob.current = null;
    if (id) {
      try { await request(`/api/jobs/${encodeURIComponent(id)}/cancel`, jsonOptions({})); }
      catch { /* A late or already-completed job cannot update the new view. */ }
    }
  }

  async function selectDocument(id: string, language = target) {
    const { generation, signal } = beginAction();
    void cancelPrevious();
    setBusy('load'); setError(''); setNotice(''); setJob(null); setOriginal(false); setMobileSidebar(false);
    try {
      const response = await request<DocumentResponse>(documentPath(id, language), { signal });
      if (generation !== epoch.current) return;
      setDocument(response.document);
      setUnits(response.translations?.targetLanguage === language ? response.translations.units : {});
      remember(response.document);
    } catch (caught) {
      if (!isAborted(caught) && generation === epoch.current) setError(uiError(caught));
    } finally { if (generation === epoch.current) setBusy(null); }
  }

  async function removeDocument(item: DocumentSummary) {
    if (!window.confirm(t('confirmDelete', { name: item.name }))) return;
    const current = document?.id === item.id;
    if (current) { beginAction(); await cancelPrevious(); }
    try {
      await request(`/api/documents/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    } catch (caught) {
      // Already gone on the server: still remove the stale entry here.
      if (!(caught instanceof Error && /not found/i.test(caught.message))) { setError(uiError(caught)); return; }
    }
    setLibrary((previous) => previous.filter((entry) => entry.id !== item.id));
    writeRecentIds(readRecentIds().filter((id) => id !== item.id));
    if (current) {
      setDocument(null); setUnits({}); setJob(null); setOriginal(false); setBusy(null); setNotice('');
      const url = new URL(window.location.href);
      url.searchParams.delete('document'); url.searchParams.delete('targetLanguage');
      window.history.replaceState(window.history.state, '', url);
    }
  }

  async function upload(file?: File) {
    if (!file) return;
    if (!/\.(pdf|txt|md|markdown|html?|docx)$/i.test(file.name)) { setError({ key: 'invalidDocument' }); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setError({ key: 'fileTooLarge' }); return; }
    const { generation, signal } = beginAction();
    void cancelPrevious();
    setBusy('upload'); setError(''); setNotice(''); setJob(null); setOriginal(false); setMobileSidebar(false);
    try {
      const response = await request<DocumentResponse>('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file, signal,
      });
      if (generation !== epoch.current) return;
      setDocument(response.document); setUnits({}); remember(response.document); setMode('bilingual');
      void refreshHealth();
    } catch (caught) {
      if (!isAborted(caught) && generation === epoch.current) setError(uiError(caught));
    } finally {
      if (generation === epoch.current) setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function translate() {
    if (!document || busy || isRunning(job)) return;
    const currentDocument = document;
    const currentTarget = target;
    const { generation, signal } = beginAction();
    setError(''); setNotice('');
    setJob({ id: '', status: 'queued', completed: 0, total: currentDocument.blocks.filter((block) => block.type !== 'code').length });
    try {
      const started = await request<{ jobId: string }>(`/api/documents/${encodeURIComponent(currentDocument.id)}/translate`, jsonOptions({ targetLanguage: currentTarget, sourceLanguage: 'auto' }, signal));
      if (generation !== epoch.current) {
        void request(`/api/jobs/${encodeURIComponent(started.jobId)}/cancel`, jsonOptions({})).catch(() => {});
        return;
      }
      activeJob.current = started.jobId;
      let fetched = -1;
      while (!signal.aborted && generation === epoch.current) {
        const next = await request<TranslationJob>(`/api/jobs/${encodeURIComponent(started.jobId)}`, { signal });
        if (generation !== epoch.current) return;
        setJob(next);
        const finished = !['queued', 'running'].includes(next.status);
        // Partial results matter (a failed paragraph must not hide successful ones),
        // but the document is only refetched when progress actually moved.
        if (finished || next.completed !== fetched) {
          fetched = next.completed;
          const response = await request<DocumentResponse>(documentPath(currentDocument.id, currentTarget), { signal });
          if (generation !== epoch.current) return;
          if (response.translations?.targetLanguage === currentTarget) setUnits(response.translations.units);
        }
        if (finished) {
          activeJob.current = null;
          if (next.status === 'completed') setNotice({ key: 'completedNotice' });
          else if (next.status === 'failed') setError(next.error ? { raw: next.error } : { key: 'partialTranslationError' });
          else setNotice({ key: 'stoppedNotice' });
          break;
        }
        await wait(850, signal);
      }
    } catch (caught) {
      if (!isAborted(caught) && generation === epoch.current) {
        setError(uiError(caught));
        setJob((previous) => previous ? { ...previous, status: 'failed' } : null);
        void cancelPrevious();
      }
    }
  }

  async function stop() {
    const { generation, signal } = beginAction();
    await cancelPrevious();
    if (generation !== epoch.current) return;
    setJob((previous) => previous ? { ...previous, status: 'cancelled' } : null);
    setNotice({ key: 'stoppedNotice' });
    if (document) {
      try {
        const response = await request<DocumentResponse>(documentPath(document.id, target), { signal });
        if (generation === epoch.current && response.translations?.targetLanguage === target) setUnits(response.translations.units);
      } catch { /* Keep the last successful snapshot visible. */ }
    }
  }

  async function saveUnit(blockId: string, text: string) {
    if (!document) return;
    const id = document.id;
    const generation = epoch.current;
    await request(`/api/documents/${encodeURIComponent(id)}/blocks/${encodeURIComponent(blockId)}`, {
      ...jsonOptions({ text, targetLanguage: target }), method: 'PATCH',
    });
    if (generation === epoch.current) setUnits((previous) => ({ ...previous, [blockId]: text }));
  }

  async function download(format: 'html' | 'md') {
    if (!document) return;
    setExporting(true); setError('');
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/export?format=${format}&mode=${mode === 'translated' ? 'translated' : 'bilingual'}&targetLanguage=${encodeURIComponent(target)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw typeof body.error === 'string' ? new Error(body.error) : new LocalizedError('exportError');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = globalThis.document.createElement('a');
      anchor.href = url; anchor.download = `${document.name.replace(/\.[^.]+$/, '')}-${target}.${format}`;
      globalThis.document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (caught) { setError(uiError(caught)); }
    finally { setExporting(false); }
  }

  const openPanel = (next: Panel) => { setPanel(next); setMobileSidebar(false); };
  const translatedCount = document?.blocks.filter((block) => block.type !== 'code' && Object.hasOwn(units, block.id)).length ?? 0;
  const totalCount = document?.blocks.filter((block) => block.type !== 'code').length ?? 0;
  const running = isRunning(job);
  const progress = job?.total ? Math.min(100, Math.round(job.completed / job.total * 100)) : 0;
  const offline = !health && !healthLoading;
  const demo = health?.provider.kind === 'demo';
  const providerName = health ? PROVIDER_NAMES[health.provider.kind] ? t(PROVIDER_NAMES[health.provider.kind]) : health.provider.kind : '';

  return (
    <div className="app-shell">
      <input ref={fileInput} className="visually-hidden" type="file" accept=".pdf,.txt,.md,.markdown,.html,.htm,.docx" aria-label={t('importDocument')} onChange={(event) => void upload(event.target.files?.[0])} />
      {mobileSidebar && <button className="sidebar-scrim" aria-label={t('closeLibrary')} onClick={() => setMobileSidebar(false)} />}
      <aside className={`sidebar ${mobileSidebar ? 'is-open' : ''}`}>
        <a className="brand" href="/" aria-label={t('home')}><Languages size={26} strokeWidth={2} /></a>
        <nav className="nav">
          <button className="nav-item active" aria-current="page" onClick={() => setMobileSidebar(false)}><FileText size={22} /><span>{t('documents')}</span></button>
          <button className="nav-item" onClick={() => openPanel('extension')}><Globe2 size={22} /><span>{t('websiteTranslation')}</span></button>
        </nav>
        <div className="library-heading">
          <span>{t('library')}</span>
          <button className="icon-button" aria-label={t('newDocument')} title={t('newDocument')} onClick={() => fileInput.current?.click()} disabled={busy === 'upload'}><Plus size={18} /></button>
        </div>
        <ul className="library-list">
          {library.map((item) => (
            <li key={item.id} className={`library-item ${document?.id === item.id ? 'selected' : ''}`}>
              <button className="library-open" onClick={() => void selectDocument(item.id)} disabled={busy === 'upload'} aria-current={document?.id === item.id ? 'true' : undefined}>
                <strong>{item.name}</strong>
                <small>{item.format.toUpperCase()}{item.pageCount ? ` · ${t('pages', { count: item.pageCount })}` : ''}</small>
              </button>
              <button className="icon-button library-delete" aria-label={t('deleteDocument', { name: item.name })} title={t('deleteDocument', { name: item.name })} onClick={() => void removeDocument(item)}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
        <button className="provider-card" onClick={() => openPanel('settings')} title={t('translationSettings')}>
          <span className={`status-dot ${offline ? 'offline' : demo || (health && !health.provider.configured) ? 'warning' : healthLoading ? '' : 'online'}`} />
          <span><strong>{healthLoading ? t('connecting') : offline ? t('serverOffline') : providerName}</strong>{health?.provider.model && <small>{health.provider.model}</small>}</span>
        </button>
      </aside>

      <main className="main-workspace">
        <header className="topbar page-heading">
          <button className="icon-button mobile-menu" aria-label={t('openLibrary')} onClick={() => setMobileSidebar(true)}><Menu size={20} /></button>
          <h1>{t('documents')}</h1>
          <div className="topbar-right">
            <button className="button outline agent-document-button" aria-label={t('useYourAgent')} onClick={() => setPanel('document-agent')}><MessageSquareText size={16} /><span>{t('useYourAgent')}</span></button>
            <div className="language-switch" role="group" aria-label={t('interfaceLanguage')}>
              <button type="button" data-testid="ui-language-zh" aria-pressed={locale === 'zh'} lang="zh-CN" onClick={() => setLocale('zh')}>中</button>
              <button type="button" data-testid="ui-language-en" aria-pressed={locale === 'en'} lang="en" onClick={() => setLocale('en')}>EN</button>
            </div>
          </div>
        </header>

        <div className="workspace-content">
          {offline && <div className="message warning"><AlertCircle size={18} /><span>{t('serverOfflineTitle')}</span><button className="text-button" onClick={() => void refreshHealth()}><RefreshCw size={14} />{t('reconnect')}</button></div>}
          {demo && <div className="message warning"><AlertCircle size={18} /><span>{t('demoTitle')}</span><button className="text-button" onClick={() => setPanel('settings')}>{t('setupProvider')}</button></div>}
          {error && <div className="message error" role="alert"><AlertCircle size={18} /><span>{showMessage(error, t)}</span><button className="icon-button" aria-label={t('dismissError')} onClick={() => setError('')}><X size={16} /></button></div>}
          {notice && <div className="message success" role="status"><Check size={18} /><span>{showMessage(notice, t)}</span><button className="icon-button" aria-label={t('dismissNotification')} onClick={() => setNotice('')}><X size={16} /></button></div>}

          {!document && !busy ? (
            <section className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
              <Upload size={28} strokeWidth={1.6} aria-hidden="true" />
              <h2>{dragging ? t('dropHere') : t('dropDocument')}</h2>
              <button className="button primary" onClick={() => fileInput.current?.click()}>{t('chooseDocument')}</button>
              <p>{t('supportedFormats')}</p>
            </section>
          ) : busy ? (
            <section className="loading-card" role="status"><LoaderCircle className="spin" size={28} /><span>{busy === 'upload' ? t('preparingDocument') : t('openingDocument')}</span></section>
          ) : document && (
            <section className="reader-card">
              <div className="document-toolbar">
                <div className="document-title">
                  <h2 title={document.name}>{document.name}</h2>
                  <p>{document.format.toUpperCase()}{document.pageCount ? ` · ${t('pages', { count: document.pageCount })}` : ''} · {t('translatedCount', { completed: translatedCount, total: totalCount })}</p>
                </div>
                {running
                  ? <button className="button primary" onClick={() => void stop()}>{t('stop')}</button>
                  : <button className="button primary" onClick={() => void translate()} disabled={offline || !health?.provider.configured || totalCount === 0}>{translatedCount > 0 ? t('translateAgain') : t('translateDocument')}</button>}
              </div>
              <div className="translation-toolbar">
                <div className="language-group">
                  <select aria-label={t('targetLanguage')} value={target} disabled={!!busy || running} onChange={(event) => { const next = event.target.value; setTarget(next); setUnits({}); void selectDocument(document.id, next); }}>
                    {!LANGUAGES.some(([code]) => code === target) && <option value={target}>{target}</option>}
                    {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                  <div className="segmented-control" role="group" aria-label={t('readingMode')}>{([['bilingual', 'bilingual'], ['translated', 'translation'], ['source', 'source']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{t(label)}</button>)}</div>
                </div>
                <div className="toolbar-actions">
                  {document.format.toLowerCase() === 'pdf' && <button className={`icon-button original-toggle ${original ? 'selected' : ''}`} aria-pressed={original} aria-label={t('originalPdf')} title={t('originalPdf')} onClick={() => setOriginal(!original)}><Columns2 size={17} /></button>}
                  <button className="text-button" disabled={exporting || running || translatedCount === 0} onClick={() => void download('md')}><ArrowDownToLine size={15} />Markdown</button>
                  <button className="text-button" disabled={exporting || running || translatedCount === 0} onClick={() => void download('html')}><ArrowDownToLine size={15} />HTML</button>
                  <button className="icon-button" disabled={running} aria-label={t('pdfPrint')} title={t('pdfPrint')} onClick={() => window.print()}><Printer size={17} /></button>
                </div>
              </div>
              {running && <div className="translation-progress" role="status" aria-label={t('translatingTo', { language: languageName(target) })}><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><span>{job?.completed ?? 0} / {job?.total ?? totalCount}</span></div>}
              {document.warnings.length > 0 && <details className="document-warnings"><summary>{t('documentNotes', { count: document.warnings.length })}</summary><ul>{document.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
              <div className={`reading-layout ${original ? 'with-original' : ''}`}>
                {original && <div className="original-preview"><iframe title={t('originalTitle', { name: document.name })} src={`/api/documents/${encodeURIComponent(document.id)}/source`} /></div>}
                <article className={`paper mode-${mode}`} lang={mode === 'translated' ? target : 'und'}>
                  <div className="print-title"><h1>{document.name}</h1><p>{languageName(target)}</p></div>
                  {document.blocks.length === 0 ? <div className="no-text"><h3>{t('noReadableText')}</h3><p>{t('needsOcr')}</p></div> : document.blocks.map((block, index) => <ReadingBlock key={block.id} block={block} translation={units[block.id]} mode={mode} language={target} index={index} editable={!running} onSave={(text) => saveUnit(block.id, text)} />)}
                </article>
              </div>
            </section>
          )}
        </div>
      </main>

      {panel && <div className="modal-backdrop" onClick={() => setPanel(null)}>
        <section ref={dialog} tabIndex={-1} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading" onClick={(event) => event.stopPropagation()}>
          <div className="modal-heading">
            <h2 id="settings-heading">{t(panel === 'settings' ? 'ownProvider' : panel === 'extension' ? 'translateWeb' : 'agentDocumentTitle')}</h2>
            <button className="icon-button" aria-label={t('closeDialog')} onClick={() => setPanel(null)}><X size={19} /></button>
          </div>
          {panel === 'settings' ? <>
            <div className="settings-status"><span className={`status-dot ${offline ? 'offline' : health?.provider.configured ? 'online' : 'warning'}`} /><div><strong>{health ? `${providerName} · ${health.provider.model}` : t('apiNotConnected')}</strong><small>{health ? health.provider.configured ? t('providerConfigured') : t('providerIncomplete') : t('expectedServer')}</small></div><button className="icon-button" aria-label={t('refreshServer')} onClick={() => void refreshHealth()}><RefreshCw size={16} className={healthLoading ? 'spin' : ''} /></button></div>
            <AgentPromptCard kind="provider" />
            <details className="manual-setup"><summary>{t('manualSetup')}</summary>
              <h3>{t('googleFreeSetup')}</h3><p>{t('googleFreeDescription')}</p><pre className="setup-code">{'TRANSLATION_PROVIDER=google-free'}</pre>
              <h3>{t('codexSetup')}</h3><p>{t('codexSetupDescription')}</p><pre className="setup-code">{'TRANSLATION_PROVIDER=codex\nCODEX_MODEL=gpt-6.1-sol\nCODEX_CLI_PATH=/absolute/path/to/codex'}</pre><p>{t('codexEnvNote')}</p><a className="text-button" href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noopener noreferrer">{t('codexSetupDocs')} ↗</a>
              <h3>{t('startLocal')}</h3><p>{t('startLocalDescription')}</p><pre className="setup-code">{'ollama pull qwen3.5:2b\nnpm install\nnpm run dev'}</pre><p>{t('localModelNote')}</p>
              <h3>{t('googleSetup')}</h3><p>{t('googleSetupDescription')}</p><pre className="setup-code">{'TRANSLATION_PROVIDER=google\nGOOGLE_TRANSLATE_API_KEY=your-google-cloud-api-key'}</pre><p>{t('googleEnvNote')}</p><a className="text-button" href="https://docs.cloud.google.com/translate/docs/setup" target="_blank" rel="noopener noreferrer">{t('googleSetupDocs')} ↗</a>
              <h3>{t('compatibleApi')}</h3><p>{t('compatibleFirst')} <code>.env</code>{t('compatibleSecond')} <code>.env.example</code> {t('compatibleLast')}</p><p>{t('parserNote')}</p>
            </details>
          </> : panel === 'extension' ? <>
            <AgentPromptCard kind="website" />
            <details className="manual-setup"><summary>{t('manualSetup')}</summary><ol className="setup-steps">
              <li><strong>{t('buildExtension')}</strong><code>npm run build --workspace @oit/extension</code></li>
              <li><strong>{t('loadChrome')}</strong><p>{t('loadChromeFirst')} <code>chrome://extensions</code>{t('loadChromeSecond')} <code>apps/extension/dist</code>{t('loadChromeLast')}</p></li>
              <li><strong>{t('chooseAndTranslate')}</strong><p>{t('extensionUse')}</p></li>
            </ol></details>
            <p className="settings-footnote">{t('extensionPrivacy')}</p>
          </> : <>
            {document && <p className="agent-document-context">{t('agentExistingDocument', { name: document.name, language: languageName(target) })}</p>}
            <ol className="setup-steps agent-document-steps">
              <li><strong>{t(document ? 'agentDocumentStep1Existing' : 'agentDocumentStep1')}</strong></li>
              <li><strong>{t('agentDocumentStep2')}</strong></li>
              <li><strong>{t('agentDocumentStep3')}</strong></li>
            </ol>
            <AgentPromptCard kind="document" document={document} targetLanguage={document ? target : undefined} />
          </>}
        </section>
      </div>}
    </div>
  );
}

function AgentPromptCard({ kind, document, targetLanguage }: {
  kind: AgentPromptKind; document?: ReadingDocument | null; targetLanguage?: string;
}) {
  const { locale, t } = useI18n();
  const prompt = buildAgentPrompt({ kind, locale, documentId: document?.id, documentName: document?.name, targetLanguage });
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const [previewOpen, setPreviewOpen] = useState(false);
  const promptField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setCopyState('idle'); }, [prompt]);
  useEffect(() => {
    if (copyState !== 'fallback' || !previewOpen) return;
    const frame = requestAnimationFrame(() => {
      promptField.current?.focus();
      promptField.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [copyState, previewOpen]);

  async function copyPrompt() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      setPreviewOpen(true);
      setCopyState('fallback');
    }
  }

  return <section className="agent-assist" data-agent-prompt={kind}>
    {kind !== 'document' && <h3>{t('letAgentSetup')}</h3>}
    <button className="button primary agent-copy-button" onClick={() => void copyPrompt()}>{copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}{t('copyForAgent')}</button>
    {copyState !== 'idle' && <p className={`agent-copy-status ${copyState}`} role="status" aria-live="polite">{t(copyState === 'copied' ? 'promptCopied' : 'promptCopyFallback')}</p>}
    <details className="agent-prompt-preview" open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
      <summary>{t('previewAgentRequest')}</summary>
      <textarea ref={promptField} aria-label={t('agentRequestLabel')} value={prompt} readOnly rows={9} spellCheck={false} />
    </details>
  </section>;
}

function ReadingBlock({ block, translation, mode, language, index, editable, onSave }: {
  block: DocumentBlock; translation?: string; mode: Mode; language: string; index: number;
  editable: boolean; onSave: (text: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(translation ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiMessage>('');
  useEffect(() => { setDraft(translation ?? ''); setEditing(false); setError(''); }, [translation, language]);
  const isProtected = block.type === 'code';
  const translated = typeof translation === 'string';
  const canEdit = editable && translated && !isProtected;
  const showSource = mode !== 'translated' || isProtected || !translated;

  async function save() {
    setSaving(true); setError('');
    try { await onSave(draft); setEditing(false); }
    catch (caught) { setError(uiError(caught)); }
    finally { setSaving(false); }
  }

  return <section className={`reading-block block-${block.type} ${translated ? 'has-translation' : ''}`} data-block-id={block.id}>
    {showSource && <div className={`source-content ${mode === 'bilingual' && translated ? 'muted-source' : ''}`}><BlockContent block={block} text={block.text} />{mode === 'translated' && !translated && !isProtected && <span className="untranslated-note">{t('sourceUntranslated')}</span>}</div>}
    {!isProtected && mode !== 'source' && translated ? <div className="translated-content" lang={language} dir={['ar', 'he', 'fa', 'ur'].includes(language) ? 'rtl' : 'auto'}>
      {editing ? <><div className="edit-area"><textarea aria-label={t('editBlock', { number: index + 1 })} value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(14, Math.max(3, Math.ceil(draft.length / 75)))} autoFocus /><div className="edit-actions"><button className="button ghost" onClick={() => { setEditing(false); setDraft(translation); setError(''); }} disabled={saving}>{t('cancel')}</button><button className="button primary" onClick={() => void save()} disabled={saving || !draft.trim()}>{saving && <LoaderCircle size={14} className="spin" />}{t('saveEdit')}</button></div>{error && <p className="edit-error" role="alert">{showMessage(error, t)}</p>}</div><div className="saved-print"><BlockContent block={block} text={translation} /></div></> : <><BlockContent block={block} text={translation} />{canEdit && <button className="edit-block-button" aria-label={t('editBlock', { number: index + 1 })} onClick={() => { setDraft(translation); setEditing(true); }}><Pencil size={14} /></button>}</>}
    </div> : null}
  </section>;
}

function BlockContent({ block, text }: { block: DocumentBlock; text: string }) {
  if (block.type === 'code') return <pre><code>{text}</code></pre>;
  if (block.type === 'heading') {
    const level = Math.min(6, Math.max(2, block.level ?? 2));
    if (level === 2) return <h2>{text}</h2>;
    if (level === 3) return <h3>{text}</h3>;
    return <h4>{text}</h4>;
  }
  if (block.type === 'table') {
    const rows = text.trim().split('\n').map((line) => line.trim()).filter((line) => line.includes('|') && !/^\|?[\s:|-]+\|?$/.test(line)).map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    if (rows.length) return <div className="table-scroll"><table><thead><tr>{rows[0].map((cell, i) => <th key={i}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>;
  }
  return <p>{text}</p>;
}

function App() {
  return <I18nProvider><ReaderApp /></I18nProvider>;
}

export default App;
