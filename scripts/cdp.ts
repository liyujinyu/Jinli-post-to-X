/**
 * cdp.ts — Stable layer.
 *
 * Self-contained Chrome DevTools Protocol helper built on the bare globals
 * `WebSocket` and `fetch` (both available in Node ≥ 22 and Bun). No external
 * dependencies, no reference to x-utils.
 *
 * Design follows the verified patterns from the 2026-08 article publish run
 * (see references/troubleshooting.md): flattened target sessions, per-request
 * timeouts, response routing by id. CDP is used ONLY for clicking, coordinates,
 * insertText, DOM queries and screenshots — never for synthetic paste/delete,
 * which go through os-clipboard.ts at the OS level.
 */

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Low-level connection (mirrors the production CdpConnection shape)
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Poll `http://127.0.0.1:<port>/json/version` until the browser responds. */
export async function waitForDebugPort(
  port: number,
  timeoutMs = 30_000,
): Promise<string> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        `http://127.0.0.1:${port}/json/version`,
      );
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
      lastError = new Error('Missing webSocketDebuggerUrl');
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `Chrome debug port ${port} not ready: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Raw browser-level CDP connection. Methods here carry no sessionId — use
 * `attachToTab` to obtain a session-scoped client for page work.
 */
export class CdpBrowser {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private defaultTimeoutMs: number;

  private constructor(ws: WebSocket, defaultTimeoutMs: number) {
    this.ws = ws;
    this.defaultTimeoutMs = defaultTimeoutMs;

    this.ws.addEventListener('message', (event) => {
      try {
        const data =
          typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (pending.timer) clearTimeout(pending.timer);
            if (msg.error?.message) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      } catch {
        /* ignore unparseable frames */
      }
    });

    this.ws.addEventListener('close', () => {
      for (const [, pending] of this.pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
      this.pending.clear();
    });
  }

  static async connect(
    wsUrl: string,
    timeoutMs = 30_000,
    defaultTimeoutMs = 30_000,
  ): Promise<CdpBrowser> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CDP connection timeout.')),
        timeoutMs,
      );
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connection failed.'));
      });
    });
    return new CdpBrowser(ws, defaultTimeoutMs);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { sessionId?: string; timeoutMs?: number },
  ): Promise<T> {
    const id = ++this.nextId;
    const message: Record<string, unknown> = { id, method };
    if (params) message.params = params;
    if (options?.sessionId) message.sessionId = options.sessionId;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`CDP timeout: ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(message));
    });
    return result as T;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// Tab resolution
// ---------------------------------------------------------------------------

export type TabInfo = {
  targetId: string;
  url: string;
  type: string;
};

/** List browser page targets. */
export async function getTabs(browser: CdpBrowser): Promise<TabInfo[]> {
  const res = await browser.send<{ targetInfos: TabInfo[] }>(
    'Target.getTargets',
  );
  return res.targetInfos.filter((t) => t.type === 'page');
}

// ---------------------------------------------------------------------------
// Session-scoped client (what publish.ts actually uses)
// ---------------------------------------------------------------------------

export type EvalResult<T> = { value: T; type: string };

export class CdpClient {
  constructor(
    private browser: CdpBrowser,
    public sessionId: string,
  ) {}

  /** Raw session-scoped send. */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    return this.browser.send<T>(method, params, {
      sessionId: this.sessionId,
      timeoutMs,
    });
  }

  /** Enable Page + Runtime + DOM on this session. */
  async enable(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
  }

  /** Evaluate JS in the page, returning the value (returnByValue). */
  async eval<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const res = await this.send<{ result: { value: T; type: string } }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    return res.result.value;
  }

  /** Insert text at the current caret via the IME path DraftJS accepts. */
  insertText(text: string): Promise<unknown> {
    return this.send('Input.insertText', { text });
  }

  /** Dispatch a low-level key event (keyDown/keyUp handled by caller usually). */
  async key(
    type: 'keyDown' | 'keyUp' | 'rawKeyDown',
    opts: {
      key: string;
      code?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    },
  ): Promise<void> {
    await this.send('Input.dispatchKeyEvent', { type, ...opts });
  }

  /** Press + release a character / virtual key cleanly. */
  async pressKey(vk: number, key = '', code = '', modifiers = 0): Promise<void> {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      modifiers,
    });
  }

  /** Ctrl+<key> — CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
  async pressCtrlKey(vk: number, key: string, code: string): Promise<void> {
    await this.pressKey(vk, key, code, 2);
  }

  /** Move + press + release at viewport coordinates — the reliable React click. */
  async clickAt(
    x: number,
    y: number,
    opts: { button?: 'left' | 'right' | 'middle'; move?: boolean } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left';
    const common = { x, y, button, clickCount: 1 };
    if (opts.move !== false) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...common,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...common,
    });
  }

  /** Focus the tab (required before OS-level SendKeys reach the window). */
  bringToFront(): Promise<unknown> {
    return this.send('Page.bringToFront');
  }

  /** Capture a PNG screenshot to disk. */
  async screenshot(filePath: string): Promise<void> {
    const { data } = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png' },
    );
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, Buffer.from(data, 'base64'));
  }

  /**
   * Find the first element whose text contains `keyword` and return the
   * center of its bounding rect (viewport coordinates). Used for coordinate
   * clicks on React buttons identified by label text (e.g. 发布).
   */
  async findElementByText(
    keyword: string,
    opts: { selector?: string; contains?: boolean } = {},
  ): Promise<{ x: number; y: number; found: boolean }> {
    const sel = opts.selector ?? '*';
    const mode = opts.contains === false ? 'equals' : 'contains';
    const expression = `(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      const kw = ${JSON.stringify(keyword)};
      const hit = els.find((el) => {
        const t = (el.textContent || '').trim();
        if (${mode} === 'equals') return t === kw;
        return t.includes(kw) && el.children.length <= 3;
      });
      if (!hit) return { found: false, x: 0, y: 0 };
      const r = hit.getBoundingClientRect();
      hit.scrollIntoView({ block: 'center' });
      const r2 = hit.getBoundingClientRect();
      return { found: true, x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };
    })()`;
    return this.eval(expression);
  }

  /** Wait until an eval predicate returns truthy, polling every `intervalMs`. */
  async waitFor(
    predicateJs: string,
    timeoutMs = 60_000,
    intervalMs = 500,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this.eval<boolean>(predicateJs);
        if (ok) return true;
      } catch {
        /* page may be navigating */
      }
      await sleep(intervalMs);
    }
    return false;
  }

  /** Navigate the tab and wait for load. */
  async navigate(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
  }
}

// ---------------------------------------------------------------------------
// Top-level connect: browser + matching tab session in one call
// ---------------------------------------------------------------------------

export type ConnectOptions = {
  /** Matcher for the tab to attach to. Defaults to any x.com page. */
  tabUrl?: RegExp;
  /** If no matching tab exists, open one at this URL. */
  openUrl?: string;
  /** Always create a fresh target instead of reusing an existing X editor tab. */
  newTab?: boolean;
  defaultTimeoutMs?: number;
};

/**
 * Connect to the browser on `port`, resolve (or create) the X tab, attach a
 * flattened session, enable Page/Runtime/DOM, and return a ready-to-use
 * session-scoped client.
 */
export async function connect(
  port: number,
  options: ConnectOptions = {},
): Promise<{ browser: CdpBrowser; client: CdpClient; tab: TabInfo }> {
  const tabUrl = options.tabUrl ?? /x\.com/;
  const openUrl = options.openUrl ?? 'https://x.com/compose/articles';

  const wsUrl = await waitForDebugPort(port);
  const browser = await CdpBrowser.connect(
    wsUrl,
    30_000,
    options.defaultTimeoutMs ?? 30_000,
  );

  let tabs = await getTabs(browser);
  let tab = options.newTab ? undefined : tabs.find((t) => tabUrl.test(t.url || ''));
  if (!tab) {
    const { targetId } = await browser.send<{ targetId: string }>(
      'Target.createTarget',
      { url: openUrl },
    );
    tab = { targetId, url: openUrl, type: 'page' };
    await sleep(1500);
    tabs = await getTabs(browser);
  }

  const { sessionId } = await browser.send<{ sessionId: string }>(
    'Target.attachToTarget',
    { targetId: tab.targetId, flatten: true },
  );
  const client = new CdpClient(browser, sessionId);
  await client.enable();
  return { browser, client, tab };
}
