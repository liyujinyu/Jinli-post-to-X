import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  for (let round = 0; round < 2; round++) {
    // find a code card containing '-config' whose language is not powershell — click its 编辑块
    const r = await client.eval<any>(`(() => { try {
      const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const card=bs.find(b=>b.querySelector('button[aria-label="编辑块"]') && (b.innerText||'').includes('-config'));
      if(!card) return 'NOCARD';
      card.scrollIntoView({block:'center'});
      const btn=card.querySelector('button[aria-label="编辑块"]');
      btn.click(); return 'EDIT-OPENED';
    } catch(e){return 'ERR:'+e.message} })()`);
    console.log('round', round, ':', r);
    if (r !== 'EDIT-OPENED') break;
    let dlg = '';
    for (let w = 0; w < 10; w++) { await sleep(300);
      dlg = await client.eval<any>(`document.querySelector('[role="dialog"] input[data-testid="programming-language-input"]') ? 'READY' : 'WAIT'`);
      if (dlg === 'READY') break; }
    if (dlg !== 'READY') { console.log('  no dialog'); break; }
    const cur = await client.eval<any>(`document.querySelector('[role="dialog"] input[data-testid="programming-language-input"]').value`);
    console.log('  current lang:', JSON.stringify(cur));
    if (cur === 'powershell') { // just close
      await client.eval<any>(`(() => { const m=document.querySelector('[role="dialog"]');
        const b=m.querySelector('[data-testid="app-bar-close"]'); if(b) b.click(); return 'CLOSED'; })()`);
      await sleep(800); continue;
    }
    await client.eval<any>(`(() => { const li=document.querySelector('[role="dialog"] input[data-testid="programming-language-input"]');
      const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      s.call(li,'powershell'); li.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
    await sleep(500);
    await client.eval<any>(`(() => { const m=document.querySelector('[role="dialog"]');
      const b=[...m.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入'); if(b) b.click(); return 1; })()`);
    await sleep(1500);
  }
  const fin = await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    return JSON.stringify({cards:bs.filter(x=>x.querySelector('button[aria-label="编辑块"]')).length,
      dlgOpen:!!document.querySelector('[role="dialog"]')}); })()`);
  console.log('FINAL:', fin);
} finally { browser.close(); }
