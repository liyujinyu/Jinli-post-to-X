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
