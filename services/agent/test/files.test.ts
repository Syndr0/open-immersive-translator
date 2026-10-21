import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { loadConfig, loopbackOrigin, MAX_INPUT_BYTES } from '../src/config.ts';
import { readInput, saveExport } from '../src/files.ts';

const active = () => new AbortController().signal;

test('agent configuration permits only HTTP loopback and environment-defined file roots', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(loopbackOrigin('http://localhost:9999'), 'http://localhost:9999');
  assert.equal(loopbackOrigin('http://[::1]:8787'), 'http://[::1]:8787');
  for (const url of ['https://127.0.0.1:8787', 'http://example.com', 'http://127.0.0.1.evil', 'http://name:secret@localhost', 'http://localhost/api', 'http://localhost?key=secret', 'file:///tmp/a']) assert.throws(() => loopbackOrigin(url));
  const config = loadConfig({ OIT_INPUT_ROOTS: `input${delimiter}other`, OIT_OUTPUT_DIR: 'out' }, '/workspace');
  assert.deepEqual(config.inputRoots, ['/workspace/input', '/workspace/other']);
  assert.equal(config.outputDirectory, '/workspace/out');
  assert.deepEqual(loadConfig({}, '/workspace').inputRoots, ['/workspace']);
  assert.throws(() => loadConfig({ OIT_INPUT_ROOTS: '' }, '/workspace'), /at least one/);
});

test('local imports reject symlink escapes, sibling-prefix paths, directories and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oit-agent-files-'));
  const allowed = join(root, 'allowed'), sibling = join(root, 'allowed-other');
  await mkdir(allowed); await mkdir(sibling);
  const config = loadConfig({ OIT_INPUT_ROOTS: allowed }, root);
  try {
    const file = join(allowed, 'notes.md'); await writeFile(file, 'Original content');
    const input = await readInput(config, { localPath: file }, active());
    assert.equal(input.fileName, 'notes.md'); assert.equal(input.bytes.toString(), 'Original content');
    const outside = join(sibling, 'outside.md'); await writeFile(outside, 'Outside content');
    await assert.rejects(() => readInput(config, { localPath: outside }, active()), /outside OIT_INPUT_ROOTS/);
    const link = join(allowed, 'escape.md'); await symlink(outside, link);
    await assert.rejects(() => readInput(config, { localPath: link }, active()), /outside OIT_INPUT_ROOTS/);
    await assert.rejects(() => readInput(config, { localPath: allowed }, active()), /regular file/);
    const big = join(allowed, 'big.pdf'); await writeFile(big, ''); await truncate(big, MAX_INPUT_BYTES + 1);
    await assert.rejects(() => readInput(config, { localPath: big }, active()), /25 MB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment imports validate exact modes, base64 padding and UTF-8 bytes', async () => {
  const config = loadConfig({}, '/workspace');
  const encoded = Buffer.from('研究 & original').toString('base64');
  const imported = await readInput(config, { fileName: 'notes.md', base64: encoded }, active());
  assert.equal(imported.bytes.toString('utf8'), '研究 & original');
  assert.equal((await readInput(config, { fileName: 'notes.txt', text: '你好' }, active())).bytes.length, 6);
  for (const base64 of ['a', 'AA=', 'AAAA=', 'AB==', 'AA$=']) await assert.rejects(() => readInput(config, { fileName: 'notes.pdf', base64 }, active()), /base64/);
  await assert.rejects(() => readInput(config, { fileName: '../escape.md', text: 'Words' }, active()));
  await assert.rejects(() => readInput(config, { localPath: '/workspace/doc.md', fileName: 'doc.md', text: 'Words' }, active()), /exactly/);
  await assert.rejects(() => readInput(config, { fileName: 'notes.md', text: 'Words', base64: encoded }, active()), /exactly/);
  const cancelled = new AbortController(); cancelled.abort(new Error('Cancelled by the client'));
  await assert.rejects(() => readInput(config, { fileName: 'notes.txt', text: 'Words' }, cancelled.signal), /Cancelled/);
});

test('exports are confined to the configured directory and never overwrite an existing artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oit-agent-export-'));
  const config = loadConfig({ OIT_OUTPUT_DIR: join(root, 'exports') }, root);
  try {
    const first = await saveExport(config, '../../unsafe<title>.md', 'html', Buffer.from('First export'), active());
    const second = await saveExport(config, '../../unsafe<title>.md', 'html', Buffer.from('Second export'), active());
    assert.equal(dirname(first.path), await realpath(config.outputDirectory));
    assert.equal(dirname(second.path), await realpath(config.outputDirectory));
    assert.notEqual(first.path, second.path);
    assert.equal(first.fileName.includes('/'), false);
    assert.equal(await readFile(first.path, 'utf8'), 'First export');
    assert.equal(await readFile(second.path, 'utf8'), 'Second export');
    const paper = await saveExport(config, '2306.10998v1-fr', 'html', Buffer.from('Paper export'), active());
    assert.ok(paper.fileName.startsWith('2306.10998v1-fr-'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
