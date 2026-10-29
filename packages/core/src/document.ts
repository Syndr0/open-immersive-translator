/** Browser-safe document helpers shared by the API, reader and agent service. */
import type { DocumentBlock, Segment } from './types.ts';

export type { BlockType, DocumentBlock } from './types.ts';

/** Figures, display formulas and code are shown as-is and never sent to a provider. */
export const isTranslatable = (block: Pick<DocumentBlock, 'type'>) => block.type !== 'code' && block.type !== 'formula' && block.type !== 'figure';

const CELL_SEPARATOR = /(?<!\\)\|/;

/** Rows of a Markdown pipe table; the header separator row is dropped. */
export function parseTable(text: string): string[][] {
  return text.trim().split('\n').map(line => line.trim())
    .filter(line => line.includes('|') && !/^\|?[\s:|-]+\|?$/.test(line))
    .map(line => line.replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(CELL_SEPARATOR).map(cell => cell.trim().replace(/\\\|/g, '|')));
}

export function formatTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map(row => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => (row[index] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`;
  return [line(rows[0] ?? []), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/** CamelCase, digits, acronyms and capitalised hyphen names: model, method and dataset names. */
const nameLike = (word: string) => /\p{Ll}\p{Lu}|\d|^\p{Lu}+-/u.test(word) || /^\p{Lu}{2,}$/u.test(word);
/**
 * A cell is translated only for its ordinary words. Numbers, symbols and names
 * read the same in every language, and a lone name gives a provider no context.
 */
const needsTranslation = (cell: string) => (cell.replace(/\$[^$]*\$/g, '').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? [])
  .some(word => /\p{L}{2,}/u.test(word) && !nameLike(word));
const cellId = (blockId: string, row: number, column: number) => `${blockId}~${row}~${column}`;

/** One provider segment per table cell, so pipes and alignment never reach the model. */
export function translationSegments(block: DocumentBlock): Segment[] {
  if (!isTranslatable(block)) return [];
  if (block.type !== 'table') return [{ id: block.id, text: block.text }];
  return parseTable(block.text).flatMap((row, r) => row.flatMap((cell, c) => needsTranslation(cell) ? [{ id: cellId(block.id, r, c), text: cell }] : []));
}

/**
 * The saved translation for a block from its segment results, or undefined while
 * any segment is missing. Untranslated table cells keep their source value.
 */
export function assembleTranslation(block: DocumentBlock, results: ReadonlyMap<string, string>): string | undefined {
  if (block.type !== 'table') return results.get(block.id);
  const segments = translationSegments(block);
  if (segments.some(segment => !results.has(segment.id))) return undefined;
  return formatTable(parseTable(block.text).map((row, r) => row.map((cell, c) => results.get(cellId(block.id, r, c)) ?? cell)));
}

export type InlinePart = { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean };

/** Splits prose into text and `$…$` / `$$…$$` math, the form parsers emit for formulas. */
export function splitMath(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    parts.push(match[1] !== undefined ? { kind: 'math', value: match[1].trim(), display: true } : { kind: 'math', value: match[2]!, display: false });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

/** Title and abstract give the model the paper's subject and terminology. */
export function documentContext(blocks: DocumentBlock[], name: string, maximum = 1500): string {
  const prose = blocks.filter(block => isTranslatable(block) && block.type !== 'table');
  const title = prose.find(block => block.type === 'heading')?.text ?? name;
  const marker = prose.findIndex(block => /^abstract\b/i.test(block.text.trim()));
  const abstractBlock = marker < 0 ? prose.find(block => block.type === 'paragraph' && block.text.length > 300)
    : /^abstract\W*$/i.test(prose[marker]!.text.trim()) ? prose.slice(marker + 1).find(block => block.type === 'paragraph') : prose[marker];
  const abstract = abstractBlock?.text.replace(/^abstract\W*/i, '').replace(/\s+/g, ' ').trim();
  return `Title: ${title.replace(/\s+/g, ' ').trim()}${abstract ? `\nAbstract: ${abstract}` : ''}`.slice(0, maximum);
}
