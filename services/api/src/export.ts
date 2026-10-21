import type { DocumentBlock } from '@oit/core';
import type { DocumentRecord } from './store.ts';

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

function tableHtml(text: string) {
  const rows = text.split('\n').filter(line => line.trim() && !/^\s*\|?\s*:?-[-:|\s]+$/.test(line));
  return `<table>${rows.map((line, index) => `<tr>${line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => `<${index ? 'td' : 'th'}>${escapeHtml(cell.trim())}</${index ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
}

function blockHtml(block: DocumentBlock, text: string) {
  if (block.type === 'code') return `<pre><code>${escapeHtml(text)}</code></pre>`;
  if (block.type === 'table') return tableHtml(text);
  if (block.type === 'heading') { const level = Math.max(1, Math.min(6, block.level || 2)); return `<h${level}>${escapeHtml(text)}</h${level}>`; }
  return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

export function exportDocument(record: DocumentRecord, language: string, format: string, mode: string) {
  const translation = record.translations[language];
  const bilingual = mode !== 'translated';
  if (format === 'md') {
    return `# ${record.document.name}\n\n` + record.document.blocks.map(block => {
      const source = block.type === 'heading' ? `${'#'.repeat(block.level || 2)} ${block.text}` : block.type === 'code' ? `\`\`\`\n${block.text}\n\`\`\`` : block.text;
      const target = translation?.units[block.id];
      return block.type === 'code' ? source : bilingual ? `${source}${target ? `\n\n${target}` : '\n\n[Untranslated source]'}` : target ?? `${source}\n\n[Untranslated source]`;
    }).join('\n\n');
  }
  return `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(record.document.name)}</title><style>
  body{font:17px/1.65 system-ui,sans-serif;color:#1b1b1b;max-width:900px;margin:40px auto;padding:0 28px}h1,h2,h3{line-height:1.25;break-after:avoid}.translation{color:#333333;background:#f5f5f5;border-left:3px solid #b31b1b;padding:1px 18px;margin:12px 0 26px}.source{color:#262626}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f3f3;padding:16px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #cccccc;padding:8px;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}p{orphans:3;widows:3;overflow-wrap:anywhere}.note{font-size:13px;color:#666666}@page{margin:18mm}@media print{body{max-width:none;margin:0;padding:0}.translation{background:none}a{color:inherit}}
  </style></head><body><p class="note">Open Immersive Translator · ${escapeHtml(language)} · ${bilingual ? 'Bilingual' : 'Translated'} · Reflowed export</p>${record.document.blocks.map(block => {
    const target = translation?.units[block.id];
    if (block.type === 'code') return blockHtml(block, block.text);
    return `${bilingual || !target ? `<section class="source">${blockHtml(block, block.text)}</section>` : ''}${target ? `<section class="translation" dir="auto">${blockHtml(block, target)}</section>` : '<p class="note">Untranslated source</p>'}`;
  }).join('\n')}</body></html>`;
}
