import { connect, sleep } from './cdp.ts';
import { deleteSelection, sendKeys } from './os-clipboard.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
let ok = true;
try {
  // Step A: clear text of the old quoted block (--help)
  let r = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs.find(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').includes('--help'));
    if(!b) return 'NOBLOCK';
    b.scrollIntoView({block:'center'});
    const rg=document.createRange(); rg.selectNodeContents(b);
    const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
    b.closest('[contenteditable="true"]').focus();
    return 'HELD';
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('A select:', r);
  await sleep(450); await client.bringToFront(); await sleep(250);
  await deleteSelection(1, 'x-browser-profile');
  await sleep(1200);
  r = await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    return bs.filter(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').includes('--help')).length===0 ? 'CLEARED' : 'STILL'; })()`);
  console.log('A result:', r);
  ok = r === 'CLEARED';

  // Step B: if an empty quote block remains → caret inside + OS Backspace
  if (ok) {
    const st = await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const i=bs.findIndex(x=>((x.className||'')).includes('blockquote'));
      if(i<0) return JSON.stringify({gone:true});
      return JSON.stringify({gone:false, idx:i+1, text:(bs[i].innerText||'').length}); })()`);
    console.log('B state:', st);
    const s2 = JSON.parse(st as string);
    if (!s2.gone && s2.text === 0) {
      await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
        const b=bs[${s2.idx-1}];
        const rg=document.createRange(); rg.selectNodeContents(b); rg.collapse(true);
        const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        b.closest('[contenteditable="true"]').focus(); b.scrollIntoView({block:'center'}); return 1; })()`);
      await sleep(450); await client.bringToFront(); await sleep(250);
      await sendKeys('{BS}', 'x-browser-profile');
      await sleep(1500);
      const v = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
        const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
        const q=bs.filter(x=>((x.className||'')).includes('blockquote')).length;
        const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
        return JSON.stringify({total:bs.length, quotes:q, around: bs.slice(i-1,i+2).map(b=>((b.className||'').split(' ')[0]||'-')+':'+(b.innerText||'').slice(0,22).split(NL).join('|'))});
      } catch(e){return 'ERR:'+e.message} })()`);
      console.log('B after-backspace:', v);
    }
  }
} finally { browser.close(); }
