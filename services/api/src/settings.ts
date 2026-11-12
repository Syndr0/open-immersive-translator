import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Services a user can pick in the app. `demo` stays environment-only, for tests. */
export const PROVIDER_KINDS = ['google-free', 'google', 'ollama', 'compatible', 'codex'] as const;

export interface ProviderSettings {
  kind: string;
  ollama: { baseUrl: string; model: string };
  compatible: { baseUrl: string; model: string; apiKey: string };
  google: { apiKey: string };
  codex: { model: string };
}

const text = (maximum: number) => z.string().trim().max(maximum);
const baseUrl = text(500).min(1).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, 'Use an http(s) URL without embedded credentials');
const model = text(200).min(1);
const apiKey = text(1000);
const stored = z.object({
  kind: text(40).min(1),
  ollama: z.object({ baseUrl, model }),
  compatible: z.object({ baseUrl, model, apiKey }),
  google: z.object({ apiKey }),
  codex: z.object({ model }),
});

/**
 * A change request. Omitted fields keep their saved value; an empty API key clears it.
 * The Codex executable path is deliberately not settable through the API.
 */
export const providerInput = z.object({
  kind: z.enum(PROVIDER_KINDS),
  ollama: z.object({ baseUrl, model }).partial().optional(),
  compatible: z.object({ baseUrl, model, apiKey }).partial().optional(),
  google: z.object({ apiKey }).partial().optional(),
  codex: z.object({ model }).partial().optional(),
});
export type ProviderInput = z.infer<typeof providerInput>;

/** Mirrors the defaults the provider factories apply to an empty environment. */
export function settingsFromEnv(env: NodeJS.ProcessEnv): ProviderSettings {
  return {
    kind: env.TRANSLATION_PROVIDER || 'ollama',
    ollama: { baseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', model: env.OLLAMA_MODEL || 'qwen3.5:2b' },
    compatible: { baseUrl: env.COMPATIBLE_BASE_URL || 'http://127.0.0.1:1234/v1', model: env.COMPATIBLE_MODEL || 'local-model', apiKey: env.COMPATIBLE_API_KEY?.trim() || '' },
    google: { apiKey: env.GOOGLE_TRANSLATE_API_KEY?.trim() || '' },
    codex: { model: env.CODEX_MODEL?.trim() || 'gpt-6.1-sol' },
  };
}

/** The provider factories read an environment map; settings are an overlay on it. */
export function settingsToEnv(settings: ProviderSettings, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env,
    TRANSLATION_PROVIDER: settings.kind,
    OLLAMA_BASE_URL: settings.ollama.baseUrl, OLLAMA_MODEL: settings.ollama.model,
    COMPATIBLE_BASE_URL: settings.compatible.baseUrl, COMPATIBLE_MODEL: settings.compatible.model, COMPATIBLE_API_KEY: settings.compatible.apiKey,
    GOOGLE_TRANSLATE_API_KEY: settings.google.apiKey,
    CODEX_MODEL: settings.codex.model,
  };
}

const sameOrigin = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

export function mergeProviderSettings(current: ProviderSettings, input: ProviderInput): ProviderSettings {
  const next: ProviderSettings = structuredClone(current);
  next.kind = input.kind;
  if (input.ollama?.baseUrl !== undefined) next.ollama.baseUrl = input.ollama.baseUrl;
  if (input.ollama?.model !== undefined) next.ollama.model = input.ollama.model;
  if (input.compatible?.baseUrl !== undefined) next.compatible.baseUrl = input.compatible.baseUrl;
  if (input.compatible?.model !== undefined) next.compatible.model = input.compatible.model;
  // A saved key belongs to the server it was entered for. Pointing the service at
  // another host without re-entering the key must never send the old key there.
  if (input.compatible?.apiKey !== undefined) next.compatible.apiKey = input.compatible.apiKey;
  else if (!sameOrigin(next.compatible.baseUrl, current.compatible.baseUrl)) next.compatible.apiKey = '';
  if (input.google?.apiKey !== undefined) next.google.apiKey = input.google.apiKey;
  if (input.codex?.model !== undefined) next.codex.model = input.codex.model;
  return next;
}

/** What a browser may see: keys are reported only as present or absent. */
export function publicProviderSettings(settings: ProviderSettings) {
  return {
    kind: settings.kind,
    ollama: { ...settings.ollama },
    compatible: { baseUrl: settings.compatible.baseUrl, model: settings.compatible.model, hasApiKey: Boolean(settings.compatible.apiKey) },
    google: { hasApiKey: Boolean(settings.google.apiKey) },
    codex: { ...settings.codex },
  };
}

/** Saved choices live beside the documents, readable only by the owner. */
export class SettingsFile {
  private readonly path: string;
  constructor(directory: string) { this.path = join(directory, 'settings.json'); }
  async load(): Promise<ProviderSettings | undefined> {
    try {
      const parsed = stored.safeParse((JSON.parse(await readFile(this.path, 'utf8')) as { provider?: unknown }).provider);
      return parsed.success ? parsed.data : undefined;
    } catch { return undefined; }
  }
  async save(provider: ProviderSettings | undefined): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, ...(provider ? { provider } : {}) }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** Installed models, to offer as choices. Failures only mean no suggestions. */
export async function listModels(settings: ProviderSettings, signal: AbortSignal): Promise<string[]> {
  if (settings.kind !== 'ollama' && settings.kind !== 'compatible') return [];
  const base = (settings.kind === 'ollama' ? settings.ollama.baseUrl : settings.compatible.baseUrl).replace(/\/$/, '');
  const response = await fetch(`${base}${settings.kind === 'ollama' ? '/api/tags' : '/models'}`, {
    headers: settings.kind === 'compatible' && settings.compatible.apiKey ? { Authorization: `Bearer ${settings.compatible.apiKey}` } : {},
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  if (!response.ok) throw new Error(`The service returned HTTP ${response.status}`);
  const body = await response.json() as { models?: Array<{ name?: unknown }>; data?: Array<{ id?: unknown }> };
  const names = settings.kind === 'ollama' ? body.models?.map(item => item?.name) : body.data?.map(item => item?.id);
  return [...new Set((names ?? []).filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 200))].sort().slice(0, 200);
}
