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
import { copyImage, paste, deleteSelection, pasteImage, pasteHtml } from './os-clipboard.ts';
import { parseArticle, type Block } from './markdown.ts';

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
        return { ok: true };
      }
    }
    return { ok: false, reason: 'token-not-found' };
  })()`;
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

  // Find the "Write" button. When the article list is empty it's
  // empty_state_button_text; once drafts exist the button moves but keeps the
  // label "Write" / "写文章". Try testid first, then text, then any link to a
  // fresh compose URL.
  let clicked = await clickSelector(client, selectors.emptyStateWrite);
  if (!clicked) {
    clicked = await clickTextButton(client, ['Write', '写文章', '寫文章', '記事を書く']);
    if (clicked) console.log('[createDraft] Clicked Write by text');
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

  // Wait for the editor (title textarea appears on the edit/<id> page).
  const editorReady = await client.waitFor(titlePresent, 40_000);
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
  console.log(`\n=== fillBody inline (${paras} paragraphs, ${imgs} images, ${codes} code blocks) ===`);

  // Focus the composer first so insertText goes to the editor, not the title.
  await client.eval(
    `(()=>{ const c = document.querySelector(${JSON.stringify(
      selectors.composer,
    )}); const ce = c && (c.querySelector(${JSON.stringify(
      selectors.contentEditable,
    )}) || c); ce && ce.focus(); return !!ce; })()`,
  );
  await sleep(300);

  // Phase 1: type the WHOLE article first — paragraphs become text, image
  // positions become a UNIQUE placeholder token paragraph. This uploads the
  // complete article up front (so nothing is half-done) and bakes each image's
  // exact spot into the text as a locatable token. Phase 2 (insertImages) then
  // selects each token and paste-replaces it with the real image.
  let imgInserted = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const content = b.kind === 'paragraph' ? b.text : b.token;
    await client.insertText(content);
    if (i < blocks.length - 1) await client.pressKey(13, 'Enter', 'Enter');
    await sleep(120);
  }
  console.log(`  body typed (${paras} paragraphs + ${imgs} img tokens + ${codes} code tokens)`);
  await snapshot(client, selectors, 'fillBody:after');
}

/**
 * Phase 1.5: replace each code token with a REAL code block, in document
 * order. Same paste-replace mechanism as images: highlight the token via the
 * Selection API, then ONE atomic OS call deletes the token and Ctrl+V pastes
 * clipboard HTML. The clipboard carries <pre><code> as CF_HTML (plus a
 * plain-text fallback), so DraftJS's paste processor maps it to its native
 * code-block entity — something insertText can never produce (it would fold
 * every line into one plain paragraph).
 */
async function insertCodeBlocks(
  client: CdpClient,
  codeBlocks: Block[],
  selectors: Selectors,
  profileMarker: string,
): Promise<void> {
  console.log(`\n=== insertCodeBlocks (${codeBlocks.length}, paste-replace tokens) ===`);
  const escHtml = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let ok = 0;
  for (let i = 0; i < codeBlocks.length; i++) {
    const cb = codeBlocks[i] as Extract<Block, { kind: 'code' }>;
    const html = `<pre><code>${escHtml(cb.text)}</code></pre>`;
    console.log(`- token[${i + 1}] ${cb.token} ← ${cb.lang || 'text'} (${cb.text.split('\n').length} lines)`);

    const pos = await client.eval<{ ok: boolean; reason?: string }>(
      selectTokenExpr(cb.token, selectors),
    );
    if (!pos?.ok) {
      console.warn(`  ! token not found (${pos?.reason}); skipping`);
      continue;
    }

    await client.bringToFront();
    await sleep(i === 0 ? 600 : 250);
    // Atomic: activate → {DELETE} removes the highlighted token → load HTML
    // clipboard → Ctrl+V. DraftJS replaces the selection with the pasted
    // <pre>, i.e. a native code block at the exact token position.
    await pasteHtml(html, cb.text, profileMarker, true);
    await sleep(400);

    // Verify the token is gone (the paste consumed it).
    const gone = await client.eval<boolean>(
      `(() => { const c = document.querySelector(${JSON.stringify(
        selectors.composer,
      )}); return !(c && (c.innerText || '').includes(${JSON.stringify(cb.token)})); })()`,
    );
    if (gone) {
      ok++;
      console.log(`  ✓ code block replaced token`);
    } else {
      console.warn(`  ! token still present — paste may have failed`);
    }
  }
  console.log(`  code blocks inserted: ${ok}/${codeBlocks.length}`);
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

    // Highlight the token text — the OS paste lands the image right at this spot.
    const pos = await client.eval<{ ok: boolean; reason?: string }>(
      selectTokenExpr(im.token, selectors),
    );
    if (!pos?.ok) {
      console.warn(`  ! token not found (${pos?.reason}); skipping`);
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
    const verify = async () => {
      if (!(await client.waitFor(grew, 15_000, 250))) return false;
      // Confirm the token text is actually gone (not just the image present).
      const remaining = await client.eval<number>(
        `(document.querySelector(${JSON.stringify(selectors.composer)})?.textContent||'').split(${JSON.stringify(im.token)}).length - 1`,
      );
      return remaining === 0;
    };
    if (await verify()) {
      ok++;
      console.log(`  ✓ image replaced token (${before} → ${await countImgs(client, selectors)})`);
    } else {
      console.warn(`  ! retrying (image missing or token leftover)`);
      await client.eval(selectTokenExpr(im.token, selectors)).catch(() => {});
      await client.bringToFront();
      await sleep(300);
      await pasteImage(im.path, profileMarker, true);
      if (await (async () => {
        if (!(await client.waitFor(grew, 10_000, 250))) return false;
        const remaining = await client.eval<number>(
          `(document.querySelector(${JSON.stringify(selectors.composer)})?.textContent||'').split(${JSON.stringify(im.token)}).length - 1`,
        );
        return remaining === 0;
      })()) {
        ok++;
        console.log(`  ✓ image replaced token on retry`);
      } else {
        console.warn(`  ! gave up on ${path.basename(im.path)}`);
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
    if (imageBlocks.length && !args.noImages) {
      await insertImages(client, imageBlocks, selectors, path.basename(args.profileDir));
    } else if (imageBlocks.length) {
      console.log('\n[--no-images] tokens left in body; run pw-images.ts to insert them.');
    }
    if (article.coverImage) await uploadCover(client, article.coverImage, selectors);

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
