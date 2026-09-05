import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
try {
  const dd = await client.eval<any>(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入');
    if(!b) return 'NOBTN'; b.click(); return 'CLICKED'; })()`);
  await sleep(800);
  const items = await client.eval<any>(`(() => { try {
    return JSON.stringify([...document.querySelectorAll('[role="menuitem"], [role="option"]')].map(x=>(x.getAttribute('data-testid')||'')+'|'+(x.innerText||'').trim().slice(0,20)));
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('INSERT-MENU:', items);
  // leave menu open state dump done; close
  await client.eval(`(() => { const b=document.querySelector('[aria-label="Close"], [data-testid="app-bar-close"]'); if(b){b.click(); return 'closed'} return 'no-close-btn'; })()`);
  await sleep(300);
} finally { browser.close(); }
