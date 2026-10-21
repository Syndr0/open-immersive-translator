import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('./dist', import.meta.url), { recursive: true });
await cp(new URL('./public', import.meta.url), new URL('./dist', import.meta.url), { recursive: true });
await build({
  entryPoints: ['src/background.ts', 'src/content.ts', 'src/popup.ts', 'src/options.ts'],
  outdir: 'dist', bundle: true, format: 'iife', target: 'chrome120',
  sourcemap: false, legalComments: 'eof',
});
