import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  // Select all text within the hash block via Selection API
  const ok = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const target = blocks.find(b => (b.innerText||'').includes('E032EE60'));
    if (!target) return {ok:false, why:'no block'};
    target.scrollIntoView({block:'center'});
    const span = target.querySelector('[data-text="true"]') || target;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    // trigger DraftJS's selectionchange handling
    document.dispatchEvent(new Event('selectionchange'));
    const ce = document.querySelector('[data-testid="composer"] [contenteditable="true"]');
    if (ce) ce.focus();
    return {ok:true};
  })()`);
  console.log('select:', JSON.stringify(ok));
  await sleep(1200);
  // dump visible tooltip/toolbar items that appeared
  const items = await client.eval<any>(`(() => {
    const els = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="textbox"]')]
      .filter(e => e.offsetParent !== null)
      .map(e => ({label: e.getAttribute('aria-label')||'', text:(e.innerText||'').slice(0,20)}))
      .filter(e => e.label || e.text);
    return items = els.slice(-25);
  })()`);
  console.log(JSON.stringify(items, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_sel.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
