import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleTranslation, documentContext, formatTable, isTranslatable, parseTable, splitMath, translationSegments, type DocumentBlock } from '../src/index.ts';

const table: DocumentBlock = { id: 't', type: 'table', text: formatTable([['Model', 'Size (#params)', 'Success Rate (%)'], ['CodeGen | multi', '16B', '50.20 ± 0.12'], ['prior only', '2B', '$N = 4$']]) };

test('tables round-trip escaped pipes and translate only cells with words', () => {
  assert.deepEqual(parseTable(table.text), [['Model', 'Size (#params)', 'Success Rate (%)'], ['CodeGen | multi', '16B', '50.20 ± 0.12'], ['prior only', '2B', '$N = 4$']]);
  assert.deepEqual(translationSegments(table).map(segment => segment.text), ['Model', 'Size (#params)', 'Success Rate (%)', 'CodeGen | multi', 'prior only']);
  const results = new Map(translationSegments(table).map(segment => [segment.id, `[${segment.text}]`]));
  assert.deepEqual(parseTable(assembleTranslation(table, results)!), [['[Model]', '[Size (#params)]', '[Success Rate (%)]'], ['[CodeGen | multi]', '16B', '50.20 ± 0.12'], ['[prior only]', '2B', '$N = 4$']]);
  results.delete(translationSegments(table)[0]!.id);
  assert.equal(assembleTranslation(table, results), undefined, 'a table is saved only when every cell succeeded');
});

test('table cells holding only names, numbers or math are not translated', () => {
  const names: DocumentBlock = { id: 'n', type: 'table', text: formatTable([
    ['Model', 'Context type', 'Success Rate (%)'],
    ['SantaCoder', 'prior', '39.51 ± 0.12'],
    ['CodeT5-base (FT)', 'post+prior', '0.22B'],
    ['NT-Prior-Last', 'StarCoderBase', 'RepoFusion (N = 4, l = 512)'],
    ['Pretrained', 'without Surrounding Context', 'BM25'],
  ]) };
  assert.deepEqual(translationSegments(names).map(segment => segment.text), ['Model', 'Context type', 'Success Rate (%)', 'prior', 'post+prior', 'Pretrained', 'without Surrounding Context']);
});

test('figures, formulas and code are never sent for translation', () => {
  for (const type of ['figure', 'formula', 'code'] as const) {
    assert.equal(isTranslatable({ type }), false);
    assert.deepEqual(translationSegments({ id: 'x', type, text: 'E = mc^2' }), []);
  }
  assert.deepEqual(translationSegments({ id: 'p', type: 'reference', text: '[1] A. Author. A title.' }), [{ id: 'p', text: '[1] A. Author. A title.' }]);
});

test('inline and display math are split from prose, prices are not', () => {
  assert.deepEqual(splitMath('Let $k = \\lceil L/l \\rceil$ and $$\\sum_i x_i$$ cost $5 or $10.'), [
    { kind: 'text', value: 'Let ' }, { kind: 'math', value: 'k = \\lceil L/l \\rceil', display: false },
    { kind: 'text', value: ' and ' }, { kind: 'math', value: '\\sum_i x_i', display: true }, { kind: 'text', value: ' cost $5 or $10.' },
  ]);
});

test('document context carries the title and abstract only', () => {
  const blocks: DocumentBlock[] = [
    { id: '1', type: 'heading', text: 'RepoFusion: Training Code Models', level: 1 },
    { id: '2', type: 'paragraph', text: 'Authors and affiliations' },
    { id: '3', type: 'heading', text: 'Abstract', level: 2 },
    { id: '4', type: 'paragraph', text: 'We propose   RepoFusion.' },
    { id: '5', type: 'paragraph', text: 'Body text.' },
  ];
  assert.equal(documentContext(blocks, 'paper.pdf'), 'Title: RepoFusion: Training Code Models\nAbstract: We propose RepoFusion.');
  assert.equal(documentContext([], 'notes.md'), 'Title: notes.md');
});
