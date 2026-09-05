import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  // Click at end of composer content (bottom) to place caret on last block
  const r = await client.eval<any>(`(() => {
    const c = document.querySelector('[data-testid="composer"]');
    if (!c) return {ok:false};
    const last = [...c.querySelectorAll('[data-block="true"]')].pop();
    if (last) { last.scrollIntoView({block:'center'}); const rr = last.getBoundingClientRect(); return {ok:true, x: rr.x + rr.width*0.4, y: rr.y + rr.height/2}; }
    return {ok:false};
  })()`);
  console.log('target:', JSON.stringify(r));
  if (r?.ok) await client.clickAt(r.x, r.y);
  await sleep(400);
  // Press End then Enter to create a fresh empty line
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(400);
  // Type "/"
  await client.insertText('/');
  await sleep(900);
  // Dump any popup menu items
  const menu = await client.eval<any>(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] *, [data-testid*="typeahead" i] *')]
      .filter(e => e.offsetParent !== null && (e.innerText||'').trim())
      .map(e => (e.innerText||'').trim().slice(0,30))
      .filter((v,i,a) => a.indexOf(v) === i);
    return items;
  })()`);
  console.log('slash menu items:', JSON.stringify(menu, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_slash.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
