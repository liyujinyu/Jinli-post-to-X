import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
const press = async (key: string, code: string, vk: number) => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
try {
  // Select ALL text inside the code block (the leftover ```) and replace with real code
  const sel = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const target = blocks.find(b => (b.innerText||'').trim().startsWith('\`\`\`'));
    if (!target) return {ok:false, why:'no code block'};
    target.scrollIntoView({block:'center'});
    const span = target.querySelector('[data-text="true"]') || target;
    const range = document.createRange();
    range.selectNodeContents(span);
    const s = window.getSelection();
    s.removeAllRanges(); s.addRange(range);
    const ce = document.querySelector('[data-testid="composer"] [contenteditable="true"]');
    if (ce) ce.focus();
    return {ok:true};
  })()`);
  console.log('select ``` :', JSON.stringify(sel));
  await sleep(400);
  await client.insertText('host: "127.0.0.1"\nport: 8317\n\nremote-management:\n  allow-remote: false');
  await sleep(600);
  const st = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const target = blocks.find(b => (b.innerText||'').includes('remote-management'));
    return target ? { cls: target.className, text: target.innerText } : null;
  })()`);
  console.log('code block after replace:', JSON.stringify(st, null, 1));
  // exit code block: ArrowDown then click below
  await press('ArrowDown', 'ArrowDown', 40);
  await sleep(300);
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_code.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
