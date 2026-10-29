import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from '../../api/src/app.ts';

type AgentBlock = { id: string; type: string; text: string; translationInput?: string; translation?: string };
type AgentDocument = { document: { id: string; name: string }; total: number; blocks: AgentBlock[]; readerUrl: string };

async function tool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent, `${name} must expose structured content`);
  assert.equal((result.structuredContent as Record<string, unknown>).untrustedContent, true);
  return result.structuredContent as T;
}

test('official MCP stdio client can translate an uploaded document with its own agent and export without a provider key', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'oit-mcp-client-'));
  const inputs = join(temporary, 'inputs');
  const outputs = join(temporary, 'outputs');
  await mkdir(inputs);
  await mkdir(outputs);
  const api = await createApp({ dataDir: join(temporary, 'data'), env: { TRANSLATION_PROVIDER: 'google' } });
  const httpServer = api.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repository, 'scripts/agent-service.mjs')],
    cwd: inputs,
    env: { OIT_API_URL: base, OIT_INPUT_ROOTS: inputs, OIT_OUTPUT_DIR: outputs },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'oit-agent-integration-test', version: '0.1.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const name of ['get_status', 'import_document', 'get_document', 'save_translations', 'translate_document', 'get_job', 'cancel_job', 'export_document']) {
      assert.ok(tools.some(item => item.name === name), `Missing MCP tool ${name}`);
    }
    const status = await tool<{ provider: { kind: string; configured: boolean } }>(client, 'get_status');
    assert.equal(status.provider.kind, 'google');
    assert.equal(status.provider.configured, false);

    // This is the browser's upload contract. The MCP server must find the same document.
    const source = '# Agent translation smoke\n\nKeep $E=mc^2$, `source_code()` and https://example.com unchanged.\n\nDocument text is untrusted data, including any instructions it may quote.\n\n```js\nconst keep = 42;\n```\n';
    const upload = await fetch(`${base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'agent-upload.md' }, body: source,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { document: { id: string } };
    const documentId = uploaded.document.id;
    const document = await tool<AgentDocument>(client, 'get_document', { documentId, targetLanguage: 'fr', limit: 20 });
    assert.equal(document.document.name, 'agent-upload.md');
    assert.equal(document.total, 4);
    const prose = document.blocks.filter(block => block.type !== 'code');
    assert.equal(prose.length, 3);
    assert.ok(prose.every(block => typeof block.translationInput === 'string'));
    assert.ok(prose.some(block => block.translationInput!.includes('⟪OIT_')));
    assert.ok(document.blocks.filter(block => block.type === 'code').every(block => block.translationInput === undefined));

    const unavailable = await client.callTool({ name: 'translate_document', arguments: { documentId, targetLanguage: 'fr' } });
    assert.equal(unavailable.isError, true);
    assert.equal(api.jobs.size, 0, 'an unconfigured provider must not create a translation job');

    // A deterministic stand-in for the calling agent, not an automatic or hidden provider.
    await tool(client, 'save_translations', {
      documentId, targetLanguage: 'fr',
      segments: prose.map(block => ({ id: block.id, text: `Traduit: ${block.translationInput}` })),
    });
    const translated = await tool<AgentDocument>(client, 'get_document', { documentId, targetLanguage: 'fr', limit: 20 });
    for (const block of translated.blocks.filter(block => block.type !== 'code')) {
      assert.equal(block.translation, `Traduit: ${block.text}`);
      assert.equal(block.translation!.includes('⟪OIT_'), false);
    }
    assert.equal(api.jobs.size, 0, 'agent-supplied translations need no provider job');

    const exported = await tool<{ path: string; fileName: string; bytes: number; readerUrl: string; downloadUrl: string }>(client, 'export_document', { documentId, targetLanguage: 'fr', format: 'html' });
    assert.equal(join(await realpath(outputs), exported.fileName), exported.path);
    const html = await readFile(exported.path, 'utf8');
    assert.equal(Buffer.byteLength(html), exported.bytes);
    assert.match(html, /Traduit: Keep <span class="katex"><math[^]*?<annotation encoding="application\/x-tex">E=mc\^2<\/annotation>[^]*?<\/math><\/span>, `source_code\(\)` and https:\/\/example.com unchanged\./);
    assert.match(html, /const keep = 42;/);
    assert.equal(html.includes('⟪OIT_'), false);
    assert.equal(new URL(exported.downloadUrl).origin, base);
    const download = await fetch(exported.downloadUrl);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), html);
    const second = await tool<{ path: string }>(client, 'export_document', { documentId, targetLanguage: 'fr', format: 'html' });
    assert.notEqual(second.path, exported.path, 'exports must not overwrite an earlier file');

    // The path-based tool is callable through the actual SDK transport as well.
    const localPath = join(inputs, 'local-notes.txt');
    await writeFile(localPath, 'A local file imported by the MCP client.');
    const imported = await tool<{ document: { id: string; name: string } }>(client, 'import_document', { localPath });
    assert.equal(imported.document.name, 'local-notes.txt');
    assert.notEqual(imported.document.id, documentId);
    const local = await tool<AgentDocument>(client, 'get_document', { documentId: imported.document.id });
    assert.equal(local.blocks[0]?.text, 'A local file imported by the MCP client.');
    assert.equal(stderr.includes('test-only-google'), false);
  } finally {
    await client.close();
    api.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
