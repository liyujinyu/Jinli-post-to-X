import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // caret (collapsed) inside the quoted --help block
  const sel = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs.find(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').includes('--help'));
    if(!b) return 'NOBLOCK';
    b.scrollIntoView({block:'center'});
    const walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);
    const tn=walker.nextNode(); if(!tn) return 'NOTEXT';
    const rg=document.createRange(); rg.setStart(tn,1); rg.collapse(true);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
    b.closest('[contenteditable="true"]').focus();
    return 'CARET';
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('caret:', sel);
  await sleep(500);
  const dd = await client.eval<any>(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入');
    if(!b) return 'NOBTN'; b.click(); return 'CLICKED'; })()`);
  await sleep(900);
  const state = await client.eval<any>(`(() => { try {
    const items=[...document.querySelectorAll('[role="menuitem"], [role="option"]')].map(x=>(x.innerText||'').trim());
    return JSON.stringify({items, anyMenu: !!document.querySelector('[role="menu"]')});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('menu-state:', state);
  const mi = await client.eval<any>(`(() => { const items=[...document.querySelectorAll('[role="menuitem"], [role="option"]')];
    const m=items.find(x=>(x.innerText||'').trim()==='代码'); if(!m) return 'NOMENUITEM'; m.click(); return 'CLICKED'; })()`);
  console.log('click:', mi);
  await sleep(1200);
  const after = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
    const b=bs[i];
    return JSON.stringify({idx:i+1, cls:(b.className||'').slice(0,100), total:bs.length,
      tagChain:(()=>{let a=[];let n=b;for(let k=0;k<4&&n;k++){a.push(n.tagName+'.'+((n.className||'').split(' ')[0]||''));n=n.parentElement}return a.join('>')})(),
      pre:!!b.querySelector('pre,code,textarea'), text:(b.innerText||'').slice(0,40)});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('AFTER:', after);
} finally { browser.close(); }
