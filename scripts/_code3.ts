import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  const dump = await client.eval<any>(`(() => { try {
    const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const around=bs.slice(43,49).map((b,i)=>'#'+(44+i)+' '+((b.className||'').split(' ')[0]||'-')+' | '+(b.innerText||'').slice(0,25).split(NL).join('|'));
    // any block with 'code' in class, any dialog/modal open, any textarea
    const codeBlocks=bs.map((b,i)=>i+1+':'+(b.className||'')).filter(x=>/code/i.test(x));
    const modal=document.querySelector('[role="dialog"]');
    const tas=[...document.querySelectorAll('textarea')].map(t=>t.placeholder||t.getAttribute('aria-label')||'?');
    // editor-level code blocks outside composer?
    const pres=[...document.querySelectorAll('pre')].length;
    return JSON.stringify({around, codeBlocks, modal: modal? modal.innerText.slice(0,80) : null, tas, pres, total: bs.length});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log(dump);
} finally { browser.close(); }
