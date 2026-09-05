import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  // Find the 正文 (body type) dropdown button and click it
  const pos = await client.eval<any>(`(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')]
      .filter(e => e.offsetParent !== null && (e.innerText||'').trim() === '正文');
    if (!btns.length) return {ok:false};
    const b = btns[0];
    b.scrollIntoView({block:'center'});
    const r = b.getBoundingClientRect();
    return {ok:true, x:r.x+r.width/2, y:r.y+r.height/2};
  })()`);
  console.log('正文 btn:', JSON.stringify(pos));
  if (pos?.ok) { await client.clickAt(pos.x, pos.y); await sleep(1200); }
  const items = await client.eval<any>(`(() => {
    // any menu/listbox that just opened
    const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]')]
      .filter(e => e.offsetParent !== null);
    const out = [];
    for (const m of menus) {
      for (const it of m.querySelectorAll('[role="menuitem"], [role="option"], li, button')) {
        const t = (it.innerText||'').trim();
        if (t) out.push(t.slice(0,40));
      }
    }
    return [...new Set(out)];
  })()`);
  console.log('menu items:', JSON.stringify(items, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_menu.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
