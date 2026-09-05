import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // focus a plain paragraph block
  await client.eval(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs.find(x=>((x.className||'')).includes('unstyled') && (x.innerText||'').includes('实际链路'));
    if(!b) return 'NOBLOCK'; b.scrollIntoView({block:'center'});
    const rg=document.createRange(); rg.selectNodeContents(b); rg.collapse(false);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
    b.closest('[contenteditable="true"]').focus(); return 'FOCUSED'; })()`);
  await sleep(1200);
  // re-dump toolbar buttons after focus
  const btns = await client.eval<any>(`JSON.stringify([...document.querySelectorAll('button[data-testid], header button, [data-testid="app-bar"] button')].map(b=>(b.getAttribute('data-testid')||'')+'|'+(b.getAttribute('aria-label')||'')+'|'+(b.innerText||'').trim().slice(0,10)).filter(x=>x!=='||'))`);
  console.log('BUTTONS-after-focus:', btns);
  // open the 正文 dropdown (button whose text is 正文/标题/副标题, no testid)
  const dd = await client.eval<any>(`(() => { const b=[...document.querySelectorAll('button')].find(x=>['正文','标题','副标题'].includes((x.innerText||'').trim()) && !x.getAttribute('data-testid'));
    if(!b) return 'NODROPDOWN'; b.click(); return 'CLICKED:'+(b.innerText||'').trim(); })()`);
  console.log('dropdown:', dd);
  await sleep(800);
  // dump menu items
  const items = await client.eval<any>(`(() => { try {
    const items=[...document.querySelectorAll('[role="menuitem"], [role="option"]')];
    return JSON.stringify(items.map(x=>(x.getAttribute('data-testid')||'')+'|'+(x.innerText||'').trim().slice(0,20)));
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('MENU-ITEMS:', items);
  // close menu
  await client.eval(`document.body.click()`); await sleep(300);
  await client.eval(`(() => { const b=document.querySelector('[aria-label="Close"], [data-testid="app-bar-close"], [aria-label="关闭"]'); if(b) b.click(); return 1; })()`);
} finally { browser.close(); }
