import { connect, sleep } from './cdp.ts';
import { deleteSelection } from './os-clipboard.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // 1. verify code card structure
  const card = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs[46]; // #47
    return JSON.stringify({html: b.innerHTML.slice(0,400), text:(b.innerText||'')});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('CARD:', card);
  // 2. delete the old quoted block #46 via selectNode + OS delete
  const sel = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs[45]; if(!((b.className||'')).includes('blockquote')) return 'WRONG:'+((b.className||'').split(' ')[0]);
    b.scrollIntoView({block:'center'});
    const rg=document.createRange(); rg.selectNode(b);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
    b.closest('[contenteditable="true"]').focus();
    return 'HELD:'+s.toString().slice(0,20);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('select old block:', sel);
  if (typeof sel === 'string' && sel.startsWith('HELD')) {
    await sleep(450);
    await client.bringToFront(); await sleep(250);
    await deleteSelection(2, 'x-browser-profile');
    await sleep(1800);
    const after = await client.eval<any>(`(() => { try {
      const NL=String.fromCharCode(10);
      const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
      return JSON.stringify({total:bs.length, idx:i+1,
        around:bs.slice(Math.max(0,i-1),i+2).map((b,k)=>'#'+(Math.max(0,i-1)+k+1)+' '+((b.className||'').split(' ')[0]||'-')+' | '+(b.innerText||'').slice(0,25).split(NL).join('|')),
        quotes: bs.filter(b=>((b.className||'')).includes('blockquote')).length});
    } catch(e){return 'ERR:'+e.message} })()`);
    console.log('AFTER-DELETE:', after);
  }
} finally { browser.close(); }
