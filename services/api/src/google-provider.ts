import { decodeHTMLStrict } from 'entities';
import type { Provider, Segment } from '@oit/core';

const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const MARKER = /⟪OIT_\d+⟫/g;

class GoogleProviderError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

function languageCode(value: string): string {
  const code = value.trim();
  if (/^zh-Hans$/i.test(code)) return 'zh-CN';
  if (/^zh-Hant$/i.test(code)) return 'zh-TW';
  return code;
}

function preserveMarkers(source: string, translated: string): void {
  const original = (source.match(MARKER) ?? []).sort();
  const returned = (translated.match(MARKER) ?? []).sort();
  if (JSON.stringify(original) !== JSON.stringify(returned)) {
    throw new GoogleProviderError('Google Cloud Translation changed or omitted a protected math/code/link token');
  }
}

function retryDelay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Official Cloud Translation Basic v2, not an unofficial browser translation endpoint. */
export function googleProvider(rawKey: string | undefined): Provider {
  const apiKey = rawKey?.trim() ?? '';
  return {
    kind: 'google', model: 'nmt', configured: Boolean(apiKey),
    cacheNamespace: 'google:cloud-basic-v2:nmt:text:html-entities-once:v1',
    async translate(segments: Segment[], source: string, target: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!apiKey) throw new Error('Google Cloud Translation is not configured. Set GOOGLE_TRANSLATE_API_KEY on the server and restart the API.');
      if (!segments.length) return [];
      if (segments.length > 128) throw new Error('Google Cloud Translation accepts at most 128 strings per request.');
      const targetCode = languageCode(target);
      if (!targetCode) throw new Error('Choose a target language for Google Cloud Translation.');
      const sourceCode = languageCode(source);
      const body = JSON.stringify({
        q: segments.map(segment => segment.text), target: targetCode, format: 'text', model: 'nmt',
        ...(sourceCode && sourceCode.toLowerCase() !== 'auto' ? { source: sourceCode } : {}),
      });
      let last = new GoogleProviderError('Google Cloud Translation failed.');
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-goog-api-key': apiKey },
            body,
            signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          });
          if (!response.ok) {
            const hint = response.status === 400 || response.status === 401 || response.status === 403
              ? ' Check the API key, language codes, Cloud Translation API enablement and billing.' : '';
            // Never expose the response body: it can contain provider diagnostics or credentials.
            throw new GoogleProviderError(`Google Cloud Translation returned HTTP ${response.status}.${hint}`, response.status >= 500 || response.status === 429);
          }
          let envelope: unknown;
          try { envelope = await response.json(); }
          catch { throw new GoogleProviderError('Google Cloud Translation returned invalid JSON.'); }
          const translations = (envelope as { data?: { translations?: unknown } } | null)?.data?.translations;
          if (!Array.isArray(translations) || translations.length !== segments.length) {
            throw new GoogleProviderError('Google Cloud Translation returned a mismatched translation count.');
          }
          const outputs = translations.map((value: unknown, index: number) => {
            if (!value || typeof value !== 'object' || typeof (value as { translatedText?: unknown }).translatedText !== 'string') {
              throw new GoogleProviderError('Google Cloud Translation returned an invalid translation.');
            }
            // Decode once into plain text. Renderers escape text; this is never parsed as HTML.
            const text = decodeHTMLStrict((value as { translatedText: string }).translatedText);
            if (segments[index]!.text.trim() && !text.trim()) throw new GoogleProviderError('Google Cloud Translation returned an empty translation.');
            preserveMarkers(segments[index]!.text, text);
            return { id: segments[index]!.id, text };
          });
          signal.throwIfAborted();
          return outputs;
        } catch (error) {
          signal.throwIfAborted();
          // Fetch/JSON errors may include request diagnostics. Only our own safe messages escape.
          last = error instanceof GoogleProviderError ? error : new GoogleProviderError('Cannot reach Google Cloud Translation. Check server connectivity and API configuration.');
          if (!last.retryable || attempt === 1) break;
          await retryDelay(signal);
        }
      }
      throw last;
    },
  };
}
