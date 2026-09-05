import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  const dlg = await client.eval<any>(`(() => { try {
    const m=document.querySelector('[role="dialog"]'); if(!m) return 'NOMODAL';
    const out={inputs:[],areas:[],btns:[]};
    m.querySelectorAll('input').forEach(i=>out.inputs.push({ph:i.placeholder||'', testid:i.getAttribute('data-testid')||'', type:i.type}));
    m.querySelectorAll('textarea').forEach(t=>out.areas.push({tag:'textarea', ph:t.placeholder||'', testid:t.getAttribute('data-testid')||''}));
    m.querySelectorAll('[contenteditable="true"]').forEach(e=>out.areas.push({tag:'ce', ph:e.getAttribute('data-placeholder')||e.getAttribute('aria-label')||'', testid:e.getAttribute('data-testid')||'', cls:(e.className||'').split(' ')[0]}));
    m.querySelectorAll('button').forEach(b=>out.btns.push((b.getAttribute('data-testid')||'')+'|'+(b.innerText||'').trim().slice(0,12)));
    out.btns=out.btns.filter(x=>x!=='|');
    return JSON.stringify(out);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('DIALOG:', dlg);
} finally { browser.close(); }
