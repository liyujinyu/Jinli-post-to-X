/**
 * markdown.ts — Stable layer.
 *
 * Minimal, dependency-free parser for X Article publish-ready markdown. It does
 * NOT attempt to be a general Markdown engine — it understands exactly the
 * shape a publish-ready article takes (see SKILL.md "准备 markdown"):
 *
 *   ---
 *   title: <article title>
 *   cover_image: <optional cover path or ![[cover.png]]>
 *   ---
 *
 *   # Optional H1 (skipped — title already set above)
 *
 *   Paragraph text, **bold** allowed.
 *
 *   ![[image.png]]        ← Obsidian wikilink image, or
 *   ![](path/to/image.png)← standard image syntax
 *
 * The parser emits paragraphs (text only, markdown ** stripped) and images with
 * the text of the immediately-preceding paragraph as a location anchor. Images
 * are inserted "from back to front" later, so a stable anchor on the preceding
 * paragraph (whose block index never shifts) is what makes positioning robust.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * A block is one paragraph or one image, in document order. publish.ts fills the
 * body block-by-block: paragraphs become text, images become a UNIQUE PLACEHOLDER
 * token paragraph at the exact spot the image should appear. Then insertImages
 * finds each token, deletes it, and OS-pastes the image in its place — so the
 * image lands precisely where the author put it, with no text-matching guesswork.
 */
export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'image'; path: string; raw: string; token: string };

export type ParsedArticle = {
  title: string;
  coverImage: string | null;
  /** Ordered paragraph/image stream — the source of truth for body + image layout. */
  blocks: Block[];
};

/** Build a unique, ASCII-only placeholder token for image #`i` (1-based). */
export function imageToken(i: number): string {
  return `XAP-IMG-${i}-PLACEHOLDER`;
}

// ---------------------------------------------------------------------------
// Frontmatter (hand-written: only `title` and `cover_image` are recognized)
// ---------------------------------------------------------------------------

function parseFrontmatter(src: string): {
  title?: string;
  coverImage?: string;
  body: string;
} {
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { body: src };
  const out: { title?: string; coverImage?: string } = {};
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'title') out.title = val;
      else if (key === 'cover_image' || key === 'coverimage' || key === 'cover')
        out.coverImage = val;
    }
    i++;
  }
  const body = lines.slice(i + 1).join('\n');
  return { ...out, body };
}

// ---------------------------------------------------------------------------
// Inline cleanup
// ---------------------------------------------------------------------------

/** Strip heading markers + bold/italic markers; keep inner text. */
function stripInline(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, '') // ATX heading markers → plain text paragraph
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// Image path resolution
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Resolve an image reference to an absolute path. Accepts:
 *   - already-absolute OS paths,
 *   - paths relative to the markdown file's directory,
 *   - paths relative to the vault root (process.cwd()),
 *   - bare Obsidian wikilink names (searched from the markdown dir then cwd).
 */
function resolveImagePath(ref: string, mdDir: string): string | null {
  const cleaned = ref.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return null;

  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) candidates.push(cleaned);
  candidates.push(path.resolve(mdDir, cleaned));
  candidates.push(path.resolve(process.cwd(), cleaned));

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  // If it looks like an image name but wasn't found, still return the best
  // guess so the caller can surface a clear error rather than a silent null.
  if (IMAGE_EXT.test(cleaned)) return candidates[candidates.length - 1];
  return null;
}

// ---------------------------------------------------------------------------
// Image token detection
// ---------------------------------------------------------------------------

type ImageToken = { raw: string; ref: string } | null;

function matchImageToken(line: string): ImageToken {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Obsidian wikilink: ![[some image.png]]
  const wl = trimmed.match(/^!\[\[([^\]]+)\]\]$/);
  if (wl) return { raw: trimmed, ref: wl[1].trim() };

  // Standard markdown image: ![alt](path)
  const md = trimmed.match(/^!\[[^\]]*\]\(([^)]+)\)$/);
  if (md) return { raw: trimmed, ref: md[1].trim().replace(/^["']|["']$/g, '') };

  return null;
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

export function parseArticle(mdPath: string): ParsedArticle {
  const abs = path.resolve(mdPath);
  const src = fs.readFileSync(abs, 'utf-8');
  const mdDir = path.dirname(abs);

  const fm = parseFrontmatter(src);

  // Resolve cover image (may itself be a ![[...]] wikilink or a plain path).
  let coverImage: string | null = null;
  if (fm.coverImage) {
    const coverRef = fm.coverImage.replace(/^!\[\[|\]\]$/g, '');
    coverImage = resolveImagePath(coverRef, mdDir);
  }

  const bodyLines = fm.body.split(/\r?\n/);

  const blocks: Block[] = [];
  let pendingParagraph = '';
  let sawFirstH1 = false;
  let imageCount = 0;

  const flushParagraph = () => {
    const text = stripInline(pendingParagraph);
    if (text) blocks.push({ kind: 'paragraph', text });
    pendingParagraph = '';
  };

  for (const rawLine of bodyLines) {
    const line = rawLine;

    // Skip a single leading H1 that duplicates the title (only the FIRST
    // heading in the document is dropped; later headings become plain text
    // paragraphs with their # prefix stripped by stripInline).
    if (!sawFirstH1 && /^#{1,6}\s+/.test(line.trim())) {
      sawFirstH1 = true;
      // Flush any pending text first so order is preserved.
      flushParagraph();
      continue;
    }

    const img = matchImageToken(line);
    if (img) {
      flushParagraph();
      imageCount++;
      const resolved = resolveImagePath(img.ref, mdDir);
      blocks.push({
        kind: 'image',
        raw: img.raw,
        path: resolved ?? img.ref,
        token: imageToken(imageCount),
      });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Accumulate the text line (join soft-wrapped lines with a space).
    pendingParagraph += (pendingParagraph ? ' ' : '') + line.trim();
  }
  flushParagraph();

  const firstText = blocks.find((b) => b.kind === 'paragraph');
  const title = (fm.title ?? (firstText && firstText.text) ?? 'Untitled').trim();

  // If no explicit cover was given in frontmatter but the FIRST block is an
  // image (a common way authors write a cover — an image line above the title),
  // promote it to the cover so it's uploaded as the article cover, not pasted
  // as a body image at the very top.
  if (!coverImage && blocks.length > 0 && blocks[0].kind === 'image') {
    coverImage = blocks[0].path;
    blocks.shift();
  }

  return { title, coverImage, blocks };
}
