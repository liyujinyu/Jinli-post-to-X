import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  const pos = await client.eval<any>(`(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')]
      .filter(e => e.offsetParent !== null && ((e.innerText||'').includes('插入') || (e.getAttribute('aria-label')||'').includes('媒体')));
    if (!btns.length) return {ok:false};
    const b = btns[0];
    b.scrollIntoView({block:'center'});
    const r = b.getBoundingClientRect();
    return {ok:true, x:r.x+r.width/2, y:r.y+r.height/2};
  })()`);
  console.log('insert btn:', JSON.stringify(pos));
  if (pos?.ok) { await client.clickAt(pos.x, pos.y); await sleep(1200); }
  const items = await client.eval<any>(`(() => {
    const out = [];
    for (const m of document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]')) {
      if (m.offsetParent === null) continue;
      for (const it of m.querySelectorAll('[role="menuitem"], [role="option"], button, a')) {
        const t = (it.innerText||'').trim();
        if (t) out.push(t.slice(0,30));
      }
    }
    return [...new Set(out)];
  })()`);
  console.log('insert menu:', JSON.stringify(items, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_z_insert.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
