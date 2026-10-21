import { type AgentConfig, loopbackOrigin } from './config.ts';

const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
export class ApiError extends Error {}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Buffer> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new ApiError('API response exceeds the 50 MB safety limit.'); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ApiError('API response exceeds the 50 MB safety limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

/** HTTP is confined to the configured loopback origin. No tool accepts a destination URL. */
export class AgentApi {
  readonly origin: string;
  constructor(config: AgentConfig, private fetcher: typeof fetch = fetch) { this.origin = loopbackOrigin(config.apiUrl); }
  async request(path: string, init: RequestInit = {}, signal: AbortSignal = new AbortController().signal): Promise<Buffer> {
    if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('\\')) throw new ApiError('Invalid local API path.');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/')) throw new ApiError('Requests must remain on the local API origin and API path.');
    signal.throwIfAborted();
    try {
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
      if (response.status >= 300 && response.status < 400) throw new ApiError('The local API returned a redirect; redirects are not followed.');
      const bytes = await boundedBody(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        let detail = '';
        try { const body = JSON.parse(bytes.toString('utf8')); if (typeof body.error === 'string') detail = body.error.slice(0, 2000); } catch { /* Only structured local API errors are shown. */ }
        throw new ApiError(`Local API returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
      }
      return bytes;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError) throw error;
      throw new ApiError('Cannot reach the local Open Immersive Translator API. Start it from the repository with npm start (or npm run dev), then check OIT_API_URL.');
    }
  }
  async json<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const bytes = await this.request(path, init, signal);
    try { return JSON.parse(bytes.toString('utf8')) as T; }
    catch { throw new ApiError('The local API returned invalid JSON. Check that OIT_API_URL points to Open Immersive Translator.'); }
  }
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal);
  }
}
