import { connect, sleep } from './cdp.ts';
import fs from 'node:fs';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
try {
  await client.bringToFront(); await sleep(800);
  // scroll to a code card to capture its rendering
  await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const b=bs.find(x=>x.querySelector('button[aria-label="编辑块"]') && (x.innerText||'').includes('host:'));
    if(b) b.scrollIntoView({block:'center'}); return 1; })()`);
  await sleep(900);
  const shot = await (client as any).send?.('Page.captureScreenshot', { format: 'png' });
  if (shot?.data) fs.writeFileSync('D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_jptx_preview.png', Buffer.from(shot.data, 'base64'));
  console.log('saved');
} finally { browser.close(); }
