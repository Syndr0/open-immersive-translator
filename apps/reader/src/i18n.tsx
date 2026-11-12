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
  localTranslation: 'Ollama · local model',
  googleTranslation: 'Google Cloud Translation',
  googleFreeTranslation: 'Google Translate · free web',
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
  ownProvider: 'Translation service',
  apiNotConnected: 'API not connected',
  providerIncomplete: 'This service is not fully set up yet.',
  googleSetupDocs: 'Google Cloud setup guide',
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
  compatibleTranslation: 'OpenAI-compatible API',
  hintGoogleFree: 'No key needed. Text goes to an unofficial Google endpoint that may be throttled.',
  hintGoogle: 'Needs a Google Cloud API key with Cloud Translation and billing enabled.',
  hintOllama: 'Runs on this computer. Install Ollama and pull a model first.',
  hintCompatible: 'Any OpenAI-compatible chat API, local or hosted.',
  hintCodex: 'Uses the Codex CLI already signed in on this computer.',
  fieldServer: 'Server URL',
  fieldModel: 'Model',
  fieldApiKey: 'API key',
  keySaved: 'Saved. Leave blank to keep it.',
  removeKey: 'Remove key',
  testService: 'Test',
  saveService: 'Save',
  serviceInUse: 'In use',
  testPassed: 'Works: {text}',
  serviceSaved: 'Saved. New translations use this service.',
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
  localTranslation: 'Ollama · 本地模型',
  googleTranslation: 'Google 云翻译',
  googleFreeTranslation: 'Google 翻译 · 免费网页接口',
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
  providerIncomplete: '该服务尚未完成设置。',
  googleSetupDocs: 'Google Cloud 配置指南',
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
  compatibleTranslation: 'OpenAI 兼容接口',
  hintGoogleFree: '无需密钥。文本会发送到 Google 的非官方接口，可能被限流。',
  hintGoogle: '需要已启用 Cloud Translation 和结算的 Google Cloud API 密钥。',
  hintOllama: '在本机运行。请先安装 Ollama 并拉取模型。',
  hintCompatible: '任何兼容 OpenAI 的对话接口，本地或云端均可。',
  hintCodex: '使用本机已登录的 Codex CLI。',
  fieldServer: '服务地址',
  fieldModel: '模型',
  fieldApiKey: 'API 密钥',
  keySaved: '已保存，留空则保持不变。',
  removeKey: '移除密钥',
  testService: '测试',
  saveService: '保存',
  serviceInUse: '使用中',
  testPassed: '可用：{text}',
  serviceSaved: '已保存，新的翻译将使用此服务。',
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
