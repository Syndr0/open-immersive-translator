import type { TranslationReply } from './engine';
import type { TranslationInput } from './transport';

export interface Detection { isReliable: boolean; languages: Array<{ language: string; percentage: number }> }
export type Detect = (text: string) => Promise<Detection | undefined>;
type Translate = (input: TranslationInput, signal: AbortSignal, onProgress?: (reply: TranslationReply) => void) => Promise<TranslationReply>;

export function sameLanguage(source: string, target: string): boolean {
  if ([source, target].some(value => /^(auto|und)$/i.test(value))) return false;
  try {
    const from = new Intl.Locale(source.replace(/_/g, '-')), to = new Intl.Locale(target.replace(/_/g, '-'));
    if (from.language !== to.language) return false;
    if (from.language !== 'zh') return true;
    const script = (locale: Intl.Locale) => locale.script || (['CN', 'SG'].includes(locale.region || '') ? 'Hans' : ['TW', 'HK', 'MO'].includes(locale.region || '') ? 'Hant' : undefined);
    // An unspecified Chinese script must not suppress requested script conversion.
    return script(from) === script(to);
  } catch { return false; }
}

const chromeDetect: Detect = text => typeof chrome !== 'undefined' && chrome.i18n?.detectLanguage
  ? chrome.i18n.detectLanguage(text) : Promise.resolve(undefined);

/** Detection is bounded, conservative and performed only after Translate. */
async function skippedInputs(input: TranslationInput, signal: AbortSignal, detect: Detect): Promise<boolean[]> {
  signal.throwIfAborted();
  if (sameLanguage(input.sourceLanguage, input.targetLanguage)) return input.segments.map(() => true);
  const skipped = input.segments.map(() => false);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (aborted = false) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (aborted) reject(signal.reason); else resolve();
    };
    const abort = () => finish(true);
    const timer = setTimeout(() => finish(), 350);
    signal.addEventListener('abort', abort, { once: true });
    void Promise.all(input.segments.map(async (segment, index) => {
      const text = segment.text.replace(/\[\[OIT_(?:OPEN|CLOSE|KEEP)_\d+\]\]/g, '').trim();
      if (!/\p{L}/u.test(text)) { if (!done) skipped[index] = true; return; }
      // Inspect the whole paragraph rather than truncating away another language.
      if (text.length > 16_384) return;
      try {
        const result = await detect(text);
        const languages = result?.languages.filter(value => value.percentage > 0) || [];
        if (!done && result?.isReliable && languages.length === 1 && languages[0]!.percentage >= 95
          && sameLanguage(languages[0]!.language, input.targetLanguage)) skipped[index] = true;
      } catch { /* Unknown/unavailable detection leaves translation enabled. */ }
    })).then(() => finish());
  });
  signal.throwIfAborted();
  return skipped;
}

export async function translateNeeded(input: TranslationInput, signal: AbortSignal, translate: Translate, onProgress?: (reply: TranslationReply) => void, detect: Detect = chromeDetect): Promise<TranslationReply> {
  const skipped = await skippedInputs(input, signal, detect);
  signal.throwIfAborted();
  const local = input.segments.filter((_segment, index) => skipped[index]).map(segment => ({ ...segment }));
  const remaining = input.segments.filter((_segment, index) => !skipped[index]);
  const merge = (reply: TranslationReply): TranslationReply => ({ results: [...local.map(segment => ({ ...segment })), ...reply.results], errors: reply.errors });
  if (local.length) onProgress?.({ results: local.map(segment => ({ ...segment })), errors: [] });
  signal.throwIfAborted();
  if (!remaining.length) return { results: local, errors: [] };
  const reply = await translate({ ...input, segments: remaining }, signal, progress => { if (!signal.aborted) onProgress?.(merge(progress)); });
  signal.throwIfAborted();
  return merge(reply);
}
