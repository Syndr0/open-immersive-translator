import type { Provider, ProviderResult, Segment } from '@oit/core';
import { decodeHTMLStrict } from 'entities';

// This is an undocumented public web endpoint, not Google Cloud Translation.
// Its availability and quotas are not guaranteed. No keys, cookies or tokens are used.
const ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const MAX_SEGMENTS = 32;
const MAX_CHARACTERS = 12_000;
const MARKER = /⟪OIT_\d+⟫/g;

function toTranslationHtml(text: string): string {
  // Source markup is text. Only our protected-token envelopes become wire tags.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(MARKER, marker => `<code translate="no">${marker}</code>`);
}

function fromTranslationHtml(html: string): string | null {
  const text = html.replace(/<code\s+translate\s*=\s*(?:"no"|'no'|no)\s*>([^<>]*)<\/code\s*>/gi, (tag, content: string) => {
    const marker = decodeHTMLStrict(content).trim();
    return /^⟪OIT_\d+⟫$/.test(marker) ? marker : tag;
  });
  // Reject unexpected tags before decoding source literals. Returned HTML never
  // reaches a renderer: only plain text and our original token grammar escape.
  if (/[<>]/.test(text)) return null;
  const decoded = decodeHTMLStrict(text);
  return decoded.trim() ? decoded : null;
}

class FreeEndpointError extends Error {
  constructor(message: string, readonly retryable = false, readonly status?: number) { super(message); }
}

function languageCode(value: string): string {
  const code = value.trim();
  if (/^zh-Hans$/i.test(code)) return 'zh-CN';
  if (/^zh-Hant$/i.test(code)) return 'zh-TW';
  if (/^auto$/i.test(code)) return 'auto';
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(code)) throw new FreeEndpointError('Choose a valid source and target language for the unofficial Google free endpoint.');
  return code;
}

function markersMatch(source: string, translated: string): boolean {
  const tokens = (text: string) => JSON.stringify((text.match(MARKER) ?? []).sort());
  return tokens(source) === tokens(translated) && !/⟪OIT_/.test(translated.replace(MARKER, ''));
}

function retryDelay(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Shape/count validation is atomic; marker validation is isolated per segment below. */
async function requestTranslations(texts: string[], source: string, target: string, signal: AbortSignal): Promise<Array<string | null>> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ client: 'gtx', dt: 't', sl: source, tl: target, format: 'html' }).toString();
  const body = new URLSearchParams();
  for (const text of texts) body.append('q', toTranslationHtml(text));
  let last = new FreeEndpointError('The unofficial Google free endpoint is unavailable. Try again later.');
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Accept-Encoding': 'identity' },
        body: body.toString(), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) {
        if (response.status === 429) throw new FreeEndpointError('The unofficial Google free endpoint is rate limited (HTTP 429). Wait before retrying.', false, 429);
        throw new FreeEndpointError(`The unofficial Google free endpoint is unavailable (HTTP ${response.status}). It has no guaranteed availability; try later or choose another provider.`, response.status >= 500, response.status);
      }
      let envelope: unknown;
      try { envelope = await response.json(); }
      catch { throw new FreeEndpointError('The unofficial Google free endpoint returned invalid JSON.'); }
      if (!Array.isArray(envelope) || envelope.length !== texts.length) throw new FreeEndpointError('The unofficial Google free endpoint returned a mismatched segment count.');
      const translated = envelope.map((item: unknown) => {
        let text: unknown = item;
        if (source === 'auto') {
          if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== 'string' || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(item[1])) throw new FreeEndpointError('The unofficial Google free endpoint returned an invalid detected-language result.');
          text = item[0];
        }
        if (typeof text !== 'string' || !text.trim()) throw new FreeEndpointError('The unofficial Google free endpoint returned an invalid translation.');
        return fromTranslationHtml(text);
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
}

interface FallbackPart { owner: number; index: number; text: string; before: string; after: string }
interface FallbackPlan { source: string; parts: string[]; error?: string }

/** Explicit opt-in no-key provider. Our conservative budgets are not service quotas. */
export function googleFreeProvider(): Provider {
  return {
    kind: 'google-free', model: 'web-unofficial', configured: true,
    cacheNamespace: 'google-free:googleapis:gtx:html:protected-code:local-marker-fallback:v3',
    batch: { maxSegments: MAX_SEGMENTS, maxCharacters: MAX_CHARACTERS },
    async translate(segments: Segment[], source: string, target: string, signal: AbortSignal): Promise<ProviderResult[]> {
      signal.throwIfAborted();
      if (!segments.length) return [];
      if (segments.length > MAX_SEGMENTS || segments.reduce((sum, segment) => sum + segment.text.length, 0) > MAX_CHARACTERS) throw new FreeEndpointError('The unofficial Google free endpoint is limited to 32 segments and 12000 characters per application batch.');
      if (new Set(segments.map(segment => segment.id)).size !== segments.length || segments.some(segment => !segment.id || typeof segment.text !== 'string' || !segment.text.trim())) throw new FreeEndpointError('Use unique IDs and nonempty text for each free translation segment.');
      const sourceCode = languageCode(source || 'auto'), targetCode = languageCode(target);
      if (targetCode === 'auto') throw new FreeEndpointError('Choose an explicit target language for the unofficial Google free endpoint.');
      if (sourceCode.toLowerCase() === targetCode.toLowerCase()) return segments.map(segment => ({ ...segment }));
      const outputs: ProviderResult[] = segments.map(segment => ({ ...segment }));
      const remote = segments.map((segment, index) => ({ ...segment, index })).filter(segment => /\p{L}/u.test(segment.text.replace(MARKER, '')));
      // Marker-only/numeric/punctuation units need no remote request.
      if (!remote.length) return outputs;
      const translated = await requestTranslations(remote.map(segment => segment.text), sourceCode, targetCode, signal);
      const plans = new Map<number, FallbackPlan>();
      const parts: FallbackPart[] = [];
      remote.forEach((segment, index) => {
        const text = translated[index]!;
        if (text !== null && markersMatch(segment.text, text)) { outputs[segment.index] = { id: segment.id, text }; return; }
        // Keep identities local if the public endpoint rewrites even one marker.
        // Whitespace and punctuation-only spans stay exactly as written in source.
        const plan: FallbackPlan = { source: segment.text, parts: segment.text.split(/(⟪OIT_\d+⟫)/g) };
        plans.set(segment.index, plan);
        plan.parts.forEach((part, partIndex) => {
          if (/^⟪OIT_\d+⟫$/.test(part) || !/\p{L}/u.test(part)) return;
          const before = part.match(/^\s*/)?.[0] || '', after = part.match(/\s*$/)?.[0] || '';
          const prose = part.slice(before.length, part.length - after.length);
          if (prose) parts.push({ owner: segment.index, index: partIndex, text: prose, before, after });
        });
      });
      const groups: FallbackPart[][] = [];
      let group: FallbackPart[] = [], characters = 0;
      for (const part of parts) {
        if (group.length && (group.length >= MAX_SEGMENTS || characters + part.text.length > MAX_CHARACTERS)) { groups.push(group); group = []; characters = 0; }
        group.push(part); characters += part.text.length;
      }
      if (group.length) groups.push(group);
      // Sequential fallback groups preserve the broker's global two-request cap.
      for (const candidates of groups) {
        signal.throwIfAborted();
        const active = candidates.filter(part => !plans.get(part.owner)!.error);
        if (!active.length) continue;
        try {
          const fallback = await requestTranslations(active.map(part => part.text), sourceCode, targetCode, signal);
          active.forEach((part, index) => {
            const text = fallback[index]!;
            const plan = plans.get(part.owner)!;
            if (text === null || /⟪OIT_/.test(text)) { plan.error = 'The unofficial Google free endpoint returned unsafe markup or protected tokens during recovery.'; return; }
            plan.parts[part.index] = part.before + text.trim() + part.after;
          });
        } catch (error) {
          signal.throwIfAborted();
          const message = error instanceof FreeEndpointError ? error.message : 'The unofficial Google free endpoint could not safely recover this paragraph.';
          for (const part of active) plans.get(part.owner)!.error = message;
          if (error instanceof FreeEndpointError && error.status === 429) {
            // A shared endpoint quota applies to the remaining recovery groups too.
            for (const plan of plans.values()) plan.error ||= message;
            break;
          }
        }
      }
      for (const [index, plan] of plans) {
        signal.throwIfAborted();
        const text = plan.parts.join('');
        outputs[index] = plan.error || !markersMatch(plan.source, text)
          ? { id: segments[index]!.id, error: plan.error || 'The unofficial Google free endpoint could not preserve protected math/code/link tokens.' }
          : { id: segments[index]!.id, text };
      }
      signal.throwIfAborted();
      return outputs;
    },
  };
}
