import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArticle } from './markdown';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Obsidian image aliases', () => {
  test('resolves cover and body image paths before the alias separator', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinli-x-wikilink-'));
    tempDirs.push(dir);
    const imagePath = path.join(dir, 'example.png');
    fs.writeFileSync(imagePath, 'image');
    const articlePath = path.join(dir, 'article.md');
    fs.writeFileSync(
      articlePath,
      [
        '---',
        'title: Alias test',
        'cover_image: "![[example.png|封面说明]]"',
        '---',
        '',
        '# Alias test',
        '',
        '![[example.png|正文图片说明]]',
      ].join('\n'),
      'utf8',
    );

    const article = parseArticle(articlePath);
    const image = article.blocks.find((block) => block.kind === 'image');

    expect(article.coverImage).toBe(imagePath);
    expect(image?.kind).toBe('image');
    if (image?.kind === 'image') expect(image.path).toBe(imagePath);
  });
});

describe('block parsing regressions', () => {
  test('keeps the first heading when it is not the article-title H1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinli-x-heading-'));
    tempDirs.push(dir);
    const articlePath = path.join(dir, 'article.md');
    fs.writeFileSync(
      articlePath,
      ['---', 'title: Article title', '---', '', '## First section', '', 'Body.'].join('\n'),
      'utf8',
    );

    const article = parseArticle(articlePath);
    expect(article.blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: 'First section' });
  });

  test('skips only a duplicate title H1 and keeps following headings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinli-x-title-heading-'));
    tempDirs.push(dir);
    const articlePath = path.join(dir, 'article.md');
    fs.writeFileSync(
      articlePath,
      ['---', 'title: Article title', '---', '', '# Article title', '', '## First section'].join('\n'),
      'utf8',
    );

    const article = parseArticle(articlePath);
    expect(article.blocks).toHaveLength(1);
    expect(article.blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: 'First section' });
  });

  test('quote text contains visible text while retaining inline style runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jinli-x-quote-'));
    tempDirs.push(dir);
    const articlePath = path.join(dir, 'article.md');
    fs.writeFileSync(articlePath, '> Quote with **bold** and *italic*.', 'utf8');

    const article = parseArticle(articlePath);
    expect(article.blocks[0]).toMatchObject({
      kind: 'quote',
      text: 'Quote with bold and italic.',
    });
    if (article.blocks[0]?.kind === 'quote') {
      expect(article.blocks[0].runs.some((run) => run.bold && run.text === 'bold')).toBe(true);
      expect(article.blocks[0].runs.some((run) => run.italic && run.text === 'italic')).toBe(true);
    }
  });
});
