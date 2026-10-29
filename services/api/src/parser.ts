import { createHash, randomUUID } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SourceDocument, DocumentBlock, BlockType } from '@oit/core';
import { layoutBlocks, type PdfPage } from './pdf-text.ts';
import { ASSET_NAME, type DocumentAsset } from './store.ts';

export interface ParsedDocument extends SourceDocument { assets: DocumentAsset[] }
const BLOCK_TYPES: BlockType[] = ['heading', 'paragraph', 'list', 'caption', 'reference', 'footnote', 'table', 'code', 'formula', 'figure'];

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const supported = ['.pdf', '.txt', '.md', '.markdown', '.html', '.htm', '.docx'];

/** Bound declared ZIP expansion before handing DOCX data to the parser. */
export function validateDocxArchive(input: Buffer): void {
  const end = input.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > input.length || end + 22 + input.readUInt16LE(end + 20) !== input.length) throw new Error('DOCX has an invalid ZIP directory');
  const count = input.readUInt16LE(end + 10);
  let offset = input.readUInt32LE(end + 16), expanded = 0;
  if (count > 2000 || count === 0 || offset === 0xffffffff || input.readUInt16LE(end + 4) !== 0) throw new Error('DOCX ZIP exceeds supported archive limits');
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || input.readUInt32LE(offset) !== 0x02014b50) throw new Error('DOCX has an invalid ZIP entry');
    const size = input.readUInt32LE(offset + 24);
    expanded += size;
    if (size > 30 * 1024 * 1024 || expanded > 100 * 1024 * 1024 || (input.readUInt16LE(offset + 8) & 1)) throw new Error('DOCX is encrypted or exceeds the expanded-size limit');
    offset += 46 + input.readUInt16LE(offset + 28) + input.readUInt16LE(offset + 30) + input.readUInt16LE(offset + 32);
  }
  if (offset > end) throw new Error('DOCX has an invalid ZIP directory size');
}

export function markdownBlocks(markdown: string): Omit<DocumentBlock, 'id'>[] {
  const blocks: Omit<DocumentBlock, 'id'>[] = [];
  let lines: string[] = [], code: string[] | undefined;
  const flush = () => { const text = lines.join('\n').trim(); if (text) blocks.push({ type: /^\|.*\|\s*\n\|?\s*:?-/.test(text) ? 'table' : 'paragraph', text }); lines = []; };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push({ type: 'code', text: code.join('\n') }); code = undefined; }
      else { flush(); code = []; }
    } else if (code) code.push(line);
    else if (/^#{1,6}\s/.test(line)) {
      flush(); const match = /^(#{1,6})\s+(.*)$/.exec(line)!;
      blocks.push({ type: 'heading', text: match[2]!, level: match[1]!.length });
    } else if (!line.trim()) flush();
    else lines.push(line);
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  flush();
  return blocks;
}

export function htmlToText(input: string): string {
  // No HTML is executed or mounted. This adapter intentionally extracts prose only.
  return input.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(?:p|div|h[1-6]|section|article|li|tr)>/gi, '\n\n')
    .replace(/<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, entity => {
      const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
      const raw = entity.slice(2, -1), code = raw[0]?.toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : parseInt(raw, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

export async function parseDocument(name: string, input: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<ParsedDocument> {
  const extension = extname(name).toLowerCase();
  if (!supported.includes(extension)) throw new Error('Supported formats: PDF, TXT, Markdown, HTML and DOCX');
  if (!input.length) throw new Error('Document is empty');
  if (input.length > 25 * 1024 * 1024) throw new Error('Document exceeds 25 MB limit');
  let raw: Omit<DocumentBlock, 'id'>[] = [];
  let assets: DocumentAsset[] = [];
  const warnings: string[] = [];
  let pageCount: number | undefined;
  if (env.PARSER === 'docling' && extension === '.pdf') {
    if (!input.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('File does not contain a PDF header');
    const result = await docling(input, env);
    raw = result.blocks; pageCount = result.pageCount; assets = result.assets;
  } else if (extension === '.pdf') {
    if (!input.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('File does not contain a PDF header');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(input), useSystemFonts: true, verbosity: 0 });
    const pdf = await task.promise;
    pageCount = pdf.numPages;
    if (pageCount > 300) { await task.destroy(); throw new Error('PDF exceeds 300-page limit'); }
    try {
      const pages: PdfPage[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        const { width, height } = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        pages.push({ width, height, items: content.items.filter(item => 'str' in item) });
      }
      raw = layoutBlocks(pages);
    } finally { await task.destroy(); }
    warnings.push('Built-in PDF extraction reads the text layer only: figures, formulas and table grids need the Docling parser (PARSER=docling).');
  } else if (extension === '.docx') {
    validateDocxArchive(input);
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: input });
    raw = markdownBlocks(result.value);
    warnings.push('DOCX text is reflowed. Images, run styling, headers and original-layout DOCX export are not preserved.');
    warnings.push(...result.messages.map(message => message.message));
  } else {
    let text = new TextDecoder('utf-8', { fatal: true }).decode(input).replace(/^\uFEFF/, '');
    if (extension === '.html' || extension === '.htm') {
      text = htmlToText(text); warnings.push('HTML is imported as text. Scripts, styles, images and original page layout are discarded.');
    }
    raw = markdownBlocks(text);
  }
  if (!raw.some(block => block.text.trim())) throw new Error('No readable text found. For scanned PDFs, enable the optional Docling OCR adapter.');
  if (raw.length > 5000) throw new Error('Document exceeds 5000-block limit');
  const sourceHash = hash(input);
  return {
    id: randomUUID(), name, format: extension.slice(1), sourceHash, pageCount,
    blocks: raw.map((block, index) => ({ ...block, id: hash(`${sourceHash}:parser-v2:${env.PARSER || 'basic'}:${index}`).slice(0, 24) })),
    warnings, createdAt: new Date().toISOString(), assets,
  };
}

async function docling(input: Buffer, env: NodeJS.ProcessEnv): Promise<{ blocks: Omit<DocumentBlock, 'id'>[]; pageCount?: number; assets: DocumentAsset[] }> {
  const directory = await mkdtemp(`${tmpdir()}/oit-docling-`);
  const path = `${directory}/input.pdf`, assetDirectory = `${directory}/assets`;
  await writeFile(path, input);
  await mkdir(assetDirectory);
  try {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const worker = fileURLToPath(new URL('../../../workers/docling/parse.py', import.meta.url));
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(resolve(root, env.DOCLING_PYTHON || 'python3'), [worker, path, assetDirectory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let stdout = '', stderr = '', finished = false;
      const timeout = setTimeout(() => { finished = true; child.kill('SIGTERM'); reject(new Error('Docling recognition timed out after 10 minutes')); }, 600_000);
      child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 20_000_000) { child.kill('SIGTERM'); } });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
      child.on('error', () => { clearTimeout(timeout); reject(new Error('Cannot start Docling. Set DOCLING_PYTHON to the Python environment with workers/docling/requirements.txt installed.')); });
      child.on('close', code => {
        clearTimeout(timeout); if (finished) return;
        if (code !== 0) reject(new Error(`Docling recognition failed. Check the parser environment and model installation.${stderr.includes('No module named') ? ' The docling package is missing.' : ''}`));
        else resolveOutput(stdout);
      });
    });
    const parsed = JSON.parse(output) as { blocks?: unknown; pageCount?: number };
    if (!Array.isArray(parsed.blocks)) throw new Error('Docling returned an invalid document');
    const names = new Set((await readdir(assetDirectory)).filter(name => ASSET_NAME.test(name)));
    const blocks: Omit<DocumentBlock, 'id'>[] = [];
    for (const value of parsed.blocks as Array<Record<string, unknown>>) {
      const type = value.type as BlockType;
      if (!BLOCK_TYPES.includes(type) || typeof value.text !== 'string' || value.text.length > 100_000) continue;
      if (type === 'figure' && !(typeof value.asset === 'string' && names.has(value.asset))) continue;
      blocks.push({ type, text: value.text,
        ...(Number.isInteger(value.page) ? { page: value.page as number } : {}),
        ...(type === 'heading' && Number.isInteger(value.level) ? { level: Math.min(6, Math.max(1, value.level as number)) } : {}),
        ...(type === 'list' && typeof value.marker === 'string' ? { marker: value.marker.slice(0, 16) } : {}),
        ...(type === 'figure' ? { asset: value.asset as string } : {}) });
    }
    const used = new Set(blocks.flatMap(block => block.asset ? [block.asset] : []));
    const assets = await Promise.all([...used].map(async name => ({ name, bytes: await readFile(`${assetDirectory}/${name}`) })));
    return { blocks, pageCount: parsed.pageCount, assets };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
