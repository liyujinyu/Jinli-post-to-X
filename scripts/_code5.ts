import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // fill language + code, click Insert
  const fill = await client.eval<any>(`(() => { try {
    const m=document.querySelector('[role="dialog"]'); if(!m) return 'NOMODAL';
    const ta=m.querySelector('textarea'); if(!ta) return 'NOTA';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
    setter.call(ta, '.\\cli-proxy-api.exe --help');
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    const li=m.querySelector('input[data-testid="programming-language-input"]');
    if(li){ const s2=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      s2.call(li,'powershell'); li.dispatchEvent(new Event('input',{bubbles:true})); }
    return 'FILLED';
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('fill:', fill);
  await sleep(600);
  const ins = await client.eval<any>(`(() => { const m=document.querySelector('[role="dialog"]'); if(!m) return 'NOMODAL';
    const b=[...m.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入'); if(!b) return 'NOBTN'; b.click(); return 'INSERTED'; })()`);
  console.log('insert:', ins);
  await sleep(1500);
  const after = await client.eval<any>(`(() => { try {
    const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const i=bs.findIndex(x=>(x.innerText||'').includes('--help'));
    const around=bs.slice(Math.max(0,i-1),i+3).map((b,k)=>'#'+(Math.max(0,i-1)+k+1)+' '+((b.className||'').split(' ')[0]||'-')+' | '+(b.innerText||'').slice(0,30).split(NL).join('|')+' | img='+!!b.querySelector('img'));
    const codeCls=bs.map((b,k)=>(k+1)+':'+((b.className||''))).filter(x=>/code/i.test(x)).slice(0,5);
    const modalGone=!document.querySelector('[role="dialog"]');
    return JSON.stringify({around, codeCls, modalGone, total:bs.length});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('AFTER:', after);
} finally { browser.close(); }
