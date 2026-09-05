import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit/ });
try {
  const info = await client.eval<any>(`(() => {
    // toolbar / buttons around the editor
    const btns = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="tab"]')]
      .filter(b => b.offsetParent !== null)
      .map(b => ({ label: b.getAttribute('aria-label') || '', text: (b.innerText||'').slice(0,20), testid: b.getAttribute('data-testid')||'' }))
      .filter(b => b.label || b.text);
    // focus a known code-ish paragraph to reveal block handles
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const target = blocks.find(b => (b.innerText||'').includes('E032EE60'));
    if (target) { target.scrollIntoView({block:'center'}); target.dispatchEvent(new MouseEvent('mouseover', {bubbles:true})); }
    return { url: location.href, buttons: btns, blockCount: blocks.length };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await sleep(500);
  const shot = 'D:/AI工具集/AI本地知识库/obsidian-box/创作输出/2026-09-04-把Codex订阅接进WorkBuddy/_inspect_toolbar.png';
  await client.screenshot(shot);
  console.log('shot →', shot);
} finally { browser.close(); }
