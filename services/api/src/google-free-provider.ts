import type { Provider, Segment } from '@oit/core';

// This is an undocumented public web endpoint, not Google Cloud Translation.
// Its availability and quotas are not guaranteed. No keys, cookies or tokens are used.
const ENDPOINT = 'https://clients5.google.com/translate_a/t';
const MAX_SEGMENTS = 32;
const MAX_CHARACTERS = 12_000;
const MARKER = /⟪OIT_\d+⟫/g;

class FreeEndpointError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

function languageCode(value: string): string {
  const code = value.trim();
  if (/^zh-Hans$/i.test(code)) return 'zh-CN';
  if (/^zh-Hant$/i.test(code)) return 'zh-TW';
  if (/^auto$/i.test(code)) return 'auto';
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(code)) throw new FreeEndpointError('Choose a valid source and target language for the unofficial Google free endpoint.');
  return code;
}

function validateMarkers(source: string, translated: string): void {
  const tokens = (text: string) => JSON.stringify((text.match(MARKER) ?? []).sort());
  if (tokens(source) !== tokens(translated) || /⟪OIT_/.test(translated.replace(MARKER, ''))) {
    throw new FreeEndpointError('The unofficial Google free endpoint changed a protected math/code/link token.');
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

/** Explicit opt-in no-key provider. Our conservative budgets are not service quotas. */
export function googleFreeProvider(): Provider {
  return {
    kind: 'google-free', model: 'web-unofficial', configured: true,
    cacheNamespace: 'google-free:clients5:dict-chrome-ex:plain:v1',
    batch: { maxSegments: MAX_SEGMENTS, maxCharacters: MAX_CHARACTERS },
    async translate(segments: Segment[], source: string, target: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (!segments.length) return [];
      if (segments.length > MAX_SEGMENTS || segments.reduce((sum, segment) => sum + segment.text.length, 0) > MAX_CHARACTERS) throw new FreeEndpointError('The unofficial Google free endpoint is limited to 32 segments and 12000 characters per application batch.');
      if (new Set(segments.map(segment => segment.id)).size !== segments.length || segments.some(segment => !segment.id || typeof segment.text !== 'string' || !segment.text.trim())) throw new FreeEndpointError('Use unique IDs and nonempty text for each free translation segment.');
      const sourceCode = languageCode(source || 'auto'), targetCode = languageCode(target);
      if (targetCode === 'auto') throw new FreeEndpointError('Choose an explicit target language for the unofficial Google free endpoint.');
      if (sourceCode.toLowerCase() === targetCode.toLowerCase()) return segments.map(segment => ({ ...segment }));
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({ client: 'dict-chrome-ex', sl: sourceCode, tl: targetCode }).toString();
      const body = new URLSearchParams();
      for (const segment of segments) body.append('q', segment.text);
      let last = new FreeEndpointError('The unofficial Google free endpoint is unavailable. Try again later.');
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted();
        try {
          const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: body.toString(), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          });
          if (!response.ok) {
            if (response.status === 429) throw new FreeEndpointError('The unofficial Google free endpoint is rate limited (HTTP 429). Wait before retrying.');
            throw new FreeEndpointError(`The unofficial Google free endpoint is unavailable (HTTP ${response.status}). It has no guaranteed availability; try later or choose another provider.`, response.status >= 500);
          }
          let envelope: unknown;
          try { envelope = await response.json(); }
          catch { throw new FreeEndpointError('The unofficial Google free endpoint returned invalid JSON.'); }
          if (!Array.isArray(envelope) || envelope.length !== segments.length) throw new FreeEndpointError('The unofficial Google free endpoint returned a mismatched segment count.');
          const translated = envelope.map((item: unknown, index: number) => {
            let text: unknown = item;
            if (sourceCode === 'auto') {
              if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(item[1])) throw new FreeEndpointError('The unofficial Google free endpoint returned an invalid detected-language result.');
              text = item[0];
            }
            if (typeof text !== 'string' || !text.trim()) throw new FreeEndpointError('The unofficial Google free endpoint returned an invalid translation.');
            validateMarkers(segments[index]!.text, text);
            // The observed endpoint returns plain strings: do not HTML-decode them.
            return { id: segments[index]!.id, text };
          });
          signal.throwIfAborted();
          return translated;
        } catch (error) {
          signal.throwIfAborted();
          last = error instanceof FreeEndpointError ? error : new FreeEndpointError('Cannot reach the unofficial Google free endpoint. Check connectivity or try another provider.', true);
          if (!last.retryable || attempt === 1) break;
          await retryDelay(signal);
        }
      }
      throw last;
    },
  };
}
