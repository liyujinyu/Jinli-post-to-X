import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
try {
  // 1. dump all toolbar buttons
  const btns = await client.eval<any>(`(() => { try {
    const out=[];
    document.querySelectorAll('[data-testid="app-bar"] button, header button, [role="toolbar"] button, [data-testid^="btn-"]').forEach(b=>{
      const tid=b.getAttribute('data-testid')||'';
      const al=b.getAttribute('aria-label')||'';
      const txt=(b.innerText||'').trim().slice(0,10);
      out.push(tid+'|'+al+'|'+txt);
    });
    return JSON.stringify([...new Set(out)]);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('BUTTONS:', btns);
} finally { browser.close(); }
