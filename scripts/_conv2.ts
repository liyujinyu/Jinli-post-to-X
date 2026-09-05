import { connect, sleep } from './cdp.ts';
import { sendKeys } from './os-clipboard.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  let st = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
    return JSON.stringify({total:bs.length, around:bs.slice(i-2,i+2).map((b,k)=>'#'+(i-1+k)+' '+((b.className||'').split(' ')[0]||'-')+'|t='+(b.innerText||'').length+'|'+(b.innerText||'').slice(0,20).split(NL).join('~')),
      quotes:bs.filter(x=>((x.className||'')).includes('blockquote')).length});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('state:', st);
  const s = JSON.parse(st as string);
  const around = s.around as string[];
  // find an empty quote block in this window → backspace it
  const emptyQ = around.find(x => x.includes('longform-blockquote|t=0'));
  if (emptyQ) {
    const idx = parseInt(emptyQ.slice(1, emptyQ.indexOf(' '))) ;
    console.log('empty quote block at #', idx+1);
    await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const b=bs[${idx}];
      const rg=document.createRange(); rg.selectNodeContents(b); rg.collapse(true);
      const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
      b.closest('[contenteditable="true"]').focus(); b.scrollIntoView({block:'center'}); return 1; })()`);
    await sleep(450); await client.bringToFront(); await sleep(250);
    await sendKeys('{BS}', 'x-browser-profile');
    await sleep(1500);
    st = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
      const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
      return JSON.stringify({total:bs.length, around:bs.slice(i-2,i+2).map((b,k)=>'#'+(i-1+k)+' '+((b.className||'').split(' ')[0]||'-')+'|t='+(b.innerText||'').length+'|'+(b.innerText||'').slice(0,20).split(NL).join('~'))});
    } catch(e){return 'ERR:'+e.message} })()`);
    console.log('after backspace:', st);
  } else console.log('no empty quote block in window');
} finally { browser.close(); }
