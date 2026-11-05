import { describe, expect, test } from 'bun:test';
import { blocksToHtml, parseArgs } from './publish';
import type { Block } from './markdown';

describe('rich HTML assembly regressions', () => {
  test('separates adjacent unordered and ordered lists', () => {
    const blocks: Block[] = [
      { kind: 'listitem', ordered: false, text: 'A', runs: [{ text: 'A' }], token: 'XAP-L-1-PLACEHOLDER' },
      { kind: 'listitem', ordered: false, text: 'B', runs: [{ text: 'B' }], token: 'XAP-L-2-PLACEHOLDER' },
      { kind: 'listitem', ordered: true, text: 'C', runs: [{ text: 'C' }], token: 'XAP-L-3-PLACEHOLDER' },
    ];

    expect(blocksToHtml(blocks)).toBe('<ul><li>A</li><li>B</li></ul><ol><li>C</li></ol>');
  });

  test('uses rich HTML by default and keeps an explicit legacy escape hatch', () => {
    expect(parseArgs(['article.md']).pasteHtml).toBe(true);
    expect(parseArgs(['article.md', '--legacy-inline']).pasteHtml).toBe(false);
  });
});
