import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /edit/ });
try {
  // select the leftover token (same selectTokenExpr logic)
  const sel = await client.eval<any>(`(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const root = composer.querySelector('[data-contents="true"]') || composer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    const tok = 'XAP-CODE-9-PLACEHOLDER';
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent || '';
      const idx = t.indexOf(tok);
      if (idx >= 0) {
        if (node.parentElement) node.parentElement.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(node, idx); range.setEnd(node, idx + tok.length);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const ce = composer.querySelector('[contenteditable="true"]') || composer;
        if (ce.focus) ce.focus();
        return { ok: true };
      }
    }
    return { ok: false };
  })()`);
  console.log('select:', JSON.stringify(sel));
  await sleep(400);
  await client.insertText('.\cli-proxy-api.exe -config .\config.yaml -codex-login');
  await sleep(350);
  await client.eval(`(() => { const b = document.querySelector('[data-testid="btn-blockquote"]'); if (b) b.click(); return !!b; })()`);
  await sleep(500);
  const st = await client.eval<any>(`(() => {
    const b = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')].find(x => (x.innerText||'').includes('codex-login'));
    return b ? { cls: b.className, txt: (b.innerText||'').slice(0,60) } : null;
  })()`);
  console.log('result:', JSON.stringify(st));
} finally { browser.close(); }
