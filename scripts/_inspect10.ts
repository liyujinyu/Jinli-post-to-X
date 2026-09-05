import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
const press = async (key: string, code: string, vk: number) => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
const blockCls = () => client.eval<any>(`(() => {
  const sel = window.getSelection();
  const n = sel && sel.anchorNode;
  const b = n && (n.nodeType===1?n:n.parentElement)?.closest?.('[data-block="true"]');
  return b ? { cls: b.className, txt: (b.innerText||'').slice(0,60) } : null;
})()`);
try {
  // click into the test code block
  const r = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const t = blocks.find(b => (b.innerText||'').startsWith('host: "127.0.0.1"'));
    if (!t) return {ok:false};
    t.scrollIntoView({block:'center'});
    const rr = t.getBoundingClientRect();
    return {ok:true, x: rr.x + 30, y: rr.y + 10};
  })()`);
  console.log('click:', JSON.stringify(r));
  if (!r?.ok) throw new Error('no test block');
  await client.clickAt(r.x, r.y);
  await sleep(400);
  await press('Home', 'Home', 36); // caret to block start
  await sleep(200);
  console.log('before:', JSON.stringify(await blockCls()));
  await client.insertText('> ');
  await sleep(600);
  console.log('after "> ":', JSON.stringify(await blockCls()));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_z_quote.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
