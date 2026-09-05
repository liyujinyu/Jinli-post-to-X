import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
const press = async (key: string, code: string, vk: number) => {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
};
try {
  // caret to end of last block then new empty line
  const r = await client.eval<any>(`(() => {
    const c = document.querySelector('[data-testid="composer"]');
    const last = [...c.querySelectorAll('[data-block="true"]')].pop();
    last.scrollIntoView({block:'center'});
    const rr = last.getBoundingClientRect();
    return {x: rr.x + rr.width*0.9, y: rr.y + rr.height/2};
  })()`);
  await client.clickAt(r.x, r.y);
  await sleep(300);
  await press('End', 'End', 35);
  await press('Enter', 'Enter', 13);
  await sleep(300);
  await client.insertText('```');
  await sleep(500);
  let st = await client.eval<any>(`(() => {
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const block = node && (node.nodeType===1?node:node.parentElement)?.closest('[data-block="true"]');
    return { text: block? block.innerText : null, cls: block? block.className : null };
  })()`);
  console.log('after typing ``` :', JSON.stringify(st));
  await press('Enter', 'Enter', 13);
  await sleep(700);
  st = await client.eval<any>(`(() => {
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const block = node && (node.nodeType===1?node:node.parentElement)?.closest('[data-block="true"]');
    return { text: block? block.innerText : null, cls: block? block.className : null };
  })()`);
  console.log('after Enter      :', JSON.stringify(st));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_md.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
