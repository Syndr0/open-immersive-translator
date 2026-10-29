import type { DocumentBlock } from '@oit/core';

/** The subset of a PDF.js text item this layout pass reads. */
export interface PdfTextItem { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean }
export interface PdfPage { width: number; height: number; items: PdfTextItem[] }

interface Fragment { page: number; x0: number; x1: number; y: number; size: number; text: string; column: 'full' | 'left' | 'right' }
type Block = Omit<DocumentBlock, 'id'>;

const SENTENCE_END = /[.!?:;。！？：；)\]]["'”’]?$/;
const CAPTION = /^(?:Figure|Fig\.|Table|Algorithm)\s*[A-Z]?\d+(?:\.\d+)?\s*[:.|]/i;
const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*\.?|[A-Z](?:\.\d+)+|[IVX]+\.)\s+\p{Lu}/u;
const NAMED_HEADING = /^(?:Abstract|Introduction|Related Work|Background|Method(?:s|ology)?|Experiments?|Results|Discussion|Conclusions?|Limitations|Acknowledge?ments?|References|Bibliography|Appendix(?:\s+[A-Z])?)\s*$/i;
const BULLET = /^([•◦▪‣∙·\-–—*])\s+/;
const ENUMERATED = /^(\(?(?:\d{1,2}|[a-z]|[ivx]{1,4})[.)])\s+/;
const REFERENCE_START = /^\[\d{1,3}\]\s/;
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };

/** Lines of upright text, split at wide gaps so two columns never merge. */
function fragments(pages: PdfPage[]): Fragment[] {
  const output: Fragment[] = [];
  pages.forEach((page, index) => {
    const items = page.items.filter(item => item.str.trim() && Math.abs(item.transform[1]!) < 0.01 * Math.abs(item.transform[0]!) && Math.abs(item.transform[2]!) < 0.01 * Math.abs(item.transform[3]!))
      .map(item => ({ x: item.transform[4]!, y: item.transform[5]!, size: Math.abs(item.transform[3]!) || item.height, width: item.width, text: item.str }));
    const rows: typeof items[] = [];
    for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
      // Superscripts sit a little higher than their line; tolerate half a line.
      const row = rows.find(candidate => Math.abs(candidate[0]!.y - item.y) < Math.max(candidate[0]!.size, item.size) * 0.5);
      if (row) row.push(item); else rows.push([item]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let current: Fragment | undefined;
      for (const item of row) {
        const size = Math.max(...row.map(entry => entry.size));
        if (current && item.x - current.x1 < size * 2.5) {
          const gap = item.x - current.x1;
          current.text += gap > size * 0.15 && !/\s$/.test(current.text) && !/^\s/.test(item.text) ? ` ${item.text}` : item.text;
          current.x1 = Math.max(current.x1, item.x + item.width);
          current.size = Math.max(current.size, item.size);
        } else {
          current = { page: index + 1, x0: item.x, x1: item.x + item.width, y: item.y, size: item.size, text: item.text, column: 'full' };
          output.push(current);
        }
      }
    }
  });
  for (const fragment of output) {
    const width = pages[fragment.page - 1]!.width;
    fragment.text = fragment.text.replace(/\s+/g, ' ').trim();
    fragment.column = fragment.x1 <= width * 0.53 ? 'left' : fragment.x0 >= width * 0.47 ? 'right' : 'full';
  }
  return output;
}

/** Full-width lines in page order; within a two-column band, the left column first. */
function readingOrder(page: Fragment[]): Fragment[] {
  const sorted = [...page].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const twoColumn = sorted.filter(item => item.column === 'right').length >= 2 && sorted.filter(item => item.column === 'left').length >= 2;
  if (!twoColumn) return sorted.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const ordered: Fragment[] = [];
  let band: Fragment[] = [];
  const flush = () => { ordered.push(...band.filter(item => item.column !== 'right'), ...band.filter(item => item.column === 'right')); band = []; };
  for (const item of sorted) {
    if (item.column === 'full') { flush(); ordered.push(item); } else band.push(item);
  }
  flush();
  return ordered;
}

/** Text repeated at the same height on several pages is a running header or footer. */
function repeatedMargins(lines: Fragment[], pageCount: number): Set<string> {
  const counts = new Map<string, Set<number>>();
  for (const line of lines) {
    const key = `${Math.round(line.y / 4)}:${line.text.replace(/\d+/g, '#')}`;
    (counts.get(key) ?? counts.set(key, new Set()).get(key)!).add(line.page);
  }
  return new Set([...counts].filter(([, pages]) => pageCount >= 3 && pages.size >= Math.max(3, pageCount * 0.4)).map(([key]) => key));
}

function join(previous: string, next: string): string {
  if (!previous) return next;
  if (/\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(next)) return previous.slice(0, -1) + next;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(previous) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next)) return previous + next;
  return `${previous} ${next}`;
}

/**
 * Turns positioned PDF text into reading blocks: headings by size or numbering,
 * paragraphs across lines, columns and page breaks, captions, lists, footnotes
 * and one block per reference. It cannot see figures, formulas or table grids.
 */
export function layoutBlocks(pages: PdfPage[]): Block[] {
  const all = fragments(pages);
  const margins = repeatedMargins(all, pages.length);
  const body = median(all.flatMap(line => Array(Math.min(line.text.length, 200)).fill(Math.round(line.size * 2) / 2)));
  // Typical distance between consecutive body lines; a larger gap separates paragraphs.
  const pitches: number[] = [];
  for (let index = 1; index < all.length; index++) {
    const [above, below] = [all[index - 1]!, all[index]!];
    const gap = above.y - below.y;
    if (above.page === below.page && above.column === below.column && Math.abs(below.size - body) < 0.6 && gap > 0 && gap < body * 3) pitches.push(gap);
  }
  const pitch = median(pitches) || body * 1.2;
  const blocks: Block[] = [];
  let open: (Block & { last: Fragment }) | undefined;
  let inReferences = false;
  // The last body block, so a paragraph broken by a page footer or footnote can resume.
  let lastProse: (Block & { last: Fragment }) | undefined, lastProseIndex = -1;
  const close = () => {
    if (!open) return;
    const { last: _, ...block } = open;
    blocks.push({ ...block, text: block.text.trim() });
    if (['paragraph', 'list', 'reference'].includes(open.type)) { lastProse = { ...open, last: open.last }; lastProseIndex = blocks.length - 1; }
    open = undefined;
  };

  for (let page = 1; page <= pages.length; page++) {
    const height = pages[page - 1]!.height;
    const lines = readingOrder(all.filter(line => line.page === page)).filter(line => {
      const margin = line.y > height * 0.92 || line.y < height * 0.08;
      if (margin && /^(?:\d{1,4}|[ivxl]{1,6}|Page \d+( of \d+)?)$/i.test(line.text)) return false;
      return !(margin && margins.has(`${Math.round(line.y / 4)}:${line.text.replace(/\d+/g, '#')}`));
    });
    for (const line of lines) {
      const text = line.text;
      const larger = line.size >= body * 1.12;
      const smaller = line.size <= body * 0.92;
      const heading = text.length <= 120 && !SENTENCE_END.test(text.replace(/\s*\.$/, ''))
        && (NAMED_HEADING.test(text) || (larger && text.length > 1) || (NUMBERED_HEADING.test(text) && text.length <= 80 && !/[,;]$/.test(text) && line.size >= body * 0.98));
      if (heading && !(open?.type === 'heading' && open.last.page === page && Math.abs(open.last.size - line.size) < 0.5 && open.last.y - line.y < line.size * 1.8)) {
        close();
        const numbering = /^(\d+(?:\.\d+)*)\.?\s/.exec(text)?.[1];
        const level = larger && line.size >= body * 1.5 ? 1 : numbering ? Math.min(4, numbering.split('.').length + 1) : 2;
        open = { type: 'heading', text, level, page, last: line };
        inReferences = /^(?:\d+\.?\s*)?(?:References|Bibliography)$/i.test(text);
        continue;
      }
      if (open?.type === 'heading' && heading) { open.text = join(open.text, text); open.last = line; continue; }

      const gap = open ? (open.last.page === page ? open.last.y - line.y : Infinity) : Infinity;
      // Moving up the page means a new column: an unfinished sentence carries over, anything else starts afresh.
      const columnJump = !!open && open.last.page === page && gap < -body;
      const continuesColumn = columnJump && open!.type !== 'heading' && !SENTENCE_END.test(open!.text) && /^[\p{Ll}(,]/u.test(text);
      const sameColumn = open && open.last.page === page && open.last.column === line.column;
      const indented = sameColumn && line.x0 - open!.last.x0 > body * 0.8;
      // Sub-items such as "(d) …" inside a caption stay part of it.
      const startsList = BULLET.exec(text) ?? (!inReferences && open?.type !== 'caption' ? ENUMERATED.exec(text) : null);
      const startsReference = inReferences && REFERENCE_START.test(text);
      const resumable = [open && ['paragraph', 'list', 'reference'].includes(open.type) ? open : undefined, lastProse]
        .find(candidate => candidate && candidate.last.page !== page && !SENTENCE_END.test(candidate.text));
      const continuesPage = !!resumable && (!open || open.last.page !== page) && /^[\p{Ll}(,]/u.test(text);
      if (continuesPage && resumable !== open) {
        // Reopen the interrupted block; the footer or footnote between stays before it.
        const index = lastProseIndex;
        close();
        blocks.splice(index, 1);
        open = resumable; lastProse = undefined;
      }
      const newBlock = !open || open.type === 'heading' || CAPTION.test(text) || startsList || startsReference
        || (columnJump && !continuesColumn)
        || (!continuesPage && (open.last.page !== page || gap > Math.max(pitch * 1.3, open.last.size * 1.15) || (indented && !inReferences && SENTENCE_END.test(open.text))))
        || (smaller !== (open.type === 'footnote'));
      if (newBlock && !continuesPage) {
        close();
        const type: Block['type'] = CAPTION.test(text) ? 'caption' : smaller && line.y < height * 0.25 ? 'footnote' : startsReference || inReferences ? 'reference' : startsList ? 'list' : 'paragraph';
        open = { type, text: startsList && type === 'list' ? text.slice(startsList[0].length) : text, page, last: line, ...(type === 'list' ? { marker: startsList![1] } : {}) };
      } else {
        open!.text = join(open!.text, text); open!.last = line;
      }
    }
  }
  close();
  // Page-local parts of a block too long to translate in one request.
  return blocks.flatMap(block => block.text.length <= 6000 ? [block] : block.text.match(/[^]{1,6000}(?:[.!?。！？]\s|$)/g)!.map(text => ({ ...block, text: text.trim() })));
}
