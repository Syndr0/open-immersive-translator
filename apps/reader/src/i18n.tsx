import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type InterfaceLanguage = 'en' | 'zh';
type Parameters = Record<string, string | number>;
type Phrase = string | { one: string; other: string };

const en = {
  appName: 'Open Immersive Translator',
  home: 'Open Immersive Translator home',
  interfaceLanguage: 'Interface language',
  importDocument: 'Import document',
  closeLibrary: 'Close library',
  openLibrary: 'Open library',
  websiteTranslation: 'Website translation',
  library: 'Library',
  pages: { one: '{count} page', other: '{count} pages' },
  connecting: 'Connecting…',
  serverOffline: 'Server offline',
  demoProvider: 'Demo provider',
  localTranslation: 'Local translation',
  googleTranslation: 'Google Cloud Translation',
  googleFreeTranslation: 'Google Translate · free web',
  googleFreeSetup: 'Use Google Translate without a key',
  googleFreeDescription: 'No account, API key, local model or billing setup. Text is sent to Google through an unofficial web endpoint, which can throttle requests or become unavailable. No automatic switch to a paid provider.',
  codexTranslation: 'Codex translation',
  documents: 'Documents',
  translationSettings: 'Translation settings',
  newDocument: 'New document',
  serverOfflineTitle: 'The translation server is offline.',
  reconnect: 'Reconnect',
  demoTitle: 'Demo mode is active. Output is not a real translation.',
  setupProvider: 'Set up provider',
  dismissError: 'Dismiss error',
  dismissNotification: 'Dismiss notification',
  dropHere: 'Release to import',
  chooseDocument: 'Choose a document',
  preparingDocument: 'Preparing your document',
  openingDocument: 'Opening your document',
  translatedCount: '{completed}/{total} translated',
  targetLanguage: 'Target language',
  originalPdf: 'Original PDF',
  stop: 'Stop',
  translateAgain: 'Translate again',
  translateDocument: 'Translate document',
  translatingTo: 'Translating to {language}',
  documentNotes: { one: 'Document note', other: '{count} document notes' },
  readingMode: 'Reading mode',
  bilingual: 'Bilingual',
  translation: 'Translation',
  source: 'Source',
  pdfPrint: 'PDF / Print',
  originalTitle: 'Original: {name}',
  noReadableText: 'No readable text was found.',
  needsOcr: 'This document may need OCR. Enable the optional Docling parser on your server, then import it again.',
  closeDialog: 'Close dialog',
  ownProvider: 'Translation provider',
  apiNotConnected: 'API not connected',
  providerConfigured: 'Provider configuration available',
  providerIncomplete: 'Provider configuration incomplete',
  expectedServer: 'Expected at 127.0.0.1:8787',
  refreshServer: 'Refresh server status',
  startLocal: 'Start with local translation',
  codexSetup: 'Use your existing Codex connection',
  codexSetupDescription: 'Reuse the Codex CLI already signed in on this computer. With ChatGPT sign-in, translations use your existing Codex allowance; model access and usage limits still apply. No separate API key or local model download is needed for this sign-in method.',
  codexEnvNote: 'Add these backend settings and restart the API. Set CODEX_CLI_PATH to the installed CLI’s absolute path. Reuse the existing sign-in; do not copy authentication tokens into .env or the browser. Ask your agent to verify a real translation after setup.',
  codexSetupDocs: 'Codex sign-in guide',
  startLocalDescription: 'Install Ollama, pull a model, then start the application from the repository root:',
  localModelNote: 'The smaller local default is qwen3.5:2b. For lower memory use, qwen3.5:0.8b is another option; set OLLAMA_MODEL to the model you have pulled. Translation quality depends on the model.',
  googleSetup: 'Or use Google Cloud Translation',
  googleSetupDescription: 'Enable the Cloud Translation API (Basic v2) and billing in a Google Cloud project, then create an API key.',
  googleEnvNote: 'Add these settings to the backend’s .env and restart the API. Google Cloud usage may incur charges. The key stays on the backend; do not enter it in the browser or save it in browser storage.',
  googleSetupDocs: 'Google Cloud setup guide',
  compatibleApi: 'Or connect a compatible API',
  compatibleFirst: 'Set the provider, base URL, model and API key in the server’s',
  compatibleSecond: '. See the repository’s',
  compatibleLast: 'for the exact settings. Restart the API after changing them.',
  parserNote: 'Digital PDF extraction works by default. The optional Docling parser adds recognition for scans and complex layouts. Provider quality and recognition depend on the configured models.',
  translateWeb: 'Translate websites',
  buildExtension: 'Build the extension',
  loadChrome: 'Load it in Chrome',
  loadChromeFirst: 'Open',
  loadChromeSecond: ', enable Developer mode, choose “Load unpacked”, and select',
  loadChromeLast: '.',
  chooseAndTranslate: 'Choose a language and translate',
  extensionUse: 'Keep this server running, open a website, then click Translate on its right edge. Restore removes the added translation. Use the extension popup to choose a language.',
  extensionPrivacy: 'The extension reads page text when you activate it. Your chosen translation provider processes the submitted text.',
  sourceUntranslated: 'Source · not yet translated',
  editBlock: 'Edit translation for block {number}',
  cancel: 'Cancel',
  saveEdit: 'Save edit',
  invalidDocument: 'Choose a PDF, TXT, Markdown, HTML or DOCX document.',
  completedNotice: 'Translation complete. You can edit any translated paragraph before exporting.',
  stoppedNotice: 'Translation stopped. Completed paragraphs are kept.',
  partialTranslationError: 'Some paragraphs could not be translated. Successful results are kept; retry to continue.',
  exportError: 'Could not export this document.',
  unexpectedError: 'Something went wrong. Please try again.',
  useYourAgent: 'Use your AI agent',
  letAgentSetup: 'Let your AI agent set this up',
  copyForAgent: 'Copy for your agent',
  previewAgentRequest: 'Preview the request',
  agentRequestLabel: 'Request to paste into your AI agent',
  promptCopied: 'Copied. Paste this into your AI agent to continue.',
  promptCopyFallback: 'Clipboard access is unavailable. The request is selected below; copy it manually and paste it into your agent.',
  manualSetup: 'Manual setup',
  agentDocumentTitle: 'Translate with your AI agent',
  agentExistingDocument: 'The request already includes “{name}” and target language {language}. Your agent can reuse this imported document.',
  agentDocumentStep1: 'Attach your file in the agent’s chat',
  agentDocumentStep1Existing: 'Keep this document, or attach another file',
  agentDocumentStep2: 'Paste the copied request',
  agentDocumentStep3: 'Open the bilingual HTML or Markdown it returns',
  invalidDocumentLink: 'This document link contains an invalid document ID or target language. Check the link, or choose a document from your library.',
  documentLinkUnavailable: 'The document from this link could not be opened. Check that the agent and this reader use the same local service, or choose a document from your library.',
  deleteDocument: 'Delete {name}',
  confirmDelete: 'Delete “{name}” and all of its translations?',
  fileTooLarge: 'Choose a file of 25 MB or less.',
  dropDocument: 'Drop a document here',
  supportedFormats: 'PDF, DOCX, Markdown, TXT or HTML · up to 25 MB',
} satisfies Record<string, Phrase>;

export type TranslationKey = keyof typeof en;
const zh: Record<TranslationKey, Phrase> = {
  appName: '开源沉浸式翻译',
  home: '开源沉浸式翻译首页',
  interfaceLanguage: '界面语言',
  importDocument: '导入文档',
  closeLibrary: '关闭文档库',
  openLibrary: '打开文档库',
  websiteTranslation: '网页翻译',
  library: '文档库',
  pages: '{count} 页',
  connecting: '正在连接…',
  serverOffline: '服务未连接',
  demoProvider: '演示翻译服务',
  localTranslation: '本地翻译',
  googleTranslation: 'Google 云翻译',
  googleFreeTranslation: 'Google 翻译 · 免费网页接口',
  googleFreeSetup: '使用无需密钥的 Google 翻译',
  googleFreeDescription: '无需账号、接口密钥、本地模型或开通结算。原文通过非官方网页接口发送给 Google，该接口可能限流或不可用。不会自动切换至付费服务。',
  codexTranslation: 'Codex 翻译',
  documents: '文档',
  translationSettings: '翻译设置',
  newDocument: '新建文档',
  serverOfflineTitle: '翻译服务尚未连接。',
  reconnect: '重新连接',
  demoTitle: '当前为演示模式，输出并非真实译文。',
  setupProvider: '配置翻译服务',
  dismissError: '关闭错误提示',
  dismissNotification: '关闭通知',
  dropHere: '松开即可导入',
  chooseDocument: '选择文档',
  preparingDocument: '正在准备文档',
  openingDocument: '正在打开文档',
  translatedCount: '已翻译 {completed}/{total}',
  targetLanguage: '目标语言',
  originalPdf: '原始 PDF',
  stop: '停止',
  translateAgain: '重新翻译',
  translateDocument: '翻译文档',
  translatingTo: '正在翻译为{language}',
  documentNotes: '{count} 条文档说明',
  readingMode: '阅读模式',
  bilingual: '双语对照',
  translation: '译文',
  source: '原文',
  pdfPrint: 'PDF / 打印',
  originalTitle: '原文：{name}',
  noReadableText: '未找到可读取的文本。',
  needsOcr: '此文档可能需要文字识别。请在服务端启用可选的 Docling 解析器，然后重新导入。',
  closeDialog: '关闭对话框',
  ownProvider: '翻译服务',
  apiNotConnected: '接口未连接',
  providerConfigured: '翻译服务已配置',
  providerIncomplete: '翻译服务配置不完整',
  expectedServer: '默认服务地址：127.0.0.1:8787',
  refreshServer: '刷新服务状态',
  startLocal: '开始使用本地翻译',
  codexSetup: '使用现有 Codex 连接',
  codexSetupDescription: '复用这台电脑上已登录的 Codex CLI。使用 ChatGPT 登录时，翻译会使用现有 Codex 额度，仍受模型访问权限和用量限制约束。这种登录方式无需额外的 API 密钥或本地模型下载。',
  codexEnvNote: '将这些配置写入后端并重启接口服务。把 CODEX_CLI_PATH 设为已安装 CLI 的绝对路径。请复用现有登录，不要将登录令牌复制到 .env 或浏览器。设置完成后，让代理验证一次真实翻译。',
  codexSetupDocs: 'Codex 登录指南',
  startLocalDescription: '安装 Ollama 并下载模型，然后在项目根目录启动应用：',
  localModelNote: '较小的本地默认模型为 qwen3.5:2b。内存较少时也可选择 qwen3.5:0.8b，并将 OLLAMA_MODEL 设为已下载的模型。翻译质量取决于所选模型。',
  googleSetup: '也可以使用 Google 云翻译',
  googleSetupDescription: '在 Google Cloud 项目中启用 Cloud Translation API（Basic v2）和结算，然后创建 API 密钥。',
  googleEnvNote: '将这些配置写入后端的 .env 文件，然后重启接口服务。Google Cloud 使用量可能产生费用。密钥只保留在后端，请勿在浏览器中输入或保存密钥。',
  googleSetupDocs: 'Google Cloud 配置指南',
  compatibleApi: '也可以连接兼容接口',
  compatibleFirst: '在服务端的',
  compatibleSecond: '中设置翻译服务、基础地址、模型和接口密钥。具体配置请参阅项目中的',
  compatibleLast: '。修改后请重新启动接口服务。',
  parserNote: '默认支持文本型 PDF 提取。可选的 Docling 解析器可识别扫描件和复杂版面。翻译与识别质量取决于所配置的模型。',
  translateWeb: '翻译网页',
  buildExtension: '构建浏览器扩展',
  loadChrome: '在 Chrome 中加载',
  loadChromeFirst: '打开',
  loadChromeSecond: '，启用“开发者模式”，点击“加载已解压的扩展程序”，然后选择',
  loadChromeLast: '。',
  chooseAndTranslate: '选择语言，开始翻译',
  extensionUse: '保持服务运行，打开网页，然后点击页面右侧的“翻译”按钮。“恢复”可移除添加的译文。目标语言可在扩展弹窗中选择。',
  extensionPrivacy: '扩展仅在你启用翻译时读取网页文本。提交的文本由你选择的翻译服务处理。',
  sourceUntranslated: '原文 · 尚未翻译',
  editBlock: '编辑第 {number} 段译文',
  cancel: '取消',
  saveEdit: '保存修改',
  invalidDocument: '请选择 PDF、TXT、Markdown、HTML 或 DOCX 文档。',
  completedNotice: '翻译完成。导出前可编辑任意译文段落。',
  stoppedNotice: '翻译已停止。已完成的段落会保留。',
  partialTranslationError: '部分段落未能完成翻译。成功的结果已保留，可重试以继续。',
  exportError: '无法导出此文档。',
  unexpectedError: '发生错误，请重试。',
  useYourAgent: '交给 AI 代理',
  letAgentSetup: '让 AI 代理帮你完成设置',
  copyForAgent: '复制给你的代理',
  previewAgentRequest: '预览请求内容',
  agentRequestLabel: '粘贴到 AI 代理中的请求',
  promptCopied: '已复制。粘贴到 AI 代理中即可继续。',
  promptCopyFallback: '无法访问剪贴板。下方请求已选中，请手动复制并粘贴到代理中。',
  manualSetup: '手动设置',
  agentDocumentTitle: '让 AI 代理翻译文档',
  agentExistingDocument: '请求已包含“{name}”和目标语言{language}。代理可以直接复用这个已导入的文档。',
  agentDocumentStep1: '在代理聊天中附上文件',
  agentDocumentStep1Existing: '继续使用此文档，或附上其他文件',
  agentDocumentStep2: '粘贴已复制的请求',
  agentDocumentStep3: '打开代理返回的双语 HTML 或 Markdown',
  invalidDocumentLink: '此文档链接中的文档标识或目标语言无效。请检查链接，或从文档库选择文档。',
  documentLinkUnavailable: '无法打开链接中的文档。请确认代理和阅读器使用同一个本地服务，或从文档库选择文档。',
  deleteDocument: '删除 {name}',
  confirmDelete: '删除“{name}”及其全部译文？',
  fileTooLarge: '请选择不超过 25 MB 的文件。',
  dropDocument: '将文档拖放到这里',
  supportedFormats: 'PDF、DOCX、Markdown、TXT 或 HTML · 最大 25 MB',
};

export type Translate = (key: TranslationKey, parameters?: Parameters) => string;
export type UiMessage = '' | { key: TranslationKey; parameters?: Parameters } | { raw: string };
const dictionaries: Record<InterfaceLanguage, Record<TranslationKey, Phrase>> = { en, zh };
const STORAGE_KEY = 'oit.interface-language.v1';

function readLanguage(): InterfaceLanguage {
  try { return localStorage.getItem(STORAGE_KEY) === 'zh' ? 'zh' : 'en'; }
  catch { return 'en'; }
}

/** Source text and translation language are independent of this UI preference. */
export function translatePhrase(locale: InterfaceLanguage, key: TranslationKey, parameters: Parameters = {}): string {
  const entry = dictionaries[locale][key];
  const phrase = typeof entry === 'string' ? entry : entry[new Intl.PluralRules(locale).select(Number(parameters.count ?? 0)) === 'one' ? 'one' : 'other'];
  return phrase.replace(/\{(\w+)\}/g, (token, name: string) => String(parameters[name] ?? token));
}

const I18nContext = createContext<{ locale: InterfaceLanguage; setLocale: (locale: InterfaceLanguage) => void; t: Translate } | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<InterfaceLanguage>(readLanguage);
  const setLocale = useCallback((next: InterfaceLanguage) => {
    updateLocale(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Switching still works if storage is blocked. */ }
  }, []);
  const t = useCallback<Translate>((key, parameters) => translatePhrase(locale, key, parameters), [locale]);
  useEffect(() => { document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'; }, [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n requires I18nProvider');
  return value;
}

export function showMessage(message: UiMessage, t: Translate): string {
  return !message ? '' : 'key' in message ? t(message.key, message.parameters) : message.raw;
}

/** Technical server errors stay intact; application fallbacks remain localizable. */
export function uiError(error: unknown): UiMessage {
  if (error instanceof LocalizedError) return { key: error.translationKey };
  if (!(error instanceof Error) || error.message === en.unexpectedError) return { key: 'unexpectedError' };
  return { raw: error.message };
}

export class LocalizedError extends Error {
  constructor(public readonly translationKey: TranslationKey) { super(translationKey); }
}
