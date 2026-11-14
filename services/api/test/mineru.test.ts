import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { zipSync, strToU8 } from 'fflate';
import { mineruBlocks, readMineruArchive, type MineruResult } from '../src/mineru.ts';
import { createApp } from '../src/app.ts';
import type { Provider } from '@oit/core';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
// Shapes taken from MinerU 4.2 output for real lecture notes and a paper.
const result: MineruResult = { metadata: { document: { page_count: 2 } }, pages: [
  { page_idx: 0, blocks: [
    { type: 'header', content: 'LECTURE 3' },
    { type: 'doc_title', level: 1, content: 'Fixed Horizon' },
    { type: 'paragraph_title', level: 2, content: '3.1 Setting' },
    { type: 'text', content: 'A finite-horizon MDP with horizon  $ N \\in \\mathbb{N} $ , where &lt;dishu&gt;' },
    { type: 'text', content: '1. Set up the fixed-horizon problem.' },
    { type: 'equation', content: '\\pi_t^\\star(a\\mid s)&gt;0', image_source: 'images/page_0_equation_9.jpg' },
    { type: 'code', sub_type: 'algorithm', content: 'Theorem 3.1: Adequacy of Markov policies\nFix an initial distribution $\\mu_0$. For any policy\n$\\pi \\in \\Pi$ the value is preserved.' },
    { type: 'code', sub_type: 'code', content: 'for t in range(N):\n    v[t] = max(q[t])' },
    { type: 'table', content: '| Theorem 4.4: Exact policy evaluation |\n| --- |\n| Let $\\pi \\in \\Pi_S$ and $\\gamma \\in (0,1)$. |', captions: [] },
    { type: 'image', content: '', image_source: 'images/page_0_image_8.jpg', captions: [{ content: 'Figure 3.1: A small problem.' }], footnotes: [{ content: '<sup>2</sup>Edges are rewards.' }] },
    { type: 'text', content: 'The recursion runs backwards and its cost grows with the' },
    { type: 'page_number', content: '1' },
  ] },
  { page_idx: 1, blocks: [
    { type: 'header', content: 'LECTURE 3' },
    { type: 'text', content: 'number of stages, not exponentially.' },
    { type: 'table', content: '<table><tbody><tr><td rowspan="2"></td><td rowspan="2">without</td><td>with</td></tr><tr><td>context</td></tr><tr><td>T-Rand</td><td>13.89</td><td>66.53</td></tr></tbody></table>', captions: [{ content: 'Table 6: Context ablation.' }] },
    { type: 'ref_text', content: '[1] Martin L. Puterman. Markov Decision Processes. Wiley &amp; Sons, 1994.' },
    { type: 'page_footnote', content: '<sup>∗</sup>Correspondence to: &lt;a@b.org&gt;' },
    { type: 'aside_text', content: 'arXiv:2306.10998v1 [cs.LG]' },
  ] },
] };

test('MinerU blocks map onto reading blocks: math, boxes, tables, figures, references and page breaks', () => {
  const { blocks, assets, pageCount } = mineruBlocks(result, { 'images/page_0_equation_9.jpg': jpeg, 'images/page_0_image_8.jpg': jpeg });
  assert.equal(pageCount, 2);
  assert.deepEqual(assets.map(asset => asset.name), ['formula-1.jpg', 'figure-1.jpg']);
  assert.deepEqual(blocks.map(block => [block.type, block.level ?? block.marker ?? block.asset ?? null, block.text]), [
    ['heading', 1, 'Fixed Horizon'],
    ['heading', 2, '3.1 Setting'],
    ['paragraph', null, 'A finite-horizon MDP with horizon $N \\in \\mathbb{N}$ , where <dishu>'],
    ['list', '1.', 'Set up the fixed-horizon problem.'],
    ['formula', 'formula-1.jpg', '\\pi_t^\\star(a\\mid s)>0'],
    ['heading', 4, 'Theorem 3.1: Adequacy of Markov policies'],
    ['paragraph', null, 'Fix an initial distribution $\\mu_0$. For any policy $\\pi \\in \\Pi$ the value is preserved.'],
    ['code', null, 'for t in range(N):\n    v[t] = max(q[t])'],
    ['heading', 4, 'Theorem 4.4: Exact policy evaluation'],
    ['paragraph', null, 'Let $\\pi \\in \\Pi_S$ and $\\gamma \\in (0,1)$.'],
    ['figure', 'figure-1.jpg', ''],
    ['caption', null, 'Figure 3.1: A small problem.'],
    ['footnote', null, '2Edges are rewards.'],
    ['paragraph', null, 'The recursion runs backwards and its cost grows with the number of stages, not exponentially.'],
    ['caption', null, 'Table 6: Context ablation.'],
    ['table', null, '|  | without | with |\n| --- | --- | --- |\n|  | without | context |\n| T-Rand | 13.89 | 66.53 |'],
    ['reference', null, '[1] Martin L. Puterman. Markov Decision Processes. Wiley & Sons, 1994.'],
    ['footnote', null, '∗Correspondence to: <a@b.org>'],
  ]);
});

test('the result archive is read without extracting anything to disk', () => {
  const archive = zipSync({ 'structured_content.json': strToU8(JSON.stringify(result)), 'images/page_0_equation_9.jpg': jpeg, 'images/page_0_image_8.jpg': jpeg, 'images/../escape.jpg': jpeg, 'markdown.md': strToU8('# ignored') });
  const read = readMineruArchive(archive);
  assert.equal(read.assets.length, 2);
  assert.throws(() => readMineruArchive(zipSync({ 'markdown.md': strToU8('# only markdown') })), /no structured content/);
});

const fixture: Provider = { kind: 'fixture', model: 'test', configured: true, async translate(segments) { return segments; } };

/** A one-page PDF with a real text layer, so the built-in fallback has something to read. */
function textPdf(line: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => { const offset = body.length; body += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('imports use a running MinerU service and fall back with a note when it fails', async () => {
  const uploads: number[] = [];
  let fail = false;
  const archive = zipSync({ 'structured_content.json': strToU8(JSON.stringify(result)), 'images/page_0_equation_9.jpg': jpeg, 'images/page_0_image_8.jpg': jpeg });
  // A stand-in for MinerU's task API.
  const mineru = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(mineru.address() as AddressInfo).port}`;
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const send = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
      if (request.url === '/v1/health') return send({ status: 'ok' });
      if (request.method === 'POST' && request.url === '/v1/tasks') return send({ task_id: 'job_1', status: 'waiting-file', files: [{ file_id: 'file-1', status: 'waiting-file', upload: { url: `${origin}/v1/tasks/job_1/uploads/file-1` } }] });
      if (request.method === 'PUT') { uploads.push(Buffer.concat(chunks).length); return send({ status: 'pending' }); }
      if (request.url === '/v1/tasks/job_1') return send(fail ? { task_id: 'job_1', status: 'failed', files: [{ status: 'failed', error: { message: 'model crashed' } }] } : { task_id: 'job_1', status: 'completed', files: [{ status: 'completed', result_url: `${origin}/v1/files/file-1/content` }] });
      if (request.url === '/v1/files/file-1/content') { response.setHeader('Content-Type', 'application/zip'); return response.end(Buffer.from(archive)); }
      response.statusCode = 404; response.end();
    });
  });
  await new Promise<void>(resolve => mineru.listen(0, '127.0.0.1', resolve));
  const dataDir = await mkdtemp(`${tmpdir()}/oit-mineru-test-`);
  const api = await createApp({ dataDir, provider: fixture, env: { PARSER: 'mineru', MINERU_URL: `http://127.0.0.1:${(mineru.address() as AddressInfo).port}` } });
  const server = api.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pdf = textPdf('Fallback text survives a parser failure.');
  const upload = () => fetch(`${base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'lecture.pdf' }, body: new Uint8Array(pdf) }).then(r => r.json());
  try {
    const { document } = await upload();
    assert.deepEqual(uploads, [pdf.length]);
    assert.equal(document.pageCount, 2);
    assert.deepEqual(document.warnings, []);
    assert.equal(document.blocks.length, 18);
    const formula = document.blocks.find((block: { type: string }) => block.type === 'formula');
    assert.equal(formula.text, '\\pi_t^\\star(a\\mid s)>0');
    const image = await fetch(`${base}/api/documents/${document.id}/assets/${formula.asset}`);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), jpeg);

    fail = true;
    const fallback = (await upload()).document;
    assert.deepEqual(fallback.blocks.map((block: { text: string }) => block.text), ['Fallback text survives a parser failure.']);
    assert.match(fallback.warnings[0], /^MinerU could not read this PDF \(MinerU could not read this PDF: model crashed\), so a simpler parser was used\.$/);
  } finally { api.close(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => mineru.close(() => resolve())); await rm(dataDir, { recursive: true, force: true }); }
});

test('MinerU is only reached on this computer', async () => {
  const { MineruService } = await import('../src/mineru.ts');
  await assert.rejects(new MineruService({ PARSER: 'mineru', MINERU_URL: 'http://example.org:8793' }, '/').parse('x.pdf', Buffer.from('%PDF')), /loopback/);
  await assert.rejects(new MineruService({ PARSER: 'mineru', MINERU_URL: 'http://127.0.0.1:9' }, '/').parse('x.pdf', Buffer.from('%PDF')));
  await assert.rejects(new MineruService({ PARSER: 'mineru', MINERU_COMMAND: '/nonexistent/mineru-kit', MINERU_PORT: '9' }, '/').parse('x.pdf', Buffer.from('%PDF')), /Cannot start MinerU/);
});
