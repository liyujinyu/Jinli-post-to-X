import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /edit/ });
try {
  // token[9] (powershell '.\cli-proxy-api.exe -codex-login'?) — first check if token text remains
  const st = await client.eval<any>(`(() => {
    const c = document.querySelector('[data-testid="composer"]');
    const txt = c.innerText || '';
    const leftovers = txt.match(/XAP-CODE-\d+-PLACEHOLDER/g) || [];
    // find token9 block
    const b9 = [...c.querySelectorAll('[data-block="true"]')].find(x => (x.innerText||'').includes('XAP-CODE-9-PLACEHOLDER'));
    // find block1 (chain diagram: starts with WorkBuddy then OpenAI)
    const b1 = [...c.querySelectorAll('[data-block="true"]')].filter(x => (x.innerText||'').includes('OpenAI 兼容请求'));
    return { leftovers, b9: b9 ? {cls: b9.className, txt: b9.innerText.slice(0,60)} : null, b1: b1.map(x=>({cls:x.className, txt:(x.innerText||'').slice(0,50)})) };
  })()`);
  console.log(JSON.stringify(st, null, 1));
} finally { browser.close(); }
