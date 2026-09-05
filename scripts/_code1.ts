import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // select the whole quoted block containing './cli-proxy-api.exe --help'
  const sel = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs.find(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').includes('--help'));
    if(!b) return 'NOBLOCK';
    b.scrollIntoView({block:'center'});
    const rg=document.createRange(); rg.selectNodeContents(b);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
    b.closest('[contenteditable="true"]').focus();
    return s.toString().includes('--help')?'HELD:'+s.toString().slice(0,30):'BAD';
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('select:', sel);
  if (typeof sel === 'string' && sel.startsWith('HELD')) {
    await sleep(450);
    await client.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入'); if(b){b.click(); return 1} return 0; })()`);
    await sleep(700);
    const mi = await client.eval<any>(`(() => { const items=[...document.querySelectorAll('[role="menuitem"], [role="option"]')];
      const m=items.find(x=>(x.innerText||'').trim()==='代码');
      if(!m) return 'NOMENUITEM'; m.click(); return 'CLICKED-代码'; })()`);
    console.log('menu:', mi);
    await sleep(1200);
    const after = await client.eval<any>(`(() => { try {
      const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
      const b=bs[i];
      return JSON.stringify({idx:i+1, cls:(b.className||'').slice(0,80), text:(b.innerText||'').slice(0,60),
        html:b.innerHTML.slice(0,200), total:bs.length,
        nearby:bs.slice(Math.max(0,i-1),i+2).map(x=>(x.className||'').split(' ')[0]+':'+(x.innerText||'').slice(0,20))});
    } catch(e){return 'ERR:'+e.message} })()`);
    console.log('AFTER:', after);
  }
} finally { browser.close(); }
