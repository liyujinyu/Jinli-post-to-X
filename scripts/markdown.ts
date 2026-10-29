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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * A block is one paragraph or one image, in document order. publish.ts fills the
 * body block-by-block: paragraphs become text, images become a UNIQUE PLACEHOLDER
 * token paragraph at the exact spot the image should appear. Then insertImages
 * finds each token, deletes it, and OS-pastes the image in its place — so the
 * image lands precisely where the author put it, with no text-matching guesswork.
 */
/**
 * Inline style run inside a paragraph. `text` is the visible text; the flags
 * say how to restyle that exact range in the X editor after typing.
 * - url     → make it a hyperlink (btn-link + dialog)
 * - bold    → btn-bold
 * - italic  → btn-italic
 * - code    → rendered as plain text (backticks stripped) — X Articles has no
 *             inline-code support, so we just drop the markers.
 */
export type InlineRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  url?: string;
};

export type Block =
  | { kind: 'paragraph'; text: string; runs: InlineRun[] }
  | { kind: 'heading'; level: number; text: string; token: string }
  | { kind: 'quote'; text: string; runs: InlineRun[]; token: string }
  | { kind: 'listitem'; ordered: boolean; text: string; token: string }
  | { kind: 'hr'; token: string }
  | { kind: 'table'; rows: string[][]; raw: string[]; token: string }
  | { kind: 'image'; path: string; raw: string; token: string }
  | { kind: 'code'; lang: string; text: string; token: string };

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

/** Build a unique, ASCII-only placeholder token for code block #`i` (1-based). */
export function codeToken(i: number): string {
  return `XAP-CODE-${i}-PLACEHOLDER`;
}

/** Token for heading #`i` (1-based) — typed first, styled, then text-swapped. */
export function headingToken(i: number): string {
  return `XAP-H-${i}-PLACEHOLDER`;
}

/** Token for list item #`i` (1-based). */
export function listToken(i: number): string {
  return `XAP-L-${i}-PLACEHOLDER`;
}

/** Token for quote block #`i` (1-based) — styled with the toolbar quote button. */
export function quoteToken(i: number): string {
  return `XAP-Q-${i}-PLACEHOLDER`;
}

/** Token for table #`i` (1-based) — replaced by a rendered screenshot image. */
export function tableToken(i: number): string {
  return `XAP-TBL-${i}-PLACEHOLDER`;
}

/** Token for horizontal rule #`i` (1-based) — replaced by 插入→分割线. */
export function hrToken(i: number): string {
  return `XAP-HR-${i}-PLACEHOLDER`;
}

// ---------------------------------------------------------------------------
// Inline runs (links / bold / italic / inline code)
// ---------------------------------------------------------------------------

/**
 * Split a paragraph's raw markdown into styled runs. Markers are removed from
 * the emitted text; the flags carry the styling for the editor phase.
 */
export function parseRuns(raw: string): InlineRun[] {
  const runs: InlineRun[] = [];
  // Order matters: bold before italic (so ** isn't read as two italics),
  // links and code anywhere.
  const re =
    /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (r: InlineRun) => {
    if (r.text) runs.push(r);
  };
  while ((m = re.exec(raw))) {
    if (m.index > last) push({ text: raw.slice(last, m.index) });
    if (m[1] !== undefined) push({ text: m[1], url: m[2] });
    else if (m[3] !== undefined) push({ text: m[3], bold: true });
    else if (m[4] !== undefined) push({ text: m[4], code: true });
    else if (m[5] !== undefined) push({ text: m[5], italic: true });
    last = m.index + m[0].length;
  }
  if (last < raw.length) push({ text: raw.slice(last) });
  if (runs.length === 0) runs.push({ text: raw });
  return runs;
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
    .replace(/`([^`]+)`/g, '$1') // inline code markers → plain text
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
 *   - bare Obsidian wikilink names (vault-wide filename search, like Obsidian).
 */

// Vault-wide filename index, built lazily on the first unresolved bare wikilink.
// Map<lowercased filename, absolute paths[]> — Obsidian resolves ![[name.png]]
// by unique filename anywhere in the vault, not just md dir / vault root.
let vaultIndex: Map<string, string[]> | null = null;
const VAULT_SKIP_DIRS = new Set(['.git', '.obsidian', '.claudian', '.trash', 'node_modules', '.claude']);

function buildVaultIndex(): Map<string, string[]> {
  const root = process.cwd();
  const idx = new Map<string, string[]>();
  const queue: string[] = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!VAULT_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(p);
      } else if (e.isFile()) {
        const k = e.name.toLowerCase();
        const list = idx.get(k);
        if (list) list.push(p); else idx.set(k, [p]);
      }
    }
  }
  return idx;
}

function findInVault(ref: string, mdDir: string): string | null {
  if (!vaultIndex) vaultIndex = buildVaultIndex();
  const norm = ref.replace(/\\/g, '/').toLowerCase();
  const base = norm.split('/').pop()!;
  const hits = vaultIndex.get(base);
  if (!hits || !hits.length) return null;
  if (hits.length === 1) return hits[0];
  // Ambiguous: prefer a path ending with the full ref (subpath match), then
  // one inside the markdown's own folder tree, then the alphabetically first.
  const sub = hits.find((h) => h.replace(/\\/g, '/').toLowerCase().endsWith('/' + norm));
  if (sub) return sub;
  const near = hits.find((h) => h.toLowerCase().startsWith(mdDir.toLowerCase()));
  return near ?? hits.slice().sort()[0];
}

// ---------------------------------------------------------------------------
// Remote image download (2026-10-29)
// X 上传走 Chrome 文件控件，只能吃本地文件。剪藏文章的配图常是 http(s) 外链，
// 这里在解析阶段同步下载到临时缓存目录，后续流程（cover/上传/预检）无感复用。
// ---------------------------------------------------------------------------

const REMOTE_RE = /^https?:\/\//i;

function downloadRemoteImage(url: string): string | null {
  const cacheDir = path.join(os.tmpdir(), 'jinli-x-media');
  const extMatch = url.match(/\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#]|$)/i);
  const ext = extMatch ? '.' + extMatch[1].replace(/^jpeg$/i, 'jpg') : '.png';
  const key = crypto.createHash('md5').update(url).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, key + ext);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; // 命中缓存
  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    // Windows 10+ 自带 curl.exe；-L 跟随重定向，--fail 让 HTTP 错误抛异常
    execFileSync('curl', ['-sSL', '--fail', '-o', out, url], { timeout: 60_000, stdio: 'pipe' });
  } catch {
    try { fs.unlinkSync(out); } catch {}
    return null;
  }
  return out;
}

function resolveImagePath(ref: string, mdDir: string): string | null {
  // Obsidian embeds may use an alias or display size: ![[image.png|caption]] / ![[image.png|300]].
  // The part after the first pipe is display metadata, not part of the file path.
  const cleaned = ref.trim().replace(/^["']|["']$/g, '').split('|', 1)[0].trim();
  if (!cleaned) return null;

  // 远程图片：下载到本地临时目录再交给后续上传流程（2026-10-29 修复剪藏外链图）
  if (REMOTE_RE.test(cleaned)) {
    const local = downloadRemoteImage(cleaned);
    if (local) return local;
    console.warn(`  ! 远程图片下载失败，已跳过引用检查：${cleaned.slice(0, 80)}`);
    return cleaned; // 交给 publish.ts 预检报明确的错，而不是静默丢图
  }

  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) candidates.push(cleaned);
  candidates.push(path.resolve(mdDir, cleaned));
  candidates.push(path.resolve(process.cwd(), cleaned));

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  // Bare Obsidian wikilink (![[name.png]]): search the whole vault by filename.
  const vaultHit = findInVault(cleaned, mdDir);
  if (vaultHit) return vaultHit;
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
  let headingCount = 0;
  let listCount = 0;
  let quoteCount = 0;
  let tableCount = 0;
  let hrCount = 0;

  // Quote buffering: consecutive "> " lines merge into ONE quote block
  // (matching how Obsidian renders a multi-line quote).
  let quoteBuf: string[] = [];
  const flushQuote = () => {
    if (quoteBuf.length) {
      quoteCount++;
      const text = quoteBuf.join(' ').trim();
      const runs = parseRuns(text);
      blocks.push({ kind: 'quote', text, runs, token: quoteToken(quoteCount) });
      quoteBuf = [];
    }
  };

  // Table buffering: consecutive "|...|" lines form one table. The separator
  // row (|---|---|) is dropped at flush time.
  let tableBuf: string[] = [];
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows: string[][] = [];
    for (const line of tableBuf) {
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((c, i, arr) => !(c === '' && (i === 0 || i === arr.length - 1)));
      const isSep =
        cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')));
      if (!isSep) rows.push(cells);
    }
    if (rows.length) {
      tableCount++;
      blocks.push({
        kind: 'table',
        rows,
        raw: tableBuf.slice(),
        token: tableToken(tableCount),
      });
    }
    tableBuf = [];
  };

  const flushParagraph = () => {
    const raw = pendingParagraph.trim();
    if (raw) {
      const runs = parseRuns(raw);
      blocks.push({ kind: 'paragraph', text: runs.map((r) => r.text).join(''), runs });
    }
    pendingParagraph = '';
  };

  /** Flush quote/table/paragraph buffers in document order. */
  const flushInline = () => {
    flushQuote();
    flushTable();
    flushParagraph();
  };

  // Fenced code blocks: lines between ``` fences become ONE code block with
  // newlines preserved (NOT folded into a paragraph — that would destroy the
  // formatting, which is the whole point of a code block).
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let codeCount = 0;

  for (const rawLine of bodyLines) {
    const line = rawLine;

    // Fence open/close: ``` or ```lang … ```
    const fence = line.trim().match(/^```\s*(\S*)\s*$/);
    if (fence) {
      if (!inCode) {
        flushInline();
        inCode = true;
        codeLang = fence[1] ?? '';
        codeLines = [];
      } else {
        inCode = false;
        codeCount++;
        blocks.push({
          kind: 'code',
          lang: codeLang,
          text: codeLines.join('\n'),
          token: codeToken(codeCount),
        });
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Headings: the FIRST heading in the document is dropped (it duplicates the
    // frontmatter title). Every later heading becomes a heading block — X gets
    // ## → 标题 (header-one), ### or deeper → 副标题 (header-two).
    const head = line.trim().match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      if (!sawFirstH1) {
        sawFirstH1 = true;
        flushInline();
        continue;
      }
      flushInline();
      headingCount++;
      blocks.push({
        kind: 'heading',
        level: head[1]!.length,
        text: stripInline(head[2] ?? ''),
        token: headingToken(headingCount),
      });
      continue;
    }

    // Horizontal rule: a lone --- / *** / ___ line. If a text line directly
    // precedes it (no blank line), that's setext H2 ("text" + "---") —
    // promote the pending paragraph to a heading instead of emitting an HR
    // (otherwise the divider would cut the sentence in two).
    const hr = line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/);
    if (hr) {
      flushQuote();
      flushTable();
      if (pendingParagraph.trim()) {
        headingCount++;
        blocks.push({
          kind: 'heading',
          level: 2,
          text: stripInline(pendingParagraph.trim()),
          token: headingToken(headingCount),
        });
        pendingParagraph = '';
      } else {
        hrCount++;
        blocks.push({ kind: 'hr', token: hrToken(hrCount) });
      }
      continue;
    }

    // Blockquote: "> text" lines. Consecutive lines merge into one quote
    // block (styled later with the toolbar quote button, like headings/lists).
    const qt = line.match(/^\s*>\s?(.*)$/);
    if (qt) {
      flushTable();
      flushParagraph();
      quoteBuf.push(qt[1] ?? '');
      continue;
    }

    // Table rows: lines starting with "|". Buffered until a non-table line.
    if (/^\s*\|/.test(line)) {
      flushQuote();
      flushParagraph();
      tableBuf.push(line.trim());
      continue;
    }

    // List items: each "- x" / "* x" / "1. x" line is its own block, later
    // styled with btn-ul (unordered) or btn-ol (ordered).
    const li = line.match(/^\s*(?:([-*])|(\d+\.))\s+(.*)$/);
    if (li) {
      flushInline();
      listCount++;
      blocks.push({
        kind: 'listitem',
        ordered: li[2] !== undefined,
        text: stripInline(li[3] ?? ''),
        token: listToken(listCount),
      });
      continue;
    }

    const img = matchImageToken(line);
    if (img) {
      flushInline();
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
      flushInline();
      continue;
    }

    // Accumulate the text line (join soft-wrapped lines with a space). A text
    // line directly after a quote/table line ends that quote/table.
    if (quoteBuf.length || tableBuf.length) flushInline();
    pendingParagraph += (pendingParagraph ? ' ' : '') + line.trim();
  }
  flushInline();
  // Unterminated fence (missing closing ```): keep the code, don't drop it.
  if (inCode && codeLines.length) {
    codeCount++;
    blocks.push({
      kind: 'code',
      lang: codeLang,
      text: codeLines.join('\n'),
      token: codeToken(codeCount),
    });
  }

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
