import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface AgentConfig {
  apiUrl: string;
  inputRoots: string[];
  outputDirectory: string;
  cwd: string;
}

export function loopbackOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('OIT_API_URL must be an HTTP loopback origin, for example http://127.0.0.1:8787.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('OIT_API_URL must be an HTTP loopback origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AgentConfig {
  const roots = env.OIT_INPUT_ROOTS === undefined ? [cwd] : env.OIT_INPUT_ROOTS.split(delimiter).map(value => value.trim()).filter(Boolean);
  if (!roots.length) throw new Error('OIT_INPUT_ROOTS must contain at least one permitted input directory.');
  return {
    apiUrl: loopbackOrigin(env.OIT_API_URL || 'http://127.0.0.1:8787'),
    inputRoots: roots.map(root => resolve(cwd, root)),
    outputDirectory: resolve(cwd, env.OIT_OUTPUT_DIR || resolve(REPO_ROOT, '.data/agent-exports')),
    cwd,
  };
}
