import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { formatTable, type BlockType, type DocumentBlock } from '@oit/core';
import type { DocumentAsset } from './store.ts';

/**
 * MinerU (https://github.com/opendatalab/MinerU) reads PDFs with layout and formula
 * models and returns LaTeX for display and inline math. It runs as its own local
 * HTTP service so its models stay loaded between documents.
 */

type Block = Omit<DocumentBlock, 'id'>;
interface MineruCaption { content?: string }
interface MineruBlock {
  type: string; sub_type?: string; level?: number; content?: string; image_source?: string;
  captions?: MineruCaption[]; footnotes?: MineruCaption[];
}
export interface MineruResult { pages: Array<{ page_idx: number; blocks: MineruBlock[] }>; metadata?: { document?: { page_count?: number } } }

const DROPPED = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_header', 'page_footer']);
const SENTENCE_END = /[.!?:;。！？：；)\]]["'”’]?$/;
const THEOREM = /^(?:Theorem|Lemma|Proposition|Corollary|Definition|Algorithm|Assumption|Example|Remark|Claim|Fact|Proof)\b[^\n]{0,160}$/;
const LIST_ITEM = /^(\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)]|[•◦▪‣∙·\-–—*])\s+/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** MinerU output is Markdown-flavoured: decode entities and keep the text of the few HTML tags it emits. */
function clean(text: string): string {
  return text
    .replace(/<sup>(.*?)<\/sup>/g, '$1').replace(/<sub>(.*?)<\/sub>/g, '$1').replace(/<\/?(?:span|b|i|em|strong|u)\b[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(\d+);|&#x([0-9a-f]+);/gi, (match, name?: string, decimal?: string, hex?: string) => {
      if (name) return ENTITIES[name.toLowerCase()] ?? match;
      const code = decimal ? Number(decimal) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    // Inline math as `$x$`, without the padding spaces some models add inside the delimiters.
    .replace(/(?<!\$)\$(?!\$)\s*([^$\n]+?)\s*\$(?!\$)/g, (_match, math: string) => `$${math}$`)
    .replace(/[ \t]+/g, ' ').trim();
}

/** HTML tables (used for merged cells) as a grid; a spanning cell repeats its text across the cells it covers. */
function htmlTableRows(html: string): string[][] | undefined {
  const grid: string[][] = [];
  const pending = new Map<string, string>();
  [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].forEach((row, r) => {
    const cells = grid[r] ??= [];
    let c = 0;
    for (const cell of row[1]!.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      while (cells[c] !== undefined || pending.has(`${r}:${c}`)) { if (pending.has(`${r}:${c}`)) { cells[c] = pending.get(`${r}:${c}`)!; pending.delete(`${r}:${c}`); } c++; }
      const rows = Math.min(50, Number(/rowspan="?(\d+)/i.exec(cell[2]!)?.[1] ?? 1)), columns = Math.min(50, Number(/colspan="?(\d+)/i.exec(cell[2]!)?.[1] ?? 1));
      const text = clean(cell[3]!.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
      for (let dr = 0; dr < rows; dr++) for (let dc = 0; dc < columns; dc++) {
        if (dr === 0) cells[c + dc] = text; else pending.set(`${r + dr}:${c + dc}`, text);
      }
      c += columns;
    }
    for (const [key, text] of pending) { const [pr, pc] = key.split(':').map(Number); if (pr === r && cells[pc!] === undefined) { cells[pc!] = text; pending.delete(key); } }
  });
  const rows = grid.filter(row => row.some(cell => cell?.trim())).map(row => Array.from(row, cell => cell ?? ''));
  // Rows that only exist to hold a rowspan repeat the row above; keep one.
  return rows.length ? rows.filter((row, index) => index === 0 || row.join('|') !== rows[index - 1]!.join('|')) : undefined;
}

/** A pipe table with one column is a boxed theorem or note that layout analysis took for a table. */
function singleColumnRows(table: string): string[] | undefined {
  const rows = table.trim().split('\n').filter(line => !/^\|?[\s:|-]+\|?$/.test(line));
  if (!rows.length || rows.some(row => (row.match(/(?<!\\)\|/g) ?? []).length > 2)) return undefined;
  return rows.map(row => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').trim()).filter(Boolean);
}

export function mineruBlocks(result: MineruResult, files: Record<string, Uint8Array>): { blocks: Block[]; assets: DocumentAsset[]; pageCount: number } {
  const blocks: Block[] = [];
  const assets: DocumentAsset[] = [];
  let figures = 0, formulas = 0;
  const image = (source: string | undefined, kind: 'figure' | 'formula') => {
    const bytes = source ? files[source] : undefined;
    const extension = source?.toLowerCase().match(/\.(png|jpe?g)$/)?.[1];
    if (!bytes?.length || !extension) return undefined;
    const name = `${kind}-${kind === 'figure' ? ++figures : ++formulas}.${extension === 'png' ? 'png' : 'jpg'}`;
    assets.push({ name, bytes: Buffer.from(bytes) });
    return name;
  };
  const prose = (text: string, page: number, type: BlockType = 'paragraph') => {
    if (!text) return;
    const item = type === 'paragraph' ? LIST_ITEM.exec(text) : null;
    blocks.push(item ? { type: 'list', marker: item[1], text: text.slice(item[0].length), page } : { type, text, page });
  };
  // Prose a box held: a theorem title becomes a small heading, the statement one paragraph.
  const boxed = (lines: string[], page: number) => {
    const [first, ...rest] = lines;
    if (first && THEOREM.test(first) && rest.length) { blocks.push({ type: 'heading', text: first, level: 4, page }); prose(rest.join(' '), page); }
    else prose(lines.join(' '), page);
  };
  let lastProse: Block | undefined, lastPage = -1;

  for (const page of result.pages) {
    const number = page.page_idx + 1;
    for (const raw of page.blocks) {
      if (DROPPED.has(raw.type)) continue;
      const text = clean(raw.content ?? '');
      const captions = (raw.captions ?? []).map(caption => clean(caption.content ?? '')).filter(Boolean);
      const notes = (raw.footnotes ?? []).map(note => clean(note.content ?? '')).filter(Boolean);
      const before = blocks.length;
      switch (raw.type) {
        case 'doc_title': case 'title':
          blocks.push({ type: 'heading', text, level: 1, page: number }); break;
        case 'paragraph_title':
          blocks.push({ type: 'heading', text, level: Math.min(4, Math.max(2, raw.level ?? 2)), page: number }); break;
        case 'equation': case 'interline_equation': {
          const asset = image(raw.image_source, 'formula');
          // LaTeX renders; the crop stays for an agent to check or repair it.
          const latex = (raw.content ?? '').replace(/&(lt|gt|amp);/g, (_m, name: string) => ENTITIES[name]!).trim();
          if (latex || asset) blocks.push({ type: 'formula', text: latex, page: number, ...(asset ? { asset } : {}) });
          break;
        }
        case 'image': case 'chart': {
          const asset = image(raw.image_source, 'figure');
          if (asset) blocks.push({ type: 'figure', text: '', asset, page: number });
          for (const caption of captions) blocks.push({ type: 'caption', text: caption, page: number });
          break;
        }
        case 'table': {
          const rows = singleColumnRows(raw.content ?? '');
          for (const caption of captions) blocks.push({ type: 'caption', text: caption, page: number });
          const html = /<table\b/i.test(raw.content ?? '') ? htmlTableRows(raw.content!) : undefined;
          if (html) blocks.push({ type: 'table', text: formatTable(html), page: number });
          else if (rows) boxed(rows.map(clean), number);
          else if (text) blocks.push({ type: 'table', text: (raw.content ?? '').split('\n').map(line => clean(line)).join('\n'), page: number });
          break;
        }
        case 'code':
          if (raw.sub_type === 'algorithm' && /[a-z]{3,}\s+[a-z]{3,}/i.test(text) && !/[;{}]\s*$/m.test(raw.content ?? '')) boxed((raw.content ?? '').split('\n').map(clean).filter(Boolean), number);
          else if (raw.content?.trim()) blocks.push({ type: 'code', text: raw.content.replace(/\s+$/, ''), page: number });
          break;
        case 'ref_text': prose(text, number, 'reference'); break;
        case 'page_footnote': case 'footnote': prose(text, number, 'footnote'); break;
        case 'list':
          for (const line of (raw.content ?? '').split('\n').map(clean).filter(Boolean)) prose(line, number);
          break;
        default: {
          // A paragraph cut by a page break continues in lower case on the next page.
          if (lastProse && lastPage === number - 1 && !SENTENCE_END.test(lastProse.text) && /^[\p{Ll}(,$]/u.test(text)) { lastProse.text = `${lastProse.text} ${text}`; lastPage = number; continue; }
          prose(text, number);
        }
      }
      for (const note of notes) blocks.push({ type: 'footnote', text: note, page: number });
      const added = blocks.slice(before);
      const tail = added.at(-1);
      if (tail && (tail.type === 'paragraph' || tail.type === 'list')) { lastProse = tail; lastPage = number; }
      else if (added.some(block => block.type !== 'footnote')) lastProse = undefined;
    }
  }
  return { blocks: blocks.filter(block => block.text.trim() || block.asset), assets, pageCount: result.metadata?.document?.page_count ?? result.pages.length };
}

/** Reads MinerU's result archive: structured blocks plus the images they reference. */
export function readMineruArchive(zip: Uint8Array) {
  const files = unzipSync(zip, { filter: file => file.name === 'structured_content.json' || (/^images\/[^/]+\.(?:png|jpe?g)$/i.test(file.name) && file.originalSize < 20_000_000) });
  const structured = files['structured_content.json'];
  if (!structured) throw new Error('MinerU returned no structured content');
  return mineruBlocks(JSON.parse(strFromU8(structured)) as MineruResult, files);
}

interface TaskFile { status: string; result_url?: string | null; error?: { message?: string } | null; upload?: { url: string } | null }
interface Task { task_id: string; status: string; files: TaskFile[]; error?: { message?: string } | null }

/**
 * Talks to a MinerU API service: `MINERU_URL` if set, otherwise one this process
 * starts from `MINERU_COMMAND` and stops on close. Only loopback addresses are used.
 */
export class MineruService {
  private child?: ChildProcess;
  private ready?: Promise<string>;
  /** `root` resolves MINERU_COMMAND; MinerU's own lock and task files live in `workDirectory`. */
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly root: string, private readonly workDirectory = root) {}

  get enabled() { return this.env.PARSER === 'mineru'; }

  /** Starts loading models early so the first import does not wait for them. */
  warm() { if (this.enabled) this.origin().catch(() => { this.ready = undefined; }); }

  private origin(): Promise<string> {
    if (this.ready) return this.ready;
    const configured = this.env.MINERU_URL?.trim();
    if (configured) {
      const url = new URL(configured);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('MINERU_URL must be a loopback http:// address');
      return (this.ready = Promise.resolve(url.origin));
    }
    const port = Number(this.env.MINERU_PORT || 8793);
    const origin = `http://127.0.0.1:${port}`;
    this.ready = (async () => {
      if (await this.healthy(origin)) return origin;
      const command = resolve(this.root, this.env.MINERU_COMMAND || '.venv-mineru/bin/mineru-kit');
      await mkdir(this.workDirectory, { recursive: true });
      const child = spawn(command, ['api-server', '--host', '127.0.0.1', '--port', String(port), '--tier', this.env.MINERU_TIER || 'standard', '--preload-models',
        '--retention-seconds', '600', '--upload-dir', join(this.workDirectory, 'uploads')], { cwd: this.workDirectory, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      const exited = new Promise<never>((_resolve, reject) => {
        child.once('error', () => reject(new Error('Cannot start MinerU. Install it (see workers/mineru/README.md) or set MINERU_COMMAND.')));
        child.once('exit', code => reject(new Error(`MinerU stopped (exit ${code}). ${stderr.split('\n').filter(Boolean).at(-1) ?? ''}`.trim())));
      });
      exited.catch(() => {});
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (await Promise.race([this.healthy(origin), exited])) return origin;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('MinerU did not start within 3 minutes');
    })();
    this.ready.catch(() => { this.ready = undefined; this.child?.kill(); this.child = undefined; });
    return this.ready;
  }

  private async healthy(origin: string) {
    try { return (await fetch(`${origin}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
  }

  private async call(origin: string, path: string, init: RequestInit, signal: AbortSignal) {
    const response = await fetch(`${origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
    if (!response.ok) throw new Error(`MinerU returned HTTP ${response.status}`);
    return response;
  }

  async parse(name: string, input: Buffer, signal: AbortSignal = AbortSignal.timeout(1_200_000)) {
    const origin = await this.origin();
    const json = { 'Content-Type': 'application/json' };
    const created = await (await this.call(origin, '/v1/tasks', { method: 'POST', headers: json,
      body: JSON.stringify({ files: [{ file_name: name.replace(/[/\\:\p{Cc}]/gu, '_') || 'document.pdf', bytes: input.length }], output_formats: ['default'], tier: this.env.MINERU_TIER || 'standard' }) }, signal)).json() as Task;
    const upload = created.files[0]?.upload?.url;
    // The upload link must stay on the same local service.
    if (!upload || new URL(upload).origin !== origin) throw new Error('MinerU returned an unexpected upload address');
    await this.call(origin, new URL(upload).pathname, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(input) }, signal);
    let task = created;
    try {
      while (!['completed', 'failed', 'canceled'].includes(task.status)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        signal.throwIfAborted();
        task = await (await this.call(origin, `/v1/tasks/${encodeURIComponent(created.task_id)}`, {}, signal)).json() as Task;
      }
    } catch (error) {
      await fetch(`${origin}/v1/tasks/${encodeURIComponent(created.task_id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
      throw error;
    }
    const file = task.files[0];
    if (task.status !== 'completed' || !file?.result_url) throw new Error(`MinerU could not read this PDF${file?.error?.message || task.error?.message ? `: ${(file?.error?.message || task.error?.message)!.slice(0, 300)}` : ''}`);
    if (new URL(file.result_url).origin !== origin) throw new Error('MinerU returned an unexpected result address');
    const archive = new Uint8Array(await (await this.call(origin, new URL(file.result_url).pathname, {}, signal)).arrayBuffer());
    return readMineruArchive(archive);
  }

  close() { this.child?.kill(); this.child = undefined; this.ready = undefined; }
}
