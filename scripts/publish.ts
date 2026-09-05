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
import { fileURLToPath } from 'node:url';

import { connect, CdpClient, sleep } from './cdp.ts';
import { copyImage, paste, deleteSelection, pasteImage, sendKeys } from './os-clipboard.ts';
import { parseArticle, type Block } from './markdown.ts';
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
  port: number;
  profileDir: string;
  chromePath?: string;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let noImages = false;
  let port = 9222;
  let profileDir = path.join(os.homedir(), '.local', 'share', 'x-browser-profile');
  let chromePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-images') noImages = true;
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
  return { mdPath: positional[0], noImages, port, profileDir, chromePath };
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
// Steps
// ---------------------------------------------------------------------------

async function createDraft(client: CdpClient, selectors: Selectors): Promise<void> {
  console.log('\n=== createDraft ===');
  await client.navigate('https://x.com/compose/articles');
  await sleep(3000);

  const titlePresent = `(()=>{ const sels=${jsList(selectors.titleInput)}; return ${anySelectorExpr(selectors.titleInput)}; })()`;
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
    throw new Error(
      'Could not find the Write button on x.com/compose/articles. Update selectors.md or open the editor manually.',
    );
  }

  // Wait for the editor: URL moves to /edit/<id> AND the composer mounts.
  // (Waiting on the title textarea alone produced false negatives — the draft
  // was created but the placeholder-based selector didn't match.)
  const editorReady = await client.waitFor(
    `/compose\\/articles\\/edit\\//.test(location.href) && !!document.querySelector(${JSON.stringify(
      selectors.composer,
    )})`,
    40_000,
  );
  if (!editorReady) {
    throw new Error(
      'Editor did not open after clicking Write. If this is the first run, sign in to X in the Chrome window, then re-run.',
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

async function fillBody(
  client: CdpClient,
  blocks: Block[],
  selectors: Selectors,
  profileMarker: string,
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
    await sleep(120);
    if (b.kind === 'paragraph') await applyInlineRuns(client, b, selectors);
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
 * Style the link / bold / italic runs of a JUST-TYPED paragraph: select the
 * exact range in the block, click the toolbar control. Links go through the
 * link dialog (two inputs + 插入 button; the display-text input is the one
 * prefilled with the selection, the other is the URL).
 */
async function applyInlineRuns(
  client: CdpClient,
  p: Extract<Block, { kind: 'paragraph' }>,
  selectors: Selectors,
): Promise<void> {
  const styled = p.runs.filter((r) => r.url || r.bold || r.italic);
  if (!styled.length) return;
  let prefix = '';
  for (const r of p.runs) {
    if (r === styled[0]) break;
    prefix += r.text;
  }
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
      const tid = r.bold ? 'btn-bold' : 'btn-italic';
      await client.eval(`(() => { const b = document.querySelector('[data-testid="${tid}"]'); if (b && b.offsetParent !== null) { b.click(); return true } return false })()`);
      await sleep(300);
      console.log(`  ✓ ${r.bold ? 'bold' : 'italic'} applied: ${r.text.slice(0, 25)}`);
    }
    prefix += r.text;
  }
}

/**
 * Style heading / list-item token blocks: caret into the token block (token
 * still selected via selectTokenExpr), apply the block style, then swap the
 * token for the real text. Headings: ## → 标题 (header-one), ### → 副标题
 * (header-two) via the 正文 dropdown (whose button label mirrors the current
 * block type, so match any of 正文/标题/副标题). Lists: btn-ul / btn-ol.
 */
async function applyBlockStyles(
  client: CdpClient,
  blocks: Block[],
  selectors: Selectors,
): Promise<void> {
  type StyleTarget = Extract<Block, { kind: 'heading' | 'listitem' }>;
  const targets = blocks.filter(
    (b): b is StyleTarget => b.kind === 'heading' || b.kind === 'listitem',
  );
  if (!targets.length) return;
  console.log(`\n=== applyBlockStyles (${targets.length} heading/list blocks) ===`);
  let ok = 0;
  for (let i = 0; i < targets.length; i++) {
    const b = targets[i]!;
    const label = b.kind === 'heading' ? (b.level <= 2 ? '标题' : '副标题') : null;
    console.log(`- [${i + 1}] ${b.kind}${b.kind === 'heading' ? b.level : b.ordered ? '(ol)' : '(ul)'}: ${b.text.slice(0, 30)}`);

    // 1. select the token → caret inside the token block (focuses contenteditable)
    const pos = await selectTokenVerified(client, b.token, selectors);
    if (!pos) {
      console.warn(`  ! token could not be verifiably selected; skipping`);
      continue;
    }
    await sleep(200);

    // 2. apply the block style to the current block
    let styled = false;
    if (label) {
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
      state.cls &&
      (b.kind === 'heading'
        ? state.cls.includes('header')
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

      // Step 4: clear the leftover token block (text via OS DELETE).
      const held = await client.eval<string>(
        `(() => { try {
          const c = document.querySelector(${JSON.stringify(selectors.composer)});
          const b = [...c.querySelectorAll('[data-block="true"]')]
            .find(x => (x.innerText || '').includes(${JSON.stringify(cb.token)}));
          if (!b) return 'GONE';
          const rg = document.createRange(); rg.selectNodeContents(b);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(rg);
          b.closest('[contenteditable="true"]')?.focus();
          return s.toString().length > 0 ? 'HELD' : 'EMPTY';
        } catch (e) { return 'ERR:' + e.message; } })()`,
      );
      if (held === 'HELD') {
        await sleep(400);
        await client.bringToFront();
        await sleep(250);
        await deleteSelection(1, profileMarker);
        await sleep(1200);
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
): Promise<void> {
  console.log(`\n=== insertImages (${imageBlocks.length}, paste-replace tokens) ===`);
  let ok = 0;
  for (let i = 0; i < imageBlocks.length; i++) {
    const im = imageBlocks[i] as Extract<Block, { kind: 'image' }>;
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
  const imageBlocks = article.blocks.filter(
    (b): b is Block & { kind: 'image' } => b.kind === 'image',
  );
  const codeBlocks = article.blocks.filter(
    (b): b is Block & { kind: 'code' } => b.kind === 'code',
  );
  console.log(`  title: ${article.title}`);
  console.log(`  cover: ${article.coverImage ?? '(none)'}`);
  console.log(
    `  blocks: ${article.blocks.length} (${imageBlocks.length} images, ${codeBlocks.length} code)`,
  );

  // Pre-flight: every image and cover must resolve to a real file. Catches
  // bad paths early with a clear message instead of failing deep in PowerShell.
  const missing: string[] = [];
  if (article.coverImage && !fs.existsSync(article.coverImage)) {
    missing.push(`cover: ${article.coverImage}`);
  }
  for (const im of imageBlocks) {
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
    await createDraft(client, selectors);
    await fillTitle(client, article.title, selectors);
    await fillBody(client, article.blocks, selectors, path.basename(args.profileDir));
    if (codeBlocks.length) {
      await insertCodeBlocks(client, codeBlocks, selectors, path.basename(args.profileDir));
    }
    // Headings + list items: style the token blocks, then swap in real text.
    await applyBlockStyles(client, article.blocks, selectors);
    if (imageBlocks.length && !args.noImages) {
      await insertImages(client, imageBlocks, selectors, path.basename(args.profileDir));
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
