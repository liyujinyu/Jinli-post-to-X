/**
 * publish.ts — Orchestration layer (易变流程的胶水).
 *
 *   bun publish.ts <article.md> [--submit] [--port 9222] [--profile <dir>] [--chrome <path>]
 *
 * Flow (see references/workflow.md):
 *   1. ensureChrome      — connect to running instance or launch one with the profile
 *   2. createDraft       — x.com/compose/articles → Write → wait for edit/<id>
 *   3. fillTitle         — React value-setter + dispatch input
 *   4. fillBody          — focus composer + insertText per paragraph + Enter
 *   5. insertImages      — back-to-front: Selection API → insertText("\n") → OS paste
 *   6. uploadCover       — add-photos button → DOM.setFileInputFiles → apply
 *   7. publish (if --submit) — coordinate-click 发布 → dialog 发布 → wait status URL
 *
 * Every step prints a before/after snapshot (img count, URL, dialog state) so a
 * failure can be located and the step re-run. See references/troubleshooting.md.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connect, CdpClient, CdpBrowser, sleep } from './cdp.ts';
import { copyImage, paste, deleteSelection, pasteImage, sendKeys } from './os-clipboard.ts';
import { parseArticle, parseRuns, imageToken, type Block, type InlineRun } from './markdown.ts';
import { auditDraft, printReport } from './audit.ts';

/** Resolve a path relative to this script file (works on Bun and Node). */
function relPath(p: string): string {
  return fileURLToPath(new URL(p, import.meta.url));
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Args = {
  mdPath: string;
  noImages: boolean;
  pasteHtml: boolean;
  port: number;
  profileDir: string;
  chromePath?: string;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let noImages = false;
  let pasteHtml = false;
  let port = 9222;
  let profileDir = path.join(os.homedir(), '.local', 'share', 'x-browser-profile');
  let chromePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-images') noImages = true;
    else if (a === '--paste-html') pasteHtml = true;
    else if (a === '--port') port = Number(argv[++i]);
    else if (a === '--profile') profileDir = argv[++i];
    else if (a === '--chrome') chromePath = argv[++i];
    else if (a.startsWith('--')) {
      throw new Error(`Unknown option: ${a}`);
    } else positional.push(a);
  }

  if (positional.length === 0) {
    console.error('Usage: bun publish.ts <article.md> [--no-images] [--port 9222] [--profile <dir>] [--chrome <path>]');
    process.exit(1);
  }
  return { mdPath: positional[0], noImages, pasteHtml, port, profileDir, chromePath };
}

// ---------------------------------------------------------------------------
// Selectors — loaded from references/selectors.md (single source of truth).
// If the doc is missing or its JSON fence is unparseable, fall back to the
// built-in defaults below so a doc edit can never break the script silently.
// ---------------------------------------------------------------------------

const DEFAULT_SELECTORS = {
  titleInput: [
    'textarea[placeholder="添加标题"]',
    'textarea[placeholder="Add a title"]',
    'textarea[placeholder="タイトルを追加"]',
    'textarea[placeholder="제목 추가"]',
    'textarea[name="Article Title"]',
  ],
  composer: '[data-testid="composer"]',
  contentRoot: '[data-contents="true"]',
  block: '[data-block="true"]',
  contentEditable: '[contenteditable="true"]',
  emptyStateWrite: '[data-testid="empty_state_button_text"]',
  coverButton: [
    '[aria-label="添加照片或视频"]',
    '[aria-label="Add photos or video"]',
    '[aria-label="写真や動画を追加"]',
  ],
  fileInput: 'input[data-testid="fileInput"]',
  applyButton: '[data-testid="applyButton"]',
  publishText: ['发布', 'Publish', '公開', '게시'],
  composerImages: '[data-testid="composer"] img',
  // 工具栏引号（blockquote）按钮候选；aria-label 回退在 clickQuoteButton 里。
  quoteButton: ['[data-testid="btn-block-quote"]', '[data-testid="btn-quote"]'],
};

type Selectors = typeof DEFAULT_SELECTORS;

async function loadSelectors(): Promise<Selectors> {
  const doc = relPath('../references/selectors.md');
  try {
    const text = await fs.promises.readFile(doc, 'utf-8');
    const fence = text.match(/```jsonc?\n([\s\S]*?)\n```/);
    if (fence) {
      const stripped = fence[1].replace(/\/\/.*$/gm, ''); // strip // comments (jsonc)
      const parsed = JSON.parse(stripped);
      // Merge over defaults so a partial edit doesn't drop keys.
      return { ...DEFAULT_SELECTORS, ...parsed };
    }
  } catch (err) {
    console.warn(`[publish] selectors.md parse failed, using defaults: ${(err as Error).message}`);
  }
  return DEFAULT_SELECTORS;
}

// ---------------------------------------------------------------------------
// Chrome launch helpers
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES_WIN = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];
const CHROME_CANDIDATES_MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const CHROME_CANDIDATES_LINUX = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];

function findChrome(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const list =
    process.platform === 'win32'
      ? CHROME_CANDIDATES_WIN
      : process.platform === 'darwin'
        ? CHROME_CANDIDATES_MAC
        : CHROME_CANDIDATES_LINUX;
  for (const c of list) if (c && fs.existsSync(c)) return c;
  throw new Error(
    'Chrome not found. Pass --chrome <path> or add your path to CHROME_CANDIDATES.',
  );
}

async function isPortLive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChrome(
  port: number,
  profileDir: string,
  chromePath: string,
): Promise<void> {
  await mkdir(profileDir, { recursive: true });

  if (await isPortLive(port)) {
    console.log(`[ensureChrome] Reusing live Chrome on port ${port}`);
    return;
  }

  console.log(`[ensureChrome] Launching Chrome (profile=${profileDir})`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized',
    'https://x.com/compose/articles',
  ];
  if (process.platform === 'darwin') {
    const appPath = chromePath.replace(/\/Contents\/MacOS\/Google Chrome$/, '');
    spawn('open', ['-na', appPath, '--args', ...args], { stdio: 'ignore' }).unref();
  } else {
    // detached + unref: Chrome must outlive this script, and Node must not
    // wait on it (otherwise the process hangs after main() returns).
    const child = spawn(chromePath, args, { stdio: 'ignore', detached: true });
    child.unref();
  }

  // Chrome on Windows does not reliably write DevToolsActivePort; write it
  // ourselves so a later run reuses this instance (verified workaround).
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  try {
    await writeFile(portFile, `${port}\n`, 'utf-8');
  } catch {
    /* best-effort */
  }

  // Wait for the debug endpoint to come up.
  for (let i = 0; i < 60; i++) {
    if (await isPortLive(port)) {
      console.log(`[ensureChrome] Chrome is up on port ${port}`);
      return;
    }
    await sleep(500);
  }
  throw new Error(
    `Chrome did not expose debug port ${port} in time. If this is the first run, log in to X in the opened window and re-run.`,
  );
}

// ---------------------------------------------------------------------------
// DOM helpers (run inside the page via client.eval)
// ---------------------------------------------------------------------------

function jsList(arr: string[]): string {
  return JSON.stringify(arr);
}

/** JS expression body that returns true if any of the selectors matches. */
function anySelectorExpr(arr: string[], listVar = 'sels'): string {
  return `${listVar}.some((s) => !!document.querySelector(s))`;
}

/** Focus + React value-setter + input event for the title textarea. */
function titleSetterExpr(title: string, selectors: Selectors): string {
  const t = JSON.stringify(title);
  return `(() => {
    const sels = ${jsList(selectors.titleInput)};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, ${t});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  })()`;
}

/**
 * Select (highlight) the exact placeholder token text inside the composer. The
 * selection is then OS-DELETED and the image OS-pasted into the same spot, so
 * the image lands precisely where the author placed it in the markdown.
 */
function selectTokenExpr(token: string, selectors: Selectors): string {
  return `(() => {
    const composer = document.querySelector(${JSON.stringify(selectors.composer)});
    if (!composer) return { ok: false, reason: 'no-composer' };
    const root = composer.querySelector(${JSON.stringify(selectors.contentRoot)}) || composer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    const tok = ${JSON.stringify(token)};
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent || '';
      const idx = t.indexOf(tok);
      if (idx >= 0) {
        if (node.parentElement) node.parentElement.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + tok.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ce = composer.querySelector(${JSON.stringify(selectors.contentEditable)}) || composer;
        if (ce.focus) ce.focus();
        // Report whether the DOM selection actually holds the token. DraftJS
        // syncs its internal selection from selectionchange ASYNC — callers
        // must wait (and re-verify) before insertText / OS-paste, or the edit
        // lands at a stale internal position and corrupts the document.
        const held = sel.toString() === tok;
        return { ok: true, held };
      }
    }
    return { ok: false, reason: 'token-not-found' };
  })()`;
}

/**
 * Select a token and CONFIRM the DOM selection holds it before any edit.
 * Retries (select → focus → wait) because DraftJS consumes selectionchange
 * asynchronously; editing before the sync is what corrupts blocks.
 */
async function selectTokenVerified(
  client: CdpClient,
  token: string,
  selectors: Selectors,
  tries = 4,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await client.eval<{ ok: boolean; held?: boolean; reason?: string }>(
      selectTokenExpr(token, selectors),
    );
    if (r?.ok && r.held) {
      await sleep(350); // let selectionchange propagate to DraftJS
      const still = await client.eval<string>('window.getSelection().toString()');
      if (still === token) return true;
    }
    await sleep(300);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Snapshot / debug
// ---------------------------------------------------------------------------

async function snapshot(client: CdpClient, selectors: Selectors, label: string): Promise<void> {
  const state = await client.eval<{ url: string; imgs: number; title: string }>(
    `(() => ({
       url: location.href,
       imgs: document.querySelectorAll(${JSON.stringify(selectors.composerImages)}).length,
       title: (() => {
         const sels = ${jsList(selectors.titleInput)};
         for (const s of sels) {
           const el = document.querySelector(s);
           if (el) return el.value ? 'set' : 'empty';
         }
         return 'missing';
       })(),
     }))()`,
  ).catch(() => ({ url: 'eval-failed', imgs: -1, title: '?' }));
  console.log(`[${label}] url=${state.url} imgs=${state.imgs} title=${state.title}`);
}

// ---------------------------------------------------------------------------
// Selection hygiene (the bold-deletion bug fix)
// ---------------------------------------------------------------------------

/**
 * Collapse the DOM selection to its end. CRITICAL after any toolbar action:
 * a held selection makes the next CDP Input.insertText / Enter keypress
 * DELETE the selected text (browser input replaces the active selection).
 */
async function collapseSelection(client: CdpClient): Promise<void> {
  await client.eval(
    `(() => { const s = window.getSelection();
       if (s && s.rangeCount && !s.isCollapsed) {
         const r = s.getRangeAt(0); r.collapse(false);
         s.removeAllRanges(); s.addRange(r);
       } return true; })()`,
  ).catch(() => {});
}

/**
 * Place a COLLAPSED caret at the very END of the block whose textContent
 * equals `blockText`. CRITICAL before the caller's Enter: after styling an
 * inline run the caret sits at the END OF THE RUN (mid-paragraph) — pressing
 * Enter there SPLITS the paragraph right after the bold text (the reported
 * "黑体字后边断了" bug). The caret must return to the block end first.
 */
async function caretToEndOfBlock(
  client: CdpClient,
  blockText: string,
  selectors: Selectors,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await client.eval<boolean>(
      `(() => {
        const composer = document.querySelector(${JSON.stringify(selectors.composer)});
        if (!composer) return false;
        const blocks = [...composer.querySelectorAll(${JSON.stringify(selectors.block)})];
        const full = ${JSON.stringify(blockText)};
        let b = blocks.find(x => (x.textContent || '') === full);
        if (!b && full.length > 15) b = blocks.find(x => (x.textContent || '').startsWith(full.slice(0, 15)));
        if (!b) return false;
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let last = null, n;
        while ((n = walker.nextNode())) last = n;
        if (!last) return false;
        const rg = document.createRange();
        rg.setStart(last, (last.textContent || '').length);
        rg.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges(); s.addRange(rg);
        const ce = b.closest(${JSON.stringify(selectors.contentEditable)}) || composer;
        if (ce && ce.focus) ce.focus();
        return s.toString() === '';
      })()`,
    ).catch(() => false);
    if (ok) {
      await sleep(350); // DraftJS syncs its internal selection from selectionchange async
      const still = await client.eval<string>('window.getSelection().toString()').catch(() => 'x');
      if (still === '') return true;
    }
    await sleep(300);
  }
  return false;
}

/** Toolbar bold/italic click with aria-label fallback (testid may change). */
async function clickToolbarInline(
  client: CdpClient,
  r: { bold?: boolean; italic?: boolean },
): Promise<void> {
  const tid = r.bold ? 'btn-bold' : 'btn-italic';
  let ok = await client.eval<boolean>(
    `(() => { const b = document.querySelector('[data-testid="${tid}"]');
       if (b && b.offsetParent !== null) { b.click(); return true } return false })()`,
  );
  if (!ok) {
    const labelRe = r.bold ? '加粗|粗体|bold|太字' : '斜体|italic|斜体';
    ok = await client.eval<boolean>(
      `(() => { const re = new RegExp(${JSON.stringify(labelRe)}, 'i');
         const b = [...document.querySelectorAll('button[aria-label]')]
           .find(x => re.test(x.getAttribute('aria-label') || '') && x.offsetParent !== null);
         if (b) { b.click(); return true } return false })()`,
    );
  }
}

/** Toolbar quote (blockquote) button: selector list, then aria-label fallback. */
async function clickQuoteButton(client: CdpClient, selectors: Selectors): Promise<boolean> {
  for (const sel of selectors.quoteButton) {
    const ok = await client.eval<boolean>(
      `(() => { const b = document.querySelector(${JSON.stringify(sel)});
         if (b && b.offsetParent !== null) { b.click(); return true } return false })()`,
    );
    if (ok) return true;
  }
  return client.eval<boolean>(
    `(() => { const re = /引用|引用文|blockquote|quote/i;
       const b = [...document.querySelectorAll('button[aria-label]')]
         .find(x => re.test(x.getAttribute('aria-label') || '') && x.offsetParent !== null);
       if (b) { b.click(); return true } return false })()`,
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function createDraft(client: CdpClient, selectors: Selectors): Promise<void> {
  console.log('\n=== createDraft ===');
  const titlePresent = `(()=>{ const sels=${jsList(selectors.titleInput)}; return ${anySelectorExpr(selectors.titleInput)}; })()`;
  const currentUrl = await client.eval<string>('location.href').catch(() => '');
  if (/\/compose\/articles\/edit\//.test(currentUrl)) {
    console.log(`[createDraft] Recovering existing edit page: ${currentUrl}`);
    if (!(await client.waitFor(titlePresent, 15_000).catch(() => false))) {
      await client.navigate(currentUrl);
    }
    if (await client.waitFor(titlePresent, 90_000).catch(() => false)) {
      console.log('[createDraft] Existing editor recovered');
      await snapshot(client, selectors, 'createDraft:after');
      return;
    }
    console.warn('[createDraft] Existing edit page did not mount; returning to article list');
  }

  await client.navigate('https://x.com/compose/articles');
  await sleep(3000);

  // Already in the editor? (e.g. direct nav to an edit URL)
  if (await client.waitFor(titlePresent, 3000).catch(() => false)) {
    console.log('[createDraft] Editor already open');
    await snapshot(client, selectors, 'createDraft:after');
    return;
  }

  // Find the "Write" button. JS native .click() — CDP coordinate clicks were
  // systematically unreliable here (missed the button entirely). Try testid,
  // then visible text, then any link to a fresh compose URL.
  let clicked = await client.eval<boolean>(
    `(() => { const b = document.querySelector(${JSON.stringify(selectors.emptyStateWrite)}); if (b) { b.click(); return true } return false })()`,
  );
  if (clicked) console.log('[createDraft] Clicked Write by testid (JS)');
  if (!clicked) {
    clicked = await client.eval<boolean>(
      `(() => { const b = [...document.querySelectorAll('button, a')].find(x => ['撰写','Write','写文章','寫文章','記事を書く'].includes((x.innerText || '').trim())); if (b) { b.click(); return true } return false })()`,
    );
    if (clicked) console.log('[createDraft] Clicked Write by text (JS)');
  }
  if (!clicked) {
    // Last resort: an anchor that starts a new article.
    clicked = await client.eval<boolean>(
      `(() => { const a=[...document.querySelectorAll('a')].find(e=>/\\/compose\\/articles(\\?|$)/.test(e.getAttribute('href')||'')); if(a){a.click();return true} return false })()`,
    );
    if (clicked) console.log('[createDraft] Clicked article compose link');
  }
  if (!clicked) {
    const diag = await client.eval<{ url: string; title: string; text: string; controls: string[] }>(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
      controls: [...document.querySelectorAll('button, a')]
        .filter(x => x.offsetParent !== null)
        .map(x => [x.tagName, x.getAttribute('data-testid') || '', x.getAttribute('aria-label') || '', (x.innerText || '').trim()].join('|'))
        .filter(Boolean)
        .slice(0, 80),
    }))()`);
    console.error('[createDraft:diagnostic]', JSON.stringify(diag));
    throw new Error(
      'Could not find the Write button on x.com/compose/articles. See createDraft:diagnostic for login/page/selector details.',
    );
  }

  // Wait for the editor: URL moves to /edit/<id> AND the composer mounts.
  // (Waiting on the title textarea alone produced false negatives — the draft
  // was created but the placeholder-based selector didn't match.)
  const editorReady = await client.waitFor(
    `/compose\\/articles\\/edit\\//.test(location.href) && !!document.querySelector(${JSON.stringify(
      selectors.composer,
    )})`,
    90_000,
  );
  if (!editorReady) {
    const diag = await client.eval<{ url: string; title: string; text: string; dialogs: string[] }>(`(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(x => (x.innerText || '').replace(/\s+/g, ' ').slice(0, 500)),
    }))()`);
    console.error('[createDraft:after-click-diagnostic]', JSON.stringify(diag));
    throw new Error(
      'Editor did not open after clicking Write. See createDraft:after-click-diagnostic for login, dialog, or page state.',
    );
  }
  await snapshot(client, selectors, 'createDraft:after');
}

async function fillTitle(
  client: CdpClient,
  title: string,
  selectors: Selectors,
): Promise<void> {
  console.log('\n=== fillTitle ===');
  const ok = await client.eval<boolean>(titleSetterExpr(title, selectors));
  if (!ok) throw new Error('Title textarea not found — selectors.md titleInput may be stale');
  await sleep(300);
  await snapshot(client, selectors, 'fillTitle:after');
}

/** Count <img> in the composer (verifies an image actually got pasted). */
async function countImgs(client: CdpClient, selectors: Selectors): Promise<number> {
  return client.eval<number>(
    `document.querySelectorAll(${JSON.stringify(selectors.composerImages)}).length`,
  );
}

/**
 * Click near the bottom-center of the composer so the REAL browser cursor is
 * placed at the end of the content. A CDP Input.dispatchMouseEvent is a genuine
 * focus event that DraftJS honors (unlike a programmatic DOM selection, which
 * DraftJS ignores). Used before each paste (so the image lands at the caret)
 * and after each image (so the next paragraph types below it, not into the
 * caption).
 */
async function focusComposerEnd(client: CdpClient, selectors: Selectors): Promise<void> {
  const rect = await client.eval<{ ok: boolean; x: number; y: number }>(
    `(() => { const c = document.querySelector(${JSON.stringify(
      selectors.composer,
    )}); if(!c) return {ok:false,x:0,y:0}; const r = c.getBoundingClientRect(); return {ok:true, x:r.x+r.width/2, y:r.y+r.height-12}; })()`,
  );
  if (rect?.ok) await client.clickAt(rect.x, rect.y);
}

const DRAFT_ID_EXPR =
  '(()=>{const m=location.href.match(/\\/compose\\/articles\\/edit\\/(\\d+)/);return m?m[1]:null})()';

/**
 * Draft-ID continuity check. 真凶(2026-11-04 两次章节错位): X 在自动保存触发的
 * 重载后会把 /compose/articles 重定向回「最近的草稿」,装配流被打进旧草稿,新旧
 * 内容叠成交错章节。任何阶段发现当前 draft id 与创建时不一致,立即响亮中止。
 */
async function ensureDraftId(client: CdpClient, draftId: string | null): Promise<void> {
  if (!draftId) return;
  const cur = await client.eval<string>(DRAFT_ID_EXPR).catch(() => 'eval-failed');
  if (cur !== draftId) {
    throw new Error(
      `draft id 变化: 期望 ${draftId},实际 ${cur}(X 自动保存重载后重定向到了别的草稿)。已中止以防章节错位,请重跑。`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTML paste assembly (--paste-html) — the merge-safe fast path (2026-11-04).
//
// 根因复盘: 逐块 insertText 的打字会话长达 20-30 分钟,期间 X 编辑器与服务器
// 持续自动保存/恢复,多次把「上个会话的未保存内容」恢复进新草稿或中途合并,
// 造成两份文章叠写、块序交错、token 凭空消失。治本: 把整个正文构造成带
// <h1>/<ol>/<ul>/<strong> 的 HTML 写入剪贴板,按章节分块 Ctrl+V 粘贴——
// DraftJS 原生转换粘贴的富文本,全会话从 30 分钟缩到 ~2 分钟,合并窗口消失。
// ---------------------------------------------------------------------------

function runsHtml(runs: InlineRun[]): string {
  let out = '';
  for (const r of runs) {
    let t = escapeHtml(r.text);
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    out += t;
  }
  return out;
}

function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  let listBuf: Extract<Block, { kind: 'listitem' }>[] = [];
  const flushList = () => {
    if (!listBuf.length) return;
    const tag = listBuf[0]!.ordered ? 'ol' : 'ul';
    parts.push(
      `<${tag}>` + listBuf.map((b) => `<li>${runsHtml(b.runs)}</li>`).join('') + `</${tag}>`,
    );
    listBuf = [];
  };
  for (const b of blocks) {
    switch (b.kind) {
      case 'listitem':
        listBuf.push(b);
        break;
      case 'heading': {
        flushList();
        const t = b.level <= 2 ? 1 : 2;
        parts.push(`<h${t}>${escapeHtml(b.text)}</h${t}>`);
        break;
      }
      case 'quote':
        flushList();
        parts.push(`<blockquote>${runsHtml(b.runs)}</blockquote>`);
        break;
      case 'paragraph':
        flushList();
        parts.push(`<p>${runsHtml(b.runs)}</p>`);
        break;
      case 'hr':
      case 'image':
      case 'table':
        flushList();
        parts.push(`<p>${escapeHtml(b.token)}</p>`);
        break;
      case 'code':
        flushList();
        parts.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`);
        break;
    }
  }
  flushList();
  return parts.join('');
}

/** 按 H1 分块(标题跟随其后的小节),控制单次粘贴体积。 */
function chunkBlocks(blocks: Block[]): Block[][] {
  const chunks: Block[][] = [];
  let cur: Block[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading' && cur.length) {
      chunks.push(cur);
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function pasteArticleHtml(
  browser: import('./cdp.ts').CdpBrowser,
  client: CdpClient,
  blocks: Block[],
  selectors: Selectors,
  profileMarker: string,
  draftId: string | null,
): Promise<void> {
  const chunks = chunkBlocks(blocks);
  console.log(`\n=== pasteArticleHtml (${chunks.length} chunks, rich-HTML clipboard) ===`);
  await browser
    .send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    })
    .catch(() => {});

  const countBlocks = (): Promise<number> =>
    client.eval<number>(
      `document.querySelectorAll(${JSON.stringify(selectors.composer)} [data-block="true"]).length`,
    );

  for (let i = 0; i < chunks.length; i++) {
    await ensureDraftId(client, draftId);
    const chunk = chunks[i]!;
    const html = blocksToHtml(chunk);
    const plain = chunk
      .map((b) =>
        b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'quote' || b.kind === 'listitem'
          ? (b as { text: string }).text
          : ((b as { token?: string }).token ?? ''),
      )
      .join('\n');

    const res = await client.send<{ result: { value?: unknown } }>('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const item = new ClipboardItem({
            'text/html': new Blob([${JSON.stringify(html)},], { type: 'text/html' }),
            'text/plain': new Blob([${JSON.stringify(plain)},], { type: 'text/plain' }),
          });
          await navigator.clipboard.write([item]);
          return 'OK';
        } catch (e) { return 'ERR:' + ((e && e.message) || e); }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const clip = res?.result?.value;
    if (clip !== 'OK') {
      throw new Error(`pasteArticleHtml: 剪贴板写入失败 (chunk ${i + 1}): ${clip}`);
    }

    await client.bringToFront();
    await sleep(250);
    if (i === 0) {
      await focusComposerEnd(client, selectors);
      await sleep(350);
    }
    const before = await countBlocks();
    await sendKeys('^v', profileMarker);
    await sleep(1500);
    const after = await countBlocks();
    if (after <= before) {
      throw new Error(`pasteArticleHtml: chunk ${i + 1} 粘贴后块数未增长 (${before} → ${after})`);
    }
    console.log(`  chunk ${i + 1}/${chunks.length} → blocks ${before} → ${after}`);
  }
  await snapshot(client, selectors, 'pasteArticleHtml:after');
}

async function fillBody(
  client: CdpClient,
  blocks: Block[],
  selectors: Selectors,
  profileMarker: string,
  draftId: string | null,
): Promise<void> {
  const paras = blocks.filter((b) => b.kind === 'paragraph').length;
  const imgs = blocks.filter((b) => b.kind === 'image').length;
  const codes = blocks.filter((b) => b.kind === 'code').length;
  const heads = blocks.filter((b) => b.kind === 'heading').length;
  const lists = blocks.filter((b) => b.kind === 'listitem').length;
  console.log(
    `\n=== fillBody inline (${paras} paragraphs, ${heads} headings, ${lists} list items, ${imgs} images, ${codes} code blocks) ===`,
  );

  // Focus the composer first so insertText goes to the editor, not the title.
  await client.eval(
    `(()=>{ const c = document.querySelector(${JSON.stringify(
      selectors.composer,
    )}); const ce = c && (c.querySelector(${JSON.stringify(
      selectors.contentEditable,
    )}) || c); ce && ce.focus(); return !!ce; })()`,
  );
  await sleep(300);

  // Phase 1: type the WHOLE article first — paragraphs become text (links and
  // bold/italic are styled right after their paragraph is typed), headings and
  // list items become a UNIQUE placeholder token (styled + text-swapped later
  // by applyBlockStyles), image positions become a placeholder token too.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const content =
      b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'listitem'
        ? b.kind === 'paragraph'
          ? b.text
          : b.token
        : b.token;
    await client.insertText(content);
    // Dead-page guard (2026-11-04 章节错位事故): 编辑器中途自动保存/重载后继续
    // 打字,内容会落在过期光标上,把整章正文平移到错误位置。每块检查编辑器存活
    // + 草稿 id 未被重定向;每 10 块抽查最近一块文本确实落在草稿里。
    const st = await client
      .eval<{ alive: boolean; id: string | null }>(
        `(()=>({alive:!!document.querySelector(${JSON.stringify(
          selectors.composer,
        )}),id:${DRAFT_ID_EXPR}}))()`,
      )
      .catch(() => ({ alive: false, id: null }));
    if (!st.alive) {
      throw new Error(
        `fillBody: composer 于第 ${i + 1}/${blocks.length} 块消失(编辑器重载)。已中止以防内容错位,请重跑。`,
      );
    }
    if (draftId && st.id !== draftId) {
      throw new Error(
        `fillBody: 第 ${i + 1} 块时 draft id 变为 ${st.id}(期望 ${draftId},X 重定向到了别的草稿)。已中止以防章节错位,请重跑。`,
      );
    }
    if (i % 10 === 9) {
      const probe = content.replace(/\s+/g, ' ').trim().slice(-25);
      if (probe) {
        const present = await client
          .eval<boolean>(
            `((document.querySelector(${JSON.stringify(selectors.composer)})?.innerText || '').replace(/\\s+/g, ' ')).includes(${JSON.stringify(probe)})`,
          )
          .catch(() => false);
        if (!present) {
          throw new Error(
            `fillBody: 第 ${i + 1} 块文本未落在草稿中(草稿可能被旧版自动保存覆盖)。已中止以防章节错位,请重跑。`,
          );
        }
      }
    }
    await sleep(120);
    if (b.kind === 'paragraph') await applyInlineRuns(client, b, selectors);
    // NEVER press Enter / type the next block while a selection is held —
    // the browser would delete the selected (just-bolded) text.
    await collapseSelection(client);
    await sleep(150);
    if (i < blocks.length - 1) await client.pressKey(13, 'Enter', 'Enter');
    await sleep(80);
  }
  console.log(
    `  body typed (${paras} paragraphs + ${heads} heading tokens + ${lists} list tokens + ${imgs} img tokens + ${codes} code tokens)`,
  );
  await snapshot(client, selectors, 'fillBody:after');
}

/**
 * Select an exact text range inside the block whose textContent equals
 * `blockText`, then focus the contenteditable so DraftJS honors the selection
 * for toolbar actions. `prefix` + `run.text` locates the right occurrence.
 */
function selectRunExpr(
  blockText: string,
  prefix: string,
  runText: string,
  selectors: Selectors,
): string {
  return `(() => {
    const composer = document.querySelector(${JSON.stringify(selectors.composer)});
    if (!composer) return { ok: false, reason: 'no-composer' };
    const blocks = [...composer.querySelectorAll('[data-block="true"]')];
    const full = ${JSON.stringify(blockText)};
    let b = blocks.find(x => (x.textContent || '') === full);
    if (!b) b = blocks.find(x => (x.textContent || '').startsWith(full.slice(0, 25)));
    if (!b) return { ok: false, reason: 'block-not-found' };
    b.scrollIntoView({ block: 'center' });
    // Walk ALL text nodes in the block — after a link/bold is applied the
    // block contains several spans, so a single span[data-text] lookup misses.
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, null, false);
    const probe = ${JSON.stringify(prefix + runText)};
    const run = ${JSON.stringify(runText)};
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent || '';
      let idx = t.indexOf(probe);
      if (idx >= 0) idx += probe.length - run.length;
      else idx = t.indexOf(run);
      if (idx >= 0 && idx + run.length <= t.length) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + run.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const ce = b.closest('[contenteditable="true"]') || composer.querySelector(${JSON.stringify(selectors.contentEditable)});
        if (ce && ce.focus) ce.focus();
        return { ok: true, held: sel.toString() === run };
      }
    }
    return { ok: false, reason: 'run-not-found' };
  })()`;
}

/**
 * Style the link / bold / italic runs of a JUST-TYPED paragraph or quote:
 * select the exact range in the block, click the toolbar control. Links go
 * through the link dialog (two inputs + 插入 button; the display-text input is
 * the one prefilled with the selection, the other is the URL).
 *
 * ALWAYS collapses the selection on exit (success or bail) — a held selection
 * makes the caller's next Enter/insertText delete the styled text.
 */
async function applyInlineRuns(
  client: CdpClient,
  p: { text: string; runs: InlineRun[] },
  selectors: Selectors,
): Promise<void> {
  const styled = p.runs.filter((r) => r.url || r.bold || r.italic);
  if (!styled.length) return;
  let prefix = '';
  for (const r of p.runs) {
    if (r === styled[0]) break;
    prefix += r.text;
  }
  try {
  for (const r of styled) {
    // select + verify + wait for the async DraftJS selectionchange sync
    let selOk = false;
    for (let attempt = 0; attempt < 3 && !selOk; attempt++) {
      const sel = await client.eval<{ ok: boolean; held?: boolean; reason?: string }>(
        selectRunExpr(p.text, prefix, r.text, selectors),
      );
      if (sel?.ok && sel.held) {
        await sleep(350);
        if ((await client.eval<string>('window.getSelection().toString()')) === r.text) selOk = true;
      }
      if (!selOk) await sleep(300);
    }
    if (!selOk) {
      console.warn(`  ! run select failed: ${r.text.slice(0, 20)}`);
      prefix += r.text;
      continue;
    }
    if (r.url) {
      await client.eval(`document.querySelector('[data-testid="btn-link"]')?.click(); true`);
      const dialogGone = await client.waitFor(`!document.querySelector('[role="dialog"]')`, 2000).catch(() => true);
      void dialogGone;
      const opened = await client.waitFor(`!!document.querySelector('[role="dialog"] input')`, 3000);
      if (!opened) {
        console.warn(`  ! link dialog did not open for: ${r.text.slice(0, 20)}`);
        continue;
      }
      await sleep(350);
      // Identify the URL input: the display-text input is prefilled with the
      // selected text; the other one is the URL field.
      const filled = await client.eval<{ ok: boolean; urlIdx?: number }>(`(() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return { ok: false };
        const ins = [...dlg.querySelectorAll('input')];
        if (ins.length < 2) return { ok: false };
        const selText = ${JSON.stringify(r.text)};
        let urlIdx = ins.findIndex(i => i.value !== selText);
        if (urlIdx < 0) urlIdx = 1;
        const set = (el, v) => {
          const pr = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          pr.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(ins[1 - urlIdx], selText);
        set(ins[urlIdx], ${JSON.stringify(r.url)});
        return { ok: ins[urlIdx].value === ${JSON.stringify(r.url)} };
      })()`);
      if (!filled?.ok) {
        console.warn(`  ! link URL field fill not confirmed for: ${r.text.slice(0, 20)}`);
        await client.eval(`document.querySelector('[data-testid="app-bar-close"]')?.click(); true`);
        await sleep(300);
        prefix += r.text;
        continue;
      }
      await sleep(300);
      await client.eval(`(() => {
        const dlg = document.querySelector('[role="dialog"]');
        if (!dlg) return false;
        const b = [...dlg.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '插入');
        if (!b) return false;
        b.click(); return true;
      })(); true`);
      const closed = await client.waitFor(`!document.querySelector('[role="dialog"]')`, 5000).catch(() => false);
      const hrefOk = await client.eval<boolean>(
        `!!document.querySelector(${JSON.stringify(selectors.composer)} a[href=${JSON.stringify(r.url)}])`,
      ).catch(() => false);
      if (closed || hrefOk) console.log(`  ✓ link applied: ${r.text.slice(0, 25)} → ${r.url.slice(0, 40)}`);
      else console.warn(`  ! link apply unverified: ${r.text.slice(0, 25)}`);
    } else {
      await clickToolbarInline(client, r);
      await sleep(300);
      // Honest verification — check <strong>/<em> OR the computed style of the
      // run's text node (X may render inline styles with custom spans).
      const tagSel = r.bold ? 'strong, b' : 'em, i';
      const styleCheck = r.bold
        ? 'parseInt(cs.fontWeight, 10) >= 600'
        : "cs.fontStyle === 'italic'";
      const verified = await client.eval<boolean>(
        `(() => {
          const composer = document.querySelector(${JSON.stringify(selectors.composer)});
          if (!composer) return false;
          const run = ${JSON.stringify(r.text)};
          const byTag = [...composer.querySelectorAll('${tagSel}')].some(x => (x.textContent || '').includes(run));
          if (byTag) return true;
          const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            if ((n.textContent || '') === run && n.parentElement) {
              const cs = getComputedStyle(n.parentElement);
              if (${styleCheck}) return true;
            }
          }
          return false;
        })()`,
      ).catch(() => false);
      if (verified) console.log(`  ✓ ${r.bold ? 'bold' : 'italic'} applied: ${r.text.slice(0, 25)}`);
      else console.warn(`  ! ${r.bold ? 'bold' : 'italic'} UNVERIFIED: ${r.text.slice(0, 25)}`);
    }
    prefix += r.text;
  }
  } finally {
    // Selection hygiene: caret must end at the END OF THE BLOCK — a caret left
    // at the end of the styled run (mid-paragraph) makes the caller's Enter
    // SPLIT the paragraph right after the bold/italic/link text.
    const parked = await caretToEndOfBlock(client, p.text, selectors).catch(() => false);
    if (!parked) await collapseSelection(client); // last resort (may split — logged upstream)
    await sleep(200);
    // Style-inheritance kill switch (the "整段斜体/加粗连坐" bug): DraftJS derives
    // the caret's currentInlineStyle from the char before it. When a bold/italic
    // run reaches the END of the block (italic captions, whole-line bold), the
    // parked caret keeps that style live — Enter + typing would style the NEXT
    // block too, cascading through the rest of the article. Ask the browser what
    // style is actually live at the block end (computed style of the LAST text
    // node — ground truth, no guesswork), then toggle it OFF with Ctrl+B/Ctrl+I
    // at the collapsed caret. If the style never applied, computed style is
    // normal and we toggle nothing (so this can never ADD a wrong style).
    const live = await client.eval<{ bold: boolean; italic: boolean } | null>(
      `(() => {
        const composer = document.querySelector(${JSON.stringify(selectors.composer)});
        if (!composer) return null;
        const blocks = [...composer.querySelectorAll('[data-block="true"]')];
        const full = ${JSON.stringify(p.text)};
        let b = blocks.find(x => (x.textContent || '') === full);
        if (!b && full.length > 15) b = blocks.find(x => (x.textContent || '').startsWith(full.slice(0, 15)));
        if (!b) return null;
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        let last = null, n;
        while ((n = walker.nextNode())) last = n;
        if (!last || !last.parentElement) return null;
        const cs = getComputedStyle(last.parentElement);
        return { bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle === 'italic' };
      })()`,
    ).catch(() => null);
    if (live && (live.bold || live.italic)) {
      if (live.bold) {
        await client.pressCtrlKey(66, 'b', 'KeyB').catch(() => {});
        await sleep(150);
      }
      if (live.italic) {
        await client.pressCtrlKey(73, 'i', 'KeyI').catch(() => {});
        await sleep(150);
      }
      console.log(`  · killed live style at block end: ${[live.bold && 'bold', live.italic && 'italic'].filter(Boolean).join('+')}`);
    }
  }
}

/**
 * Style heading / quote / list-item token blocks: caret into the token block
 * (token still selected via selectTokenExpr), apply the block style, then swap
 * the token for the real text. Headings: ## → 标题 (header-one), ### → 副标题
 * (header-two) via the 正文 dropdown (whose button label mirrors the current
 * block type, so match any of 正文/标题/副标题). Quotes: toolbar 引号 button
 * (blockquote), then the quote's own bold/italic runs are styled too. Lists:
 * btn-ul / btn-ol.
 */
async function applyBlockStyles(
  client: CdpClient,
  blocks: Block[],
  selectors: Selectors,
  draftId: string | null,
): Promise<void> {
  type StyleTarget = Extract<Block, { kind: 'heading' | 'listitem' | 'quote' }>;
  const targets = blocks.filter(
    (b): b is StyleTarget => b.kind === 'heading' || b.kind === 'listitem' || b.kind === 'quote',
  );
  if (!targets.length) return;
  console.log(`\n=== applyBlockStyles (${targets.length} heading/quote/list blocks) ===`);
  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i]!;
    await ensureDraftId(client, draftId);
    const label = b.kind === 'heading' ? (b.level <= 2 ? '标题' : '副标题') : null;
    console.log(`- [${i + 1}] ${b.kind}${b.kind === 'heading' ? b.level : b.kind === 'quote' ? '(quote)' : b.ordered ? '(ol)' : '(ul)'}: ${b.text.slice(0, 30)}`);

    // Dead-page guard: same as insertCodeBlocks — if the editor unmounted,
    // stop cleanly instead of burning into a fatal CDP timeout.
    const composerUp = await client
      .waitFor(`!!document.querySelector(${JSON.stringify(selectors.composer)})`, 15_000)
      .catch(() => false);
    if (!composerUp) {
      console.warn(`  ! composer not present — editor likely reloaded; skipping remaining ${targets.length - i} block style(s)`);
      break;
    }

    // 1. select the token → caret inside the token block (focuses contenteditable)
    const pos = await selectTokenVerified(client, b.token, selectors);
    if (!pos) {
      console.warn(`  ! token could not be verifiably selected; skipping`);
      continue;
    }
    await sleep(200);

    // 2. apply the block style to the current block
    let styled = false;
    if (b.kind === 'quote') {
      styled = await clickQuoteButton(client, selectors);
      if (!styled) console.warn(`  ! quote button not found (check selectors.md quoteButton / aria-label)`);
    } else if (label) {
      await client.eval(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => ['正文','标题','副标题'].includes((x.innerText || '').trim()) && !x.dataset.testid);
        if (b) { b.click(); return true } return false;
      })(); true`);
      const itemVisible = await client.waitFor(
        `!![...document.querySelectorAll('[role="menuitem"]')].find(x => x.offsetParent !== null && (x.innerText || '').trim() === '${label}')`,
        3000,
      );
      if (!itemVisible) {
        console.warn(`  ! dropdown menu did not show ${label}`);
        continue;
      }
      styled = await client.eval<boolean>(`(() => {
        const it = [...document.querySelectorAll('[role="menuitem"]')].filter(e => e.offsetParent !== null).find(x => (x.innerText || '').trim() === '${label}');
        if (!it) return false;
        it.click(); return true;
      })()`);
    } else {
      styled = await client.eval<boolean>(`(() => {
        const tid = ${JSON.stringify(b.kind === 'listitem' && b.ordered ? 'btn-ol' : 'btn-ul')};
        const b = document.querySelector('[data-testid="' + tid + '"]');
        if (!b || b.offsetParent === null) return false;
        b.click(); return true;
      })()`);
    }
    await sleep(400);

    // 3. swap token → real text (block keeps its new style). Verify the
    // selection holds the token first — insertText at a stale DraftJS internal
    // position corrupts a different block.
    const sel2 = await selectTokenVerified(client, b.token, selectors);
    if (!sel2) {
      console.warn(`  ! token could not be verifiably selected before text swap; skipping`);
      continue;
    }
    await client.insertText(b.text);
    await sleep(300);

    // 3.5 quote: style its own bold/italic/link runs now that the text is in.
    if (b.kind === 'quote' && b.runs.some((r) => r.bold || r.italic || r.url)) {
      await applyInlineRuns(client, { text: b.text, runs: b.runs }, selectors);
    }

    // 3.6 listitem: 同 quote,给条目自己的链接/加粗上样式
    // (2026-11-04 用户确认:列表条目的链接必须保留为真链接)。
    if (b.kind === 'listitem' && b.runs.some((r) => r.bold || r.italic || r.url)) {
      await applyInlineRuns(client, { text: b.text, runs: b.runs }, selectors);
    }

    // 4. verify: token gone + block class changed from unstyled
    const state = await client.eval<{ gone: boolean; cls: string }>(`(() => {
      const c = document.querySelector(${JSON.stringify(selectors.composer)});
      const gone = !(c && (c.innerText || '').includes(${JSON.stringify(b.token)}));
      let cls = '';
      if (c) {
        const blk = [...c.querySelectorAll('[data-block="true"]')].find(x => (x.textContent || '').includes(${JSON.stringify(b.text.slice(0, 20))}));
        if (blk) cls = blk.className;
      }
      return { gone, cls };
    })()`);
    const good =
      state?.gone &&
      styled &&
      (b.kind === 'heading'
        ? !!state.cls && state.cls.includes('header')
        : b.kind === 'quote'
          ? true // quote class name not yet verified against live DOM — rely on styled+gone
          : state.cls !== 'longform-unstyled');
    if (good) {
      ok++;
      console.log(`  ✓ styled (${state.cls})`);
    } else {
      console.warn(`  ! verify failed (styled=${styled}, cls=${state?.cls || '?'}, gone=${state?.gone})`);
    }
  }
  console.log(`  blocks styled: ${ok}/${targets.length}`);
  await snapshot(client, selectors, 'applyBlockStyles:after');
}

/**
 * Phase 1.5: replace each code token with a REAL X code card.
 *
 * X Articles DOES have native code blocks (verified 2026-09-05, correcting the
 * earlier finding): the toolbar has a separate 「插入」 dropdown (next to the
 * 正文 dropdown) with menu items 媒体/GIF/帖子/分割线/代码/LaTeX/表格. 代码 opens
 * a dialog with input[data-testid="programming-language-input"], a code
 * <textarea>, and an 插入 button — the resulting card renders with syntax
 * highlighting and a language label.
 *
 * Verified per-block flow (ran 18/18 successfully on draft 2096095610722283520):
 *   1. COLLAPSED caret inside the token block — a held selection makes the
 *      插入 menu fail to open (verified failure mode).
 *   2. Click 插入 → menuitem 代码 → dialog appears.
 *   3. Fill the dialog textarea (stash text in window.__ct to avoid escaping)
 *      + language input → click dialog 插入. The card lands AFTER the token block.
 *   4. Remove the leftover token block: selectNodeContents + OS DELETE clears
 *      the text, then caret + OS Backspace unstyles the empty block away.
 *      (selectNode + DELETE on a whole text block does NOT work — verified.)
 */
async function insertCodeBlocks(
  client: CdpClient,
  codeBlocks: Block[],
  selectors: Selectors,
  profileMarker: string,
): Promise<void> {
  console.log(`\n=== insertCodeBlocks (${codeBlocks.length}, native code cards via 插入→代码) ===`);
  let ok = 0;
  for (let i = 0; i < codeBlocks.length; i++) {
    const cb = codeBlocks[i] as Extract<Block, { kind: 'code' }>;
    console.log(`- token[${i + 1}] ${cb.token} ← ${cb.lang || 'text'} (${cb.text.split('\n').length} lines)`);

    // Dead-page guard (2026-09-20 crash): the editor can unmount mid-run
    // (auto-save / remount) — poking a dead page produced a NOMENU→NOCOMPOSER
    // cascade and eventually a fatal CDP timeout that killed the WHOLE run.
    // If the composer won't come back within 15s, stop here and leave the
    // remaining tokens for the audit to flag, instead of crashing the run.
    const composerUp = await client
      .waitFor(`!!document.querySelector(${JSON.stringify(selectors.composer)})`, 15_000)
      .catch(() => false);
    if (!composerUp) {
      console.warn(
        `  ! composer not present — editor likely reloaded; skipping remaining ${codeBlocks.length - i} code token(s)`,
      );
      break;
    }

    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      // Step 1: collapsed caret inside the token block; stash the code text.
      const prep = await client.eval<string>(
        `(() => { try {
          const c = document.querySelector(${JSON.stringify(selectors.composer)});
          if (!c) return 'NOCOMPOSER';
          const b = [...c.querySelectorAll('[data-block="true"]')]
            .find(x => (x.innerText || '').includes(${JSON.stringify(cb.token)}));
          if (!b) return 'NOBLOCK';
          b.scrollIntoView({ block: 'center' });
          window.__jptxCode = ${JSON.stringify(cb.text)};
          window.__jptxLang = ${JSON.stringify(cb.lang || '')};
          const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          const tn = walker.nextNode();
          const rg = document.createRange();
          if (tn) { rg.setStart(tn, 0); rg.collapse(true); }
          else { rg.selectNodeContents(b); rg.collapse(true); }
          const s = window.getSelection();
          s.removeAllRanges(); s.addRange(rg);
          b.closest('[contenteditable="true"]')?.focus();
          return 'OK';
        } catch (e) { return 'ERR:' + e.message; } })()`,
      );
      if (prep !== 'OK') {
        console.warn(`  ! caret prep failed (${prep}, attempt ${attempt + 1})`);
        continue;
      }
      await sleep(450);

      // Step 2: 插入 → 代码.
      await client.eval(`(() => { const b=[...document.querySelectorAll('button')]
        .find(x => (x.innerText || '').trim() === '插入'); if (b) b.click(); })()`);
      await sleep(800);
      const menu = await client.eval<string>(`(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [role="option"]')];
        const m = items.find(x => (x.innerText || '').trim() === '代码');
        if (!m) return 'NOMENU';
        m.click(); return 'OK'; })()`);
      if (menu !== 'OK') {
        console.warn(`  ! insert menu failed (${menu}, attempt ${attempt + 1})`);
        await client.eval(`document.body.click()`).catch(() => {});
        continue;
      }

      // Step 3: wait for the dialog and fill it.
      let dlg = 'WAIT';
      for (let w = 0; w < 10 && dlg !== 'READY'; w++) {
        await sleep(300);
        dlg = await client.eval<string>(
          `document.querySelector('[role="dialog"] textarea') ? 'READY' : 'WAIT'`,
        );
      }
      if (dlg !== 'READY') {
        console.warn(`  ! code dialog never appeared (attempt ${attempt + 1})`);
        continue;
      }
      await client.eval(`(() => {
        const m = document.querySelector('[role="dialog"]');
        const ta = m.querySelector('textarea');
        const setTa = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setTa.call(ta, window.__jptxCode || '');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const li = m.querySelector('input[data-testid="programming-language-input"]');
        if (li && window.__jptxLang) {
          const setLi = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setLi.call(li, window.__jptxLang);
          li.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return 1; })()`);
      await sleep(500);
      const inserted = await client.eval<string>(`(() => {
        const m = document.querySelector('[role="dialog"]');
        if (!m) return 'NODLG';
        const b = [...m.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '插入');
        if (!b) return 'NOBTN';
        b.click(); return 'OK'; })()`);
      if (inserted !== 'OK') {
        console.warn(`  ! dialog insert failed (${inserted}, attempt ${attempt + 1})`);
        await client.eval(`(() => { const m=document.querySelector('[role="dialog"]');
          if (m) { const x=m.querySelector('[data-testid="app-bar-close"]'); if (x) x.click(); } return 1; })()`);
        continue;
      }
      await sleep(1500);

      // Step 4: clear ONLY the exact leftover token. A broad
      // selectNodeContents + OS DELETE can use DraftJS's stale internal
      // selection after the dialog closes and erase every block below it.
      const tokenSelected = await selectTokenVerified(client, cb.token, selectors, 6);
      if (tokenSelected) {
        await client.bringToFront();
        await sleep(250);
        await deleteSelection(1, profileMarker);
        await sleep(1200);
      } else {
        console.warn(`  ! exact code token selection failed; leaving token in place to protect following content`);
      }
      // Backspace the now-empty block so no stray blank line keeps block styles.
      const caret = await client.eval<string>(
        `(() => { const c = document.querySelector(${JSON.stringify(selectors.composer)});
          const b = [...c.querySelectorAll('[data-block="true"]')]
            .find(x => (x.innerText || '').includes(${JSON.stringify(cb.token)}));
          if (!b) return 'GONE';
          const rg = document.createRange(); rg.selectNodeContents(b); rg.collapse(true);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
          b.closest('[contenteditable="true"]')?.focus();
          return 'CARET'; })()`,
      );
      if (caret === 'CARET') {
        await sleep(400);
        await client.bringToFront();
        await sleep(250);
        await sendKeys('{BS}', profileMarker);
        await sleep(1300);
      }

      // Step 4.5: a single Backspace may only unstyle the emptied token block
      // without removing it — leaving a stray blank line ABOVE the code card
      // (observed on every card in the 2026-09-08 draft). Detect an empty text
      // block directly above THIS card and backspace it away, up to 3 rounds.
      const firstLineNow = cb.text.split('\n')[0]?.trim().slice(0, 25) ?? '';
      for (let r = 0; r < 3; r++) {
        const emptyAbove = await client.eval<string>(
          `(() => { try {
            const c = document.querySelector(${JSON.stringify(selectors.composer)});
            const blocks = c ? [...c.querySelectorAll('[data-block="true"]')] : [];
            const idx = blocks.findIndex(b =>
              b.querySelector('button[aria-label="编辑块"]') &&
              ${JSON.stringify(firstLineNow ? true : false)} &&
              (b.innerText || '').includes(${JSON.stringify(firstLineNow)}));
            if (idx <= 0) return 'NO';
            const prev = blocks[idx - 1];
            if ((prev.innerText || '').trim() !== '') return 'NO';
            const rg = document.createRange(); rg.selectNodeContents(prev); rg.collapse(true);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
            prev.closest('[contenteditable="true"]')?.focus();
            return 'EMPTY';
          } catch (e) { return 'ERR:' + e.message; } })()`,
        );
        if (emptyAbove !== 'EMPTY') break;
        console.log(`  · stray blank line above code card ${i + 1}, removing (round ${r + 1})`);
        await sleep(400);
        await client.bringToFront();
        await sleep(250);
        await sendKeys('{BS}', profileMarker);
        await sleep(900);
      }

      // Verify: token gone from composer AND a code card (编辑块 button)
      // containing the first code line exists.
      const firstLine = cb.text.split('\n')[0]?.trim().slice(0, 25) ?? '';
      const state = await client.eval<{ gone: boolean; card: boolean }>(
        `(() => {
          const c = document.querySelector(${JSON.stringify(selectors.composer)});
          const blocks = c ? [...c.querySelectorAll('[data-block="true"]')] : [];
          const gone = !(c && (c.innerText || '').includes(${JSON.stringify(cb.token)}));
          const card = blocks.some(b =>
            b.querySelector('button[aria-label="编辑块"]') &&
            ${JSON.stringify(firstLine ? true : false)} &&
            (b.innerText || '').includes(${JSON.stringify(firstLine)}));
          return { gone, card };
        })()`,
      );
      if (state?.gone && state.card) {
        done = true;
        console.log(`  ✓ native code card inserted`);
      } else if (attempt === 1) {
        console.warn(`  ! verify failed (gone=${state?.gone}, card=${state?.card})`);
      }
    }
    if (done) ok++;
  }
  console.log(`  code cards inserted: ${ok}/${codeBlocks.length}`);
  await snapshot(client, selectors, 'insertCodeBlocks:after');
}

/**
 * Phase 1.6: replace each HR token with a native X divider (插入 → 分割线).
 *
 * Same verified flow as code cards: COLLAPSED caret inside the token block,
 * open the 插入 dropdown, click 分割线 (inserts immediately — no dialog
 * expected), then remove the leftover token block (selectNodeContents +
 * OS DELETE + Backspace). Divider presence is verified by counting <hr>
 * elements in the composer.
 */
async function insertHrBlocks(
  client: CdpClient,
  hrBlocks: Block[],
  selectors: Selectors,
  profileMarker: string,
  draftId: string | null,
): Promise<void> {
  if (!hrBlocks.length) return;
  console.log(`\n=== insertHrBlocks (${hrBlocks.length}, 插入→分割线) ===`);
  let ok = 0;
  for (let i = 0; i < hrBlocks.length; i++) {
    const hb = hrBlocks[i] as Extract<Block, { kind: 'hr' }>;
    await ensureDraftId(client, draftId);
    console.log(`- token[${i + 1}] ${hb.token}`);

    const countHrs = async (): Promise<number> =>
      client.eval<number>(
        `document.querySelectorAll(${JSON.stringify(selectors.composer)} hr).length`,
      );

    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      // Step 1: collapsed caret inside the token block (a held selection makes
      // the 插入 menu fail to open — same verified failure mode as code cards).
      const prep = await client.eval<string>(
        `(() => { try {
          const c = document.querySelector(${JSON.stringify(selectors.composer)});
          if (!c) return 'NOCOMPOSER';
          const b = [...c.querySelectorAll(${JSON.stringify(selectors.block)})]
            .find(x => (x.innerText || '').includes(${JSON.stringify(hb.token)}));
          if (!b) return 'NOBLOCK';
          b.scrollIntoView({ block: 'center' });
          const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          const tn = walker.nextNode();
          const rg = document.createRange();
          if (tn) { rg.setStart(tn, 0); rg.collapse(true); }
          else { rg.selectNodeContents(b); rg.collapse(true); }
          const s = window.getSelection();
          s.removeAllRanges(); s.addRange(rg);
          b.closest('[contenteditable="true"]')?.focus();
          return 'OK';
        } catch (e) { return 'ERR:' + e.message; } })()`,
      );
      if (prep !== 'OK') {
        if (i === 0 && attempt === 0) {
          const diag = await client
            .eval<string>(
              `(() => { const c = document.querySelector(${JSON.stringify(selectors.composer)});
                 const blocks = c ? [...c.querySelectorAll(${JSON.stringify(selectors.block)})] : [];
                 return JSON.stringify({
                   tokenTextInComposer: (c?.innerText || '').includes('XAP-HR-'),
                   blocks: blocks.length,
                   empties: blocks.filter(b => (b.innerText || '').trim() === '').length,
                   hrs: c ? c.querySelectorAll('hr').length : -1,
                 }); })()`,
            )
            .catch(() => 'diag-failed');
          console.warn(`  ! hr 诊断: ${diag}`);
        }
        console.warn(`  ! caret prep failed (${prep}, attempt ${attempt + 1})`);
        continue;
      }
      await sleep(450);

      // Step 2: 插入 → 分割线 (multi-locale menu text fallbacks).
      const before = await countHrs();
      await client.eval(`(() => { const b=[...document.querySelectorAll('button')]
        .find(x => (x.innerText || '').trim() === '插入'); if (b) b.click(); })()`);
      await sleep(800);
      const menu = await client.eval<string>(`(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [role="option"]')];
        const m = items.find(x => ['分割线','Divider','区切り線','구분선'].includes((x.innerText || '').trim()));
        if (!m) return 'NOMENU';
        m.click(); return 'OK'; })()`);
      if (menu !== 'OK') {
        console.warn(`  ! insert menu failed (${menu}, attempt ${attempt + 1})`);
        await client.eval(`document.body.click()`).catch(() => {});
        continue;
      }
      await sleep(1000);

      // Unexpected dialog (menu shape changed)? close and bail this attempt.
      const dialogOpen = await client.eval<boolean>(`!!document.querySelector('[role="dialog"]')`);
      if (dialogOpen) {
        console.warn(`  ! 分割线 opened an unexpected dialog — closing`);
        await client.eval(`document.querySelector('[data-testid="app-bar-close"]')?.click(); true`);
        await sleep(400);
        continue;
      }

      // Step 3: remove ONLY the exact HR token. Never issue OS DELETE from an
      // unverified DOM range: DraftJS may still hold a stale selection.
      const tokenSelected = await selectTokenVerified(client, hb.token, selectors, 6);
      if (tokenSelected) {
        await client.bringToFront();
        await sleep(250);
        await deleteSelection(3, profileMarker);
        await sleep(1200);
      } else {
        console.warn(`  ! exact HR token selection failed; leaving token in place to protect following content`);
      }
      const caret = await client.eval<string>(
        `(() => { const c = document.querySelector(${JSON.stringify(selectors.composer)});
          const b = [...c.querySelectorAll(${JSON.stringify(selectors.block)})]
            .find(x => (x.innerText || '').includes(${JSON.stringify(hb.token)}));
          if (!b) return 'GONE';
          const rg = document.createRange(); rg.selectNodeContents(b); rg.collapse(true);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
          b.closest('[contenteditable="true"]')?.focus();
          return 'CARET'; })()`,
      );
      if (caret === 'CARET') {
        await sleep(400);
        await client.bringToFront();
        await sleep(250);
        await sendKeys('{BS}', profileMarker);
        await sleep(1300);
      }

      // Verify: token gone AND an <hr> appeared.
      const state = await client.eval<{ gone: boolean; hrs: number }>(
        `(() => {
          const c = document.querySelector(${JSON.stringify(selectors.composer)});
          const gone = !(c && (c.innerText || '').includes(${JSON.stringify(hb.token)}));
          return { gone, hrs: c ? c.querySelectorAll('hr').length : 0 };
        })()`,
      );
      if (state?.gone && state.hrs > before) {
        done = true;
        console.log(`  ✓ divider inserted (${before} → ${state.hrs} hr)`);
      } else if (attempt === 1) {
        console.warn(`  ! verify failed (gone=${state?.gone}, hr ${before}→${state?.hrs})`);
      }
    }
    if (done) ok++;
  }
  console.log(`  dividers inserted: ${ok}/${hrBlocks.length}`);
  await snapshot(client, selectors, 'insertHrBlocks:after');
}

/**
 * Phase 2: replace each placeholder token with its image, in document order.
 * For each token: highlight it via the Selection API (the browser then PASTES
 * OVER the current selection), load the image on the clipboard, and send a real
 * Ctrl+V. The image lands exactly where the token was. This is the empirically
 * most reliable method (verified run: 3-4/4 images at correct positions).
 */
async function insertImages(
  client: CdpClient,
  imageBlocks: Block[],
  selectors: Selectors,
  profileMarker: string,
  draftId: string | null,
): Promise<void> {
  console.log(`\n=== insertImages (${imageBlocks.length}, paste-replace tokens) ===`);
  let ok = 0;
  for (let i = 0; i < imageBlocks.length; i++) {
    const im = imageBlocks[i] as Extract<Block, { kind: 'image' }>;
    await ensureDraftId(client, draftId);
    const before = await countImgs(client, selectors);
    console.log(`- token[${i + 1}] ${im.token} ← ${path.basename(im.path)}`);

    // Highlight the token text AND verify the DOM selection holds it. A paste
    // (or its {DELETE}) at a stale DraftJS internal selection is what corrupts
    // neighbouring paragraphs — never paste unverified.
    const pos = await selectTokenVerified(client, im.token, selectors);
    if (!pos) {
      console.warn(`  ! token could not be verifiably selected — SKIPPING paste to avoid corruption`);
      continue;
    }

    // First image needs a cold-start focus priming; subsequent ones stay warm.
    await client.bringToFront();
    await sleep(i === 0 ? 600 : 250);
    // One atomic OS call: activate → {DELETE} removes the highlighted token →
    // load image → Ctrl+V pastes it into the same spot. deleteFirst=true so the
    // token is gone and the image replaces it, in one process (no focus gap, no
    // leftover placeholder text — which a separate cleanup step failed to remove).
    await pasteImage(im.path, profileMarker, true);

    const grew = `document.querySelectorAll(${JSON.stringify(selectors.composerImages)}).length > ${before}`;
    const tokenRemaining = async (): Promise<number> =>
      client.eval<number>(
        `(document.querySelector(${JSON.stringify(selectors.composer)})?.textContent||'').split(${JSON.stringify(im.token)}).length - 1`,
      );
    const verify = async () => {
      if (!(await client.waitFor(grew, 15_000, 250))) return false;
      return (await tokenRemaining()) === 0;
    };
    if (await verify()) {
      ok++;
      console.log(`  ✓ image replaced token (${before} → ${await countImgs(client, selectors)})`);
    } else {
      const after = await countImgs(client, selectors);
      const remaining = await tokenRemaining();
      if (after > before && remaining > 0) {
        // The image pasted but the token survived (the OS DELETE missed).
        // Delete the token ONLY — re-pasting would duplicate the image.
        console.warn(`  ! image pasted but token leftover — deleting token only`);
        if (await selectTokenVerified(client, im.token, selectors)) {
          await client.bringToFront();
          await sleep(250);
          await deleteSelection(2, profileMarker);
          await sleep(400);
          if ((await tokenRemaining()) === 0) {
            ok++;
            console.log(`  ✓ token removed after paste (image kept)`);
          } else {
            console.warn(`  ! token still leftover for ${path.basename(im.path)} — manual fix needed`);
          }
        } else {
          console.warn(`  ! could not re-select token for ${path.basename(im.path)} — manual fix needed`);
        }
      } else {
        // No image grew — safe to retry the full paste-replace once.
        console.warn(`  ! retrying (image missing)`);
        if (await selectTokenVerified(client, im.token, selectors)) {
          await client.bringToFront();
          await sleep(300);
          await pasteImage(im.path, profileMarker, true);
          if (await verify()) {
            ok++;
            console.log(`  ✓ image replaced token on retry`);
          } else {
            console.warn(`  ! gave up on ${path.basename(im.path)}`);
          }
        } else {
          console.warn(`  ! gave up on ${path.basename(im.path)} (token unselectable)`);
        }
      }
    }
  }
  console.log(`  images inserted: ${ok}/${imageBlocks.length}`);
  await snapshot(client, selectors, 'insertImages:after');
}

// ---------------------------------------------------------------------------
// Tables → screenshot images (markdown tables have no X-native pipeline here)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render one markdown table cell to HTML, honoring bold/italic/links. */
function inlineHtml(cell: string): string {
  let html = '';
  for (const r of parseRuns(cell)) {
    let t = escapeHtml(r.text);
    if (r.url) t = `<a href="${escapeHtml(r.url)}" style="color:#1d9bf0;text-decoration:none">${t}</a>`;
    if (r.bold) t = `<strong>${t}</strong>`;
    if (r.italic) t = `<em>${t}</em>`;
    html += t;
  }
  return html;
}

/** Standalone HTML page for one table, X-article look (≈720px body width). */
function tableHtml(rows: string[][]): string {
  const th = (c: string) =>
    `<th style="border:1px solid #cfd9de;padding:8px 12px;background:#f7f9f9;text-align:left;font-weight:700;vertical-align:top">${inlineHtml(c)}</th>`;
  const td = (c: string) =>
    `<td style="border:1px solid #cfd9de;padding:8px 12px;vertical-align:top">${inlineHtml(c)}</td>`;
  const [head, ...body] = rows;
  const headRow = head ? `<tr>${head.map(th).join('')}</tr>` : '';
  const bodyRows = body.map((r) => `<tr>${r.map(td).join('')}</tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff}
    table{border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      font-size:16px;line-height:1.5;color:#0f1419;width:max-content;max-width:720px;table-layout:auto}
  </style></head><body><table>${headRow}${bodyRows}</table></body></html>`;
}

/**
 * Render every markdown table to a PNG (HTML → separate Chrome tab →
 * Page.captureScreenshot with viewport sized to content, @2x) and REPLACE the
 * table block with a normal image block, so the already-verified image paste
 * pipeline inserts it in place. On render failure the table degrades to
 * plain-text row paragraphs (content never silently disappears).
 */
async function convertTablesToImages(
  browser: CdpBrowser,
  article: { blocks: Block[] },
  mdDir: string,
): Promise<void> {
  const tables = article.blocks
    .map((b, i) => ({ b, i }))
    .filter((x): x is { b: Extract<Block, { kind: 'table' }>; i: number } => x.b.kind === 'table');
  if (!tables.length) return;
  console.log(`\n=== convertTablesToImages (${tables.length} tables → PNG) ===`);

  let imgTotal = article.blocks.filter((b) => b.kind === 'image').length;

  for (let n = 0; n < tables.length; n++) {
    const { b, i } = tables[n]!;
    const htmlPath = path.join(mdDir, `_jptx_table_${n + 1}.html`);
    const pngPath = path.join(mdDir, `_jptx_table_${n + 1}.png`);
    let done = false;
    try {
      await writeFile(htmlPath, tableHtml(b.rows), 'utf-8');
      // Separate tab so the draft tab is never navigated away.
      const { targetId } = await browser.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      const { sessionId } = await browser.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
      );
      const t = new CdpClient(browser, sessionId);
      await t.enable();
      try {
        await t.navigate(pathToFileURL(htmlPath).href);
        await t.waitFor('!!document.querySelector("table")', 10_000);
        await sleep(400); // fonts settle
        const dim = await t.eval<{ w: number; h: number }>(
          `(() => { const e = document.documentElement;
             return { w: Math.max(e.scrollWidth, document.body.scrollWidth),
                      h: Math.max(e.scrollHeight, document.body.scrollHeight) }; })()`,
        );
        await t.send('Emulation.setDeviceMetricsOverride', {
          width: Math.ceil(dim.w),
          height: Math.ceil(dim.h),
          deviceScaleFactor: 2,
          mobile: false,
        });
        await sleep(300);
        const { data } = await t.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
        });
        await writeFile(pngPath, Buffer.from(data, 'base64'));
        done = fs.existsSync(pngPath);
      } finally {
        await browser.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    } catch (e) {
      console.warn(`  ! table ${n + 1} render failed: ${(e as Error).message}`);
    }

    if (done) {
      imgTotal++;
      article.blocks[i] = {
        kind: 'image',
        path: pngPath,
        raw: b.raw.join(' ').slice(0, 60),
        token: imageToken(imgTotal),
      };
      console.log(`  ✓ table ${n + 1} → ${path.basename(pngPath)} (${b.rows.length} rows)`);
    } else {
      // Degrade to plain-text paragraphs — never lose content silently.
      console.warn(`  ! table ${n + 1} downgraded to plain-text paragraphs`);
      const paras: Block[] = b.rows.map((row) => {
        const text = row.map((c) => parseRuns(c).map((r) => r.text).join('')).join('　|　');
        return { kind: 'paragraph', text, runs: [{ text }] } as Block;
      });
      article.blocks.splice(i, 1, ...paras);
      // spliced indices after this one shifted — recompute remaining targets.
      for (let m = n + 1; m < tables.length; m++) tables[m]!.i += paras.length - 1;
    }
  }
}


async function uploadCover(
  client: CdpClient,
  coverPath: string,
  selectors: Selectors,
): Promise<void> {
  console.log(`\n=== uploadCover ← ${path.basename(coverPath)} ===`);
  // Click the "add photos or video" button (cover-specific).
  let clicked = false;
  for (const sel of selectors.coverButton) {
    clicked = await clickSelector(client, sel);
    if (clicked) break;
  }
  if (!clicked) throw new Error('Cover button not found — selectors.md coverButton may be stale');
  await sleep(800);

  // Feed the file via the hidden file input. setFileInputFiles works for the
  // cover (no OS-level paste needed — verified). Do NOT enable
  // Page.setInterceptFilesAllowed, it suppresses the apply button.
  // Resolve the <input> as a remote object and pass its objectId straight to
  // setFileInputFiles (modern Chrome) — going through requestNode→nodeId is
  // fragile ("Could not find node with given id") under flattened sessions.
  const evalRes = await client.send<{ result: { objectId?: string } }>(
    'Runtime.evaluate',
    {
      expression: `document.querySelector(${JSON.stringify(selectors.fileInput)})`,
      returnByValue: false,
    },
  );
  const objectId = evalRes.result.objectId;
  if (!objectId) throw new Error('file input not found after clicking cover button');
  await client.send('DOM.setFileInputFiles', { files: [coverPath], objectId });
  console.log('  cover file set, waiting for apply button…');

  const applied = await client.waitFor(
    `!!document.querySelector(${JSON.stringify(selectors.applyButton)})`,
    20_000,
  );
  if (!applied) throw new Error('Apply button never appeared after cover upload');
  await sleep(400);
  await clickSelector(client, selectors.applyButton);
  await sleep(1500);
  await snapshot(client, selectors, 'uploadCover:after');
}

/** Get element center via getBoundingClientRect and dispatch a real click. */
async function clickSelector(client: CdpClient, selector: string): Promise<boolean> {
  const rect = await client.eval<{ found: boolean; x: number; y: number }>(
    `(() => { const el = document.querySelector(${JSON.stringify(
      selector,
    )}); if(!el) return {found:false,x:0,y:0}; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {found:true, x:r.x+r.width/2, y:r.y+r.height/2}; })()`,
  );
  if (!rect?.found) return false;
  await client.clickAt(rect.x, rect.y);
  return true;
}

/** Click a button identified by exact visible text (scoped to a container if given). */
async function clickTextButton(
  client: CdpClient,
  texts: string[],
  opts: { scopeSelector?: string; nth?: number } = {},
): Promise<boolean> {
  const scopeJs = opts.scopeSelector ? JSON.stringify(opts.scopeSelector) : 'null';
  const nth = opts.nth ?? -1; // -1 → last match (useful for dialog buttons rendered after)
  const expr = `(() => {
    const texts = ${jsList(texts)};
    const scope = ${scopeJs} ? document.querySelector(${scopeJs}) : document;
    if (!scope) return { found:false, x:0, y:0 };
    const btns = Array.from(scope.querySelectorAll('button, a[role="button"], div[role="button"]'))
      .filter((b) => texts.includes((b.textContent || '').trim()));
    const el = ${nth} >= 0 ? btns[${nth}] : (btns.length ? btns[btns.length - 1] : null);
    if (!el) return { found:false, x:0, y:0 };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { found:true, x:r.x+r.width/2, y:r.y+r.height/2 };
  })()`;
  const rect = await client.eval<{ found: boolean; x: number; y: number }>(expr);
  if (!rect?.found) return false;
  await client.clickAt(rect.x, rect.y);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectors = await loadSelectors();

  console.log('[parse]', args.mdPath);
  const article = parseArticle(args.mdPath);
  const codeBlocks = article.blocks.filter(
    (b): b is Block & { kind: 'code' } => b.kind === 'code',
  );
  console.log(`  title: ${article.title}`);
  console.log(`  cover: ${article.coverImage ?? '(none)'}`);
  console.log(
    `  blocks: ${article.blocks.length} (${article.blocks.filter((b) => b.kind === 'image').length} images, ${codeBlocks.length} code, ${article.blocks.filter((b) => b.kind === 'table').length} tables)`,
  );

  // Pre-flight: every image and cover must resolve to a real file. Catches
  // bad paths early with a clear message instead of failing deep in PowerShell.
  const missing: string[] = [];
  if (article.coverImage && !fs.existsSync(article.coverImage)) {
    missing.push(`cover: ${article.coverImage}`);
  }
  for (const im of article.blocks.filter((b): b is Block & { kind: 'image' } => b.kind === 'image')) {
    if (!fs.existsSync(im.path)) missing.push(`image (${im.raw}): ${im.path}`);
  }
  if (missing.length) {
    console.error('\n✗ Unresolved media (check paths / wikilinks in the markdown):');
    for (const m of missing) console.error('  - ' + m);
    throw new Error(
      `${missing.length} media file(s) not found. Paths are resolved relative to the markdown file, then the vault root.`,
    );
  }

  const chromePath = args.chromePath ? findChrome(args.chromePath) : findChrome();
  await ensureChrome(args.port, args.profileDir, chromePath);

  const { browser, client } = await connect(args.port, {
    tabUrl: /x\.com/,
    openUrl: 'https://x.com/compose/articles',
  });

  try {
    // Tables first: rendered to PNGs in a side tab, then treated as body
    // images by everything below (including the audit).
    await convertTablesToImages(browser, article, path.dirname(path.resolve(args.mdPath)));
    const imageBlocks = article.blocks.filter(
      (b): b is Block & { kind: 'image' } => b.kind === 'image',
    );

    await createDraft(client, selectors);
    // 记录本run的草稿 id——后续所有阶段用它核对,防止 X 自动保存重载后
    // 把页面重定向回「最近草稿」造成章节错位(2026-11-04 事故根因)。
    const draftId = await client.eval<string | null>(DRAFT_ID_EXPR).catch(() => null);
    console.log(`[draftId] ${draftId ?? '(unknown)'}`);
    // 新鲜草稿守卫: X 会把上个会话的未保存内容恢复进「新建」的草稿
    // (2026-11-04 双份文章叠写事故)。装配开始前草稿必须接近空白。
    const prefill = await client
      .eval<number>(
        `((document.querySelector(${JSON.stringify(selectors.composer)})?.innerText || '').trim()).length`,
      )
      .catch(() => -1);
    if (prefill < 0) throw new Error('createDraft 后找不到 composer');
    if (prefill > 20) {
      throw new Error(
        `新草稿非空(${prefill} 字符)——X 恢复了上个会话的未保存内容。已中止;请先在编辑器里清空该恢复内容(或删除该草稿)再重跑。`,
      );
    }
    await fillTitle(client, article.title, selectors);
    if (args.pasteHtml) {
      await pasteArticleHtml(
        browser,
        client,
        article.blocks,
        selectors,
        path.basename(args.profileDir),
        draftId,
      );
    } else {
      await fillBody(client, article.blocks, selectors, path.basename(args.profileDir), draftId);
    }
    if (codeBlocks.length) {
      await insertCodeBlocks(client, codeBlocks, selectors, path.basename(args.profileDir));
    }
    const hrBlocks = article.blocks.filter(
      (b): b is Block & { kind: 'hr' } => b.kind === 'hr',
    );
    if (hrBlocks.length) {
      await insertHrBlocks(client, hrBlocks, selectors, path.basename(args.profileDir), draftId);
    }
    // Headings + quotes + list items: style the token blocks, then swap in real text.
    if (!args.pasteHtml) {
      await applyBlockStyles(client, article.blocks, selectors, draftId);
    }
    if (imageBlocks.length && !args.noImages) {
      await insertImages(client, imageBlocks, selectors, path.basename(args.profileDir), draftId);
    } else if (imageBlocks.length) {
      console.log('\n[--no-images] tokens left in body; run pw-images.ts to insert them.');
    }
    if (article.coverImage) await uploadCover(client, article.coverImage, selectors);

    // ── 终审校验:草稿 DOM vs 源 markdown 逐项比对(块序/计数/token 残留/链接/标题)。
    //    任何不一致都在这里点名,不留给作者肉眼预览去发现。
    console.log('\n=== audit(终审校验)===');
    let auditPass = true;
    try {
      const report = await auditDraft(client, article, selectors.composer);
      printReport(report);
      auditPass = report.pass;
    } catch (e) {
      auditPass = false;
      console.warn('[audit] 校验执行失败(不阻断草稿):', (e as Error).message);
    }
    if (!auditPass) {
      console.log('[audit] ⚠ 存在不一致项——可在浏览器里修复后,单独复检:');
      console.log(`[audit]   bun ${relPath('audit.ts')} ${args.mdPath} <draftUrlFragment>`);
    }

    await snapshot(client, selectors, 'draft-ready');
    // Save a screenshot next to the markdown so positions can be eyeballed.
    try {
      const shot = path.resolve(path.dirname(path.resolve(args.mdPath)), '_jptx_preview.png');
      await client.screenshot(shot);
      console.log(`[preview] screenshot → ${shot}`);
    } catch (e) {
      console.warn('[preview] screenshot failed:', (e as Error).message);
    }

    // Stop here — leave the article as a DRAFT. The author publishes manually
    // (review images/cover in the editor, then click 发布 themselves).
    const draftUrl: string = await client.eval('location.href');
    console.log(`\n✓ Draft ready (NOT published): ${draftUrl}`);
    console.log('  Review in the browser, then publish manually.');
  } finally {
    browser.close();
  }
}

main().catch((err) => {
  console.error('\n✗ failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
