import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.filter(entry => !['node_modules', 'dist', '.data'].includes(entry.name)).map(async entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collect(path) : /\.test\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

const files = (await Promise.all(['packages', 'services', 'apps'].map(collect))).flat().sort();
if (!files.length) throw new Error('No unit/integration tests found.');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
