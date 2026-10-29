import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutBlocks, type PdfPage, type PdfTextItem } from '../src/pdf-text.ts';

const item = (str: string, x: number, y: number, size = 10): PdfTextItem => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size });
const page = (items: PdfTextItem[]): PdfPage => ({ width: 612, height: 792, items });
const lines = (texts: string[], x: number, top: number, size = 10, pitch = 12) => texts.map((text, index) => item(text, x, top - index * pitch, size));

test('headings, hyphenation, page numbers, rotated banners and cross-page paragraphs', () => {
  const first = page([
    item('A Study of Reading', 150, 720, 17),
    ...lines(['1 Introduction'], 72, 680),
    ...lines(['Large models of code are signifi-', 'cantly better with context. They', 'struggle with unseen and private'], 72, 660),
    item('9', 300, 30),
    { str: 'arXiv:2306.10998v1 [cs.LG]', transform: [0, 10, -10, 0, 20, 400], width: 200, height: 10 },
  ]);
  const second = page([...lines(['repositories, as shown below.'], 72, 720), item('10', 300, 30)]);
  const blocks = layoutBlocks([first, second]);
  assert.deepEqual(blocks.map(block => [block.type, block.level ?? null, block.text]), [
    ['heading', 1, 'A Study of Reading'],
    ['heading', 2, '1 Introduction'],
    ['paragraph', null, 'Large models of code are significantly better with context. They struggle with unseen and private repositories, as shown below.'],
  ]);
});

test('two columns read left before right, and a sentence continues into the next column', () => {
  const blocks = layoutBlocks([page([
    ...lines(['Right column starts afresh.', 'It has two lines.'], 320, 700),
    ...lines(['Left column paragraph begins', 'and is not finished at the'], 72, 700),
    ...lines(['First left paragraph.'], 72, 740),
    ...lines(['bottom, so it continues here.'], 320, 760),
  ])]);
  assert.deepEqual(blocks.map(block => block.text), [
    'First left paragraph.',
    'Left column paragraph begins and is not finished at the bottom, so it continues here.',
    'Right column starts afresh. It has two lines.',
  ]);
});

test('captions keep sub-items; lists, references and footnotes are separate blocks', () => {
  const blocks = layoutBlocks([page([
    ...lines(['Figure 1: A caption that runs', '(d) with a sub-item.'], 72, 700),
    ...lines(['• First bullet point.', '• Second bullet point.'], 72, 640, 10, 18),
    ...lines(['References'], 72, 580),
    ...lines(['[1] A. Author. A paper title.', 'Venue, 2020.', '[2] B. Author. Another one.'], 72, 560),
    item('1 https://example.com/footnote', 72, 80, 8),
  ])]);
  assert.deepEqual(blocks.map(block => [block.type, block.marker ?? null, block.text]), [
    ['caption', null, 'Figure 1: A caption that runs (d) with a sub-item.'],
    ['list', '•', 'First bullet point.'],
    ['list', '•', 'Second bullet point.'],
    ['heading', null, 'References'],
    ['reference', null, '[1] A. Author. A paper title. Venue, 2020.'],
    ['reference', null, '[2] B. Author. Another one.'],
    ['footnote', null, '1 https://example.com/footnote'],
  ]);
});
