import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  // scroll to the end where we did the test
  await client.eval(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const t = blocks.find(b => (b.innerText||'').includes('host: "127.0.0.1"'));
    if (t) t.scrollIntoView({block:'center'});
  })()`);
  await sleep(500);
  // any element whose text is exactly 'text' (language dropdown), anywhere incl. popups
  const probe = await client.eval<any>(`(() => {
    const hits = [];
    for (const e of document.querySelectorAll('div,button,span')) {
      if ((e.childElementCount===0) && (e.textContent||'').trim()==='text' && e.className) {
        hits.push(e.tagName + '.' + String(e.className).slice(0,60));
      }
    }
    const backtick = [...document.querySelectorAll('[data-block="true"]')].filter(b=>(b.innerText||'').includes('\`\`\`')).map(b=>b.className);
    return { langLabels: hits.slice(0,5), backtickBlocks: backtick };
  })()`);
  console.log(JSON.stringify(probe, null, 1));
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_z_live.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
