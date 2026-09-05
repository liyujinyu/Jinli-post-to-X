import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /edit/ });
try {
  // 1. caret into first paragraph
  const sel = await client.eval<any>(`(() => {
    const b = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')].find(x => (x.innerText||'').includes('第一段'));
    if (!b) return {ok:false};
    const span = b.querySelector('[data-text="true"]');
    if (!span?.firstChild) return {ok:false, why:'nospan'};
    const r = document.createRange(); r.setStart(span.firstChild, 2); r.setEnd(span.firstChild, 2);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    const ce = document.querySelector('[data-testid="composer"] [contenteditable="true"]');
    ce && (ce as any).focus();
    return {ok:true};
  })()`);
  console.log('1 caret:', JSON.stringify(sel));
  await sleep(400);
  // 2. click 正文
  const clicked = await client.eval<any>(`(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText||'').trim() === '正文');
    if (!btns.length) return {ok:false, n:0};
    btns[0].click();
    return {ok:true, txt: btns[0].innerText, tag: btns[0].tagName, cls: btns[0].className.slice(0,40)};
  })()`);
  console.log('2 正文 btn:', JSON.stringify(clicked));
  await sleep(1000);
  // 3. what's visible now?
  const after = await client.eval<any>(`(() => {
    const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-testid="Dropdown"]')]
      .filter(e => e.offsetParent !== null).map(m => (m.innerText||'').slice(0,120));
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"]')].filter(e=>e.offsetParent!==null).map(e=>(e.innerText||'').trim()).filter(Boolean);
    return { menus, items };
  })()`);
  console.log('3 after click:', JSON.stringify(after, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_z_dbg.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
