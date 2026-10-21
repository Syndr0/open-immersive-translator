import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2,
  ChevronRight, Columns2, FileText, Globe2, Languages, LoaderCircle, Menu,
  Pause, Pencil, Plus, Printer, RefreshCw, Settings2, ShieldCheck, Upload, X,
} from 'lucide-react';
import {
  type DocumentBlock, type DocumentResponse, type Health, type ReadingDocument,
  type TranslationJob, isAborted, jsonOptions, readRecentIds,
  request, wait, writeRecentIds,
} from './api';
import { I18nProvider, LocalizedError, type UiMessage, showMessage, uiError, useI18n } from './i18n';

const LANGUAGES = [
  ['zh-Hans', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'], ['hi', 'हिन्दी'],
] as const;
type Mode = 'bilingual' | 'translated' | 'source';
type Panel = 'settings' | 'extension' | null;

const languageName = (value: string) => LANGUAGES.find(([code]) => code === value)?.[1] ?? value;
const isRunning = (job: TranslationJob | null) => !!job && ['queued', 'running'].includes(job.status);

function ReaderApp() {
  const { locale, setLocale, t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [recent, setRecent] = useState<ReadingDocument[]>([]);
  const [document, setDocument] = useState<ReadingDocument | null>(null);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [target, setTarget] = useState('zh-Hans');
  const [mode, setMode] = useState<Mode>('bilingual');
  const [busy, setBusy] = useState<'upload' | 'load' | null>(null);
  const [job, setJob] = useState<TranslationJob | null>(null);
  const [error, setError] = useState<UiMessage>('');
  const [notice, setNotice] = useState<UiMessage>('');
  const [dragging, setDragging] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [original, setOriginal] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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
    void (async () => {
      const responses = await Promise.all(readRecentIds().map(async (id) => {
        try { return await request<DocumentResponse>(`/api/documents/${encodeURIComponent(id)}?targetLanguage=zh-Hans`, { signal: controller.signal }); }
        catch { return null; }
      }));
      if (controller.signal.aborted || generation !== epoch.current) return;
      const found = responses.filter((value): value is DocumentResponse => !!value);
      setRecent(found.map((value) => value.document));
      if (found[0]) {
        setDocument(found[0].document);
        setUnits(found[0].translations?.targetLanguage === 'zh-Hans' ? found[0].translations.units : {});
      }
    })();
    return () => { controller.abort(); actionController.current?.abort(); };
  }, [refreshHealth]);

  useEffect(() => {
    globalThis.document.title = document ? `${document.name} · ${t('appName')}` : t('appName');
  }, [document, t]);

  useEffect(() => {
    if (!panel) return;
    const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [panel]);

  function remember(next: ReadingDocument) {
    setRecent((previous) => {
      const list = [next, ...previous.filter((item) => item.id !== next.id)].slice(0, 12);
      writeRecentIds(list.map((item) => item.id));
      return list;
    });
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
      const response = await request<DocumentResponse>(`/api/documents/${encodeURIComponent(id)}?targetLanguage=${encodeURIComponent(language)}`, { signal });
      if (generation !== epoch.current) return;
      setDocument(response.document);
      setUnits(response.translations?.targetLanguage === language ? response.translations.units : {});
      remember(response.document);
    } catch (caught) {
      if (!isAborted(caught) && generation === epoch.current) setError(uiError(caught));
    } finally { if (generation === epoch.current) setBusy(null); }
  }

  async function upload(file?: File) {
    if (!file) return;
    if (!/\.(pdf|txt|md|markdown|html?|docx)$/i.test(file.name)) {
      setError({ key: 'invalidDocument' }); return;
    }
    const { generation, signal } = beginAction();
    void cancelPrevious();
    setBusy('upload'); setError(''); setNotice(''); setJob(null); setOriginal(false);
    try {
      const response = await request<DocumentResponse>('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
        body: file, signal,
      });
      if (generation !== epoch.current) return;
      setDocument(response.document); setUnits({}); remember(response.document); setMode('bilingual');
      setNotice({ key: 'importedNotice' });
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
      while (!signal.aborted && generation === epoch.current) {
        const next = await request<TranslationJob>(`/api/jobs/${encodeURIComponent(started.jobId)}`, { signal });
        if (generation !== epoch.current) return;
        setJob(next);
        // Fetch partial results as well: a failed paragraph must not hide successful ones.
        const response = await request<DocumentResponse>(`/api/documents/${encodeURIComponent(currentDocument.id)}?targetLanguage=${encodeURIComponent(currentTarget)}`, { signal });
        if (generation !== epoch.current) return;
        if (response.translations?.targetLanguage === currentTarget) setUnits(response.translations.units);
        if (!['queued', 'running'].includes(next.status)) {
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
        const response = await request<DocumentResponse>(`/api/documents/${encodeURIComponent(document.id)}?targetLanguage=${encodeURIComponent(target)}`, { signal });
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

  const translatedCount = document?.blocks.filter((block) => block.type !== 'code' && Object.hasOwn(units, block.id)).length ?? 0;
  const totalCount = document?.blocks.filter((block) => block.type !== 'code').length ?? 0;
  const running = isRunning(job);
  const progress = job?.total ? Math.min(100, Math.round(job.completed / job.total * 100)) : 0;
  const offline = !health && !healthLoading;
  const demo = health?.provider.kind === 'demo';

  return (
    <div className="app-shell">
      <input ref={fileInput} className="visually-hidden" type="file" accept=".pdf,.txt,.md,.markdown,.html,.htm,.docx" aria-label={t('importDocument')} onChange={(event) => void upload(event.target.files?.[0])} />
      {mobileSidebar && <button className="sidebar-scrim" aria-label={t('closeLibrary')} onClick={() => setMobileSidebar(false)} />}
      <aside className={`sidebar ${mobileSidebar ? 'is-open' : ''}`}>
        <a className="brand" href="/" aria-label={t('home')}>
          <span className="brand-mark"><BookOpen size={23} strokeWidth={1.8} /></span>
          <span>open<span className="brand-second">immersive</span></span>
          <span className="brand-dot" />
        </a>
        <div className="workspace-label">{t('yourWorkspace')} <span>01</span></div>
        <button className="nav-item active" onClick={() => setMobileSidebar(false)}><FileText size={17} /><span>{t('documentTranslation')}</span><ChevronRight size={14} /></button>
        <button className="nav-item" onClick={() => { setPanel('extension'); setMobileSidebar(false); }}><Globe2 size={17} /><span>{t('websiteTranslation')}</span><span className="tiny-tag">{t('extensionShort')}</span></button>
        <div className="library-heading"><span>{t('library')}</span><span>{recent.length.toString().padStart(2, '0')}</span></div>
        <button className="import-button" onClick={() => fileInput.current?.click()} disabled={!!busy}><Plus size={17} />{t('importDocument')}</button>
        <div className="library-list">
          {recent.length === 0 ? <div className="library-empty"><FileText size={26} strokeWidth={1.1} /><p>{t('libraryEmptyFirst')}<br />{t('libraryEmptySecond')}</p></div> : recent.map((item) => (
            <button key={item.id} className={`library-item ${document?.id === item.id ? 'selected' : ''}`} onClick={() => void selectDocument(item.id)} disabled={busy === 'upload'}>
              <span className="file-mini"><FileText size={17} /></span><span><strong>{item.name}</strong><small>{item.format.toUpperCase()} · {t('blocks', { count: item.blocks.length })}</small></span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button className="provider-card" onClick={() => setPanel('settings')}>
            <span className={`status-dot ${offline ? 'offline' : demo ? 'demo' : ''}`} />
            <span><strong>{healthLoading ? t('connecting') : offline ? t('serverOffline') : demo ? t('demoProvider') : health?.provider.kind === 'ollama' ? t('localTranslation') : t('yourProvider')}</strong><small>{health?.provider.model || t('configureBackend')}</small></span>
            <Settings2 size={15} />
          </button>
          <div className="sidebar-foot"><span>{t('openPossibilities')}</span><span>v{health?.version ?? '0.1.0'}</span></div>
        </div>
      </aside>

      <main className="main-workspace">
        <header className="topbar">
          <div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label={t('openLibrary')} onClick={() => setMobileSidebar(true)}><Menu size={20} /></button><span>{t('workspace')}</span><ChevronRight size={13} /><strong>{t('documents')}</strong></div>
          <div className="topbar-right"><div className="language-switch" role="group" aria-label={t('interfaceLanguage')}><button type="button" data-testid="ui-language-zh" aria-pressed={locale === 'zh'} lang="zh-CN" onClick={() => setLocale('zh')}>中</button><button type="button" data-testid="ui-language-en" aria-pressed={locale === 'en'} lang="en" onClick={() => setLocale('en')}>EN</button></div><span className="open-badge"><span />{t('madeOpen')}</span><button className="icon-button" aria-label={t('translationSettings')} onClick={() => setPanel('settings')}><Settings2 size={18} /></button><span className="avatar" aria-label={t('localWorkspace')}>O</span></div>
        </header>

        <div className="workspace-content">
          <div className="page-heading">
            <div><div className="eyebrow"><span />{t('barrierFree')}</div><h1>{t('documentTranslation')}<span>.</span></h1><p>{t('documentSubtitle')}</p></div>
            {document && <button className="button secondary new-document" onClick={() => fileInput.current?.click()} disabled={!!busy}><Plus size={16} />{t('newDocument')}</button>}
          </div>

          {offline && <div className="message warning"><AlertCircle size={18} /><div><strong>{t('serverOfflineTitle')}</strong><span>{t('startApiFirst')} <code>npm run dev</code>{t('startApiLast')}</span></div><button className="text-button" onClick={() => void refreshHealth()}><RefreshCw size={14} />{t('reconnect')}</button></div>}
          {demo && <div className="message warning"><AlertCircle size={18} /><div><strong>{t('demoTitle')}</strong><span>{t('demoDescription')}</span></div><button className="text-button" onClick={() => setPanel('settings')}>{t('setupProvider')}</button></div>}
          {error && <div className="message error" role="alert"><AlertCircle size={18} /><div><strong>{t('actionFailed')}</strong><span>{showMessage(error, t)}</span></div><button className="icon-button" aria-label={t('dismissError')} onClick={() => setError('')}><X size={16} /></button></div>}
          {notice && <div className="message success" role="status"><CheckCircle2 size={18} /><div><span>{showMessage(notice, t)}</span></div><button className="icon-button" aria-label={t('dismissNotification')} onClick={() => setNotice('')}><X size={16} /></button></div>}

          {!document && !busy ? (
            <div className="welcome-layout">
              <section className="upload-card" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files[0]); }}>
                <div className="upload-card-top"><span className="section-number">{t('importSection')}</span><span className="private-label"><ShieldCheck size={14} />{t('yourFiles')}</span></div>
                <div className={`dropzone ${dragging ? 'dragging' : ''}`}>
                  <div className="upload-illustration" aria-hidden="true"><div className="sheet sheet-back" /><div className="sheet sheet-front"><span className="sheet-language">Aa <ArrowRight size={13} /> 文</span><i /><i /><i /><i /><span className="sheet-stamp"><Check size={14} /></span></div><span className="illustration-dot one" /><span className="illustration-dot two" /></div>
                  <h2>{dragging ? t('dropHere') : t('newPerspective')}</h2>
                  <p>{t('dropFirst')}<br className="desktop-break" /> {t('dropSecond')}</p>
                  <button className="button primary" onClick={() => fileInput.current?.click()}><Upload size={17} /> {t('chooseDocument')} <ArrowRight size={16} /></button>
                  <div className="file-formats"><span>PDF</span><span>DOCX</span><span>MARKDOWN</span><span>TXT</span><span>HTML</span></div>
                </div>
                <div className="upload-card-bottom"><span><span className="mini-dot" />{t('originalYours')}</span><span>{t('pdfSupport')}</span></div>
              </section>
              <section className="intro-notes">
                <span className="note-label">{t('betterReading')}</span><h2>{t('moreThanWords')}<br /><em>{t('wholePicture')}</em></h2><p>{t('readingDescription')}</p>
                <div className="feature-note"><span><Columns2 size={18} /></span><div><h3>{t('sideBySide')}</h3><p>{t('sideBySideDescription')}</p></div></div>
                <div className="feature-note"><span><Pencil size={18} /></span><div><h3>{t('readYourWay')}</h3><p>{t('editDescription')}</p></div></div>
                <div className="feature-note"><span><ShieldCheck size={18} /></span><div><h3>{t('providerChoice')}</h3><p>{t('providerChoiceDescription')}</p></div></div>
              </section>
            </div>
          ) : busy ? (
            <section className="loading-card" role="status"><LoaderCircle className="spin" size={32} /><h2>{busy === 'upload' ? t('preparingDocument') : t('openingDocument')}</h2><p>{busy === 'upload' ? t('extractingSource') : t('restoringDocument')}</p><span>{t('longerPdf')}</span></section>
          ) : document && (
            <section className="reader-card">
              <div className="document-toolbar"><div className="document-title"><span className="file-icon"><FileText size={22} /></span><div><h2 title={document.name}>{document.name}</h2><p>{document.format.toUpperCase()}{document.pageCount ? ` · ${t('pages', { count: document.pageCount })}` : ''} · {t('readingBlocks', { count: totalCount })}<span className="dot-separator">·</span><span>{t('translatedCount', { completed: translatedCount, total: totalCount })}</span></p></div></div><span className={`document-status ${translatedCount === totalCount && totalCount > 0 ? 'complete' : ''}`}>{running ? <><LoaderCircle size={12} className="spin" />{t('translating')}</> : translatedCount === totalCount && totalCount > 0 ? <><Check size={12} />{t('translated')}</> : <><span />{t('readyToRead')}</>}</span></div>
              <div className="translation-toolbar"><div className="language-group"><Languages size={17} /><span className="source-language">{t('autoDetect')}</span><ArrowRight size={14} /><label className="language-select"><span className="visually-hidden">{t('targetLanguage')}</span><select aria-label={t('targetLanguage')} value={target} disabled={!!busy || running} onChange={(event) => { const next = event.target.value; setTarget(next); setUnits({}); void selectDocument(document.id, next); }}>{LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label></div><div className="toolbar-actions">{document.format.toLowerCase() === 'pdf' && <button className={`button small subtle original-toggle ${original ? 'selected' : ''}`} onClick={() => setOriginal(!original)}><Columns2 size={15} />{t('originalPdf')}</button>}{running ? <button className="button small secondary" onClick={() => void stop()}><Pause size={15} />{t('stop')}</button> : <button className="button small primary" onClick={() => void translate()} disabled={offline || !health?.provider.configured || totalCount === 0}><Languages size={15} />{translatedCount > 0 ? t('translateAgain') : t('translateDocument')}</button>}</div></div>
              {running && <div className="translation-progress" role="status"><div><span><LoaderCircle className="spin" size={14} /> {t('translatingTo', { language: languageName(target) })}</span><strong>{job?.completed ?? 0} / {job?.total ?? totalCount}<span>{progress}%</span></strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div></div>}
              {document.warnings.length > 0 && <details className="document-warnings"><summary><AlertCircle size={14} /> {t('documentNotes', { count: document.warnings.length })}</summary><ul>{document.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
              <div className="view-toolbar"><div className="segmented-control" aria-label={t('readingMode')}>{([['bilingual', 'bilingual'], ['translated', 'translation'], ['source', 'source']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'selected' : ''} onClick={() => setMode(value)}>{t(label)}</button>)}</div><div className="export-actions"><button className="text-button" disabled={exporting || running || translatedCount === 0} onClick={() => void download('md')}><ArrowDownToLine size={14} /> Markdown</button><button className="text-button" disabled={exporting || running || translatedCount === 0} onClick={() => void download('html')}><ArrowDownToLine size={14} /> HTML</button><button className="text-button" disabled={running} onClick={() => window.print()}><Printer size={14} />{t('pdfPrint')}</button></div></div>
              <div className={`reading-layout ${original ? 'with-original' : ''}`}>
                {original && <div className="original-preview"><iframe title={t('originalTitle', { name: document.name })} src={`/api/documents/${encodeURIComponent(document.id)}/source`} /><p>{t('originalPreviewNote')}</p></div>}
                <article className={`paper mode-${mode}`} lang={mode === 'translated' ? target : 'und'}>
                  <div className="print-title"><h1>{document.name}</h1><p>{t('appName')} · {languageName(target)}</p></div>
                  {document.blocks.length === 0 ? <div className="no-text"><AlertCircle size={28} /><h3>{t('noReadableText')}</h3><p>{t('needsOcr')}</p></div> : document.blocks.map((block, index) => <ReadingBlock key={block.id} block={block} translation={units[block.id]} mode={mode} language={target} index={index} editable={!running} onSave={(text) => saveUnit(block.id, text)} />)}
                  <footer className="paper-footer"><span>{t('endDocument')}</span><span>{t('blocks', { count: document.blocks.length })} · {document.pageCount ? t('sourcePages', { count: document.pageCount }) : document.format.toUpperCase()}</span></footer>
                </article>
              </div>
              <div className="reader-bottom"><span><ShieldCheck size={13} />{t('savedSeparately')}</span><span>{t('reflowView')} <span className="dot-separator">·</span>{t('printDifferent')}</span></div>
            </section>
          )}

          <footer className="workspace-footer"><span>{t('readFreely')}</span><span>{t('builtOpen')} <span>↗</span></span></footer>
        </div>
      </main>

      {panel && <div className="modal-backdrop" onClick={() => setPanel(null)}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><span className="modal-symbol">{panel === 'settings' ? <Settings2 size={23} /> : <Globe2 size={23} />}</span><button className="icon-button" aria-label={t('closeDialog')} onClick={() => setPanel(null)}><X size={19} /></button></div>{panel === 'settings' ? <><span className="eyebrow">{t('yourEngine')}</span><h2 id="settings-heading">{t('ownProvider')}</h2><p>{t('providerServerNote')}</p><div className="settings-status"><span className={`status-dot ${offline ? 'offline' : ''}`} /><div><strong>{health ? `${health.provider.kind} / ${health.provider.model}` : t('apiNotConnected')}</strong><small>{health ? health.provider.configured ? t('providerConfigured') : t('providerIncomplete') : t('expectedServer')}</small></div><button className="icon-button" aria-label={t('refreshServer')} onClick={() => void refreshHealth()}><RefreshCw size={16} className={healthLoading ? 'spin' : ''} /></button></div><h3>{t('startLocal')}</h3><p className="small-copy">{t('startLocalDescription')}</p><pre className="setup-code">{'ollama pull qwen2.5:7b\nnpm install\nnpm run dev'}</pre><h3>{t('compatibleApi')}</h3><p className="small-copy">{t('compatibleFirst')} <code>.env</code>{t('compatibleSecond')} <code>.env.example</code> {t('compatibleLast')}</p><p className="settings-footnote">{t('parserNote')}</p></> : <><span className="eyebrow">{t('furtherReading')}</span><h2 id="settings-heading">{t('translateWeb')}</h2><p>{t('extensionDescription')}</p><ol className="setup-steps"><li><span>1</span><div><strong>{t('buildExtension')}</strong><code>npm run build --workspace @oit/extension</code></div></li><li><span>2</span><div><strong>{t('loadChrome')}</strong><p>{t('loadChromeFirst')} <code>chrome://extensions</code>{t('loadChromeSecond')} <code>apps/extension/dist</code>{t('loadChromeLast')}</p></div></li><li><span>3</span><div><strong>{t('chooseAndTranslate')}</strong><p>{t('extensionUse')}</p></div></li></ol><div className="settings-footnote"><ShieldCheck size={15} /><span>{t('extensionPrivacy')}</span></div></>}<button className="button primary modal-done" onClick={() => setPanel(null)}>{t('gotIt')} <Check size={16} /></button></section></div>}
    </div>
  );
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
    <span className="block-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
    {showSource && <div className={`source-content ${mode === 'bilingual' && translated ? 'muted-source' : ''}`}><BlockContent block={block} text={block.text} />{mode === 'translated' && !translated && !isProtected && <span className="untranslated-note">{t('sourceUntranslated')}</span>}</div>}
    {isProtected ? <span className="protected-note">{t('codePreserved')}</span> : mode !== 'source' && translated ? <div className="translated-content" lang={language} dir={['ar', 'he', 'fa', 'ur'].includes(language) ? 'rtl' : 'auto'}>
      {editing ? <><div className="edit-area"><textarea aria-label={t('editBlock', { number: index + 1 })} value={draft} onChange={(event) => setDraft(event.target.value)} rows={Math.min(14, Math.max(3, Math.ceil(draft.length / 75)))} autoFocus /><div className="edit-actions"><button className="button small subtle" onClick={() => { setEditing(false); setDraft(translation); setError(''); }} disabled={saving}>{t('cancel')}</button><button className="button small primary" onClick={() => void save()} disabled={saving || !draft.trim()}>{saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} {t('saveEdit')}</button></div>{error && <p className="edit-error" role="alert">{showMessage(error, t)}</p>}</div><div className="saved-print"><BlockContent block={block} text={translation} /></div></> : <><BlockContent block={block} text={translation} />{canEdit && <button className="edit-block-button" aria-label={t('editBlock', { number: index + 1 })} onClick={() => { setDraft(translation); setEditing(true); }}><Pencil size={13} /></button>}</>}
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
