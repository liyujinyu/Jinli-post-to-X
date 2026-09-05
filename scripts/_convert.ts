import { connect, sleep } from './cdp.ts';
import { deleteSelection, sendKeys } from './os-clipboard.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
const PREP = `(() => { try {
  const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
  const b=bs.find(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').trim());
  if(!b) return 'DONE';
  b.scrollIntoView({block:'center'});
  const t=b.innerText;
  window.__ct=t;
  let lang='text';
  if(/^host:|api-keys:|port:|proxy-url:|remote-management|generated-code-file/m.test(t)) lang='yaml';
  else if(/^irm |Get-FileHash|Get-NetTCPConnection|Invoke-RestMethod|conhost|^\$headers/m.test(t)) lang='powershell';
  window.__lang=lang;
  const walker=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);
  const tn=walker.nextNode();
  const rg=document.createRange();
  if(tn){ rg.setStart(tn,1); rg.setEnd(tn,Math.min(tn.length, Math.max(2,tn.length))); } else rg.selectNodeContents(b);
  const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
  b.closest('[contenteditable="true"]').focus();
  return 'PREP|'+lang+'|'+t.split(String.fromCharCode(10))[0].slice(0,25);
} catch(e){return 'ERR:'+e.message} })()`;
try {
  for (let it = 1; it <= 20; it++) {
    const prep = await client.eval<any>(PREP);
    if (prep === 'DONE') { console.log('all quotes converted at iter', it); break; }
    console.log(`[${it}]`, prep);
    if (typeof prep !== 'string' || !prep.startsWith('PREP')) { console.log('abort: prep failed'); break; }
    await sleep(450);
    // open Insert menu
    let r = await client.eval<any>(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入'); if(!b) return 'NOBTN'; b.click(); return 'OK'; })()`);
    await sleep(800);
    r = await client.eval<any>(`(() => { const items=[...document.querySelectorAll('[role="menuitem"], [role="option"]')];
      const m=items.find(x=>(x.innerText||'').trim()==='代码'); if(!m) return 'NOMENU'; m.click(); return 'OK'; })()`);
    if (r !== 'OK') { console.log('  abort: menu', r); break; }
    // wait for dialog textarea
    let dlg = '';
    for (let w = 0; w < 10; w++) { await sleep(300);
      dlg = await client.eval<any>(`document.querySelector('[role="dialog"] textarea') ? 'READY' : 'WAIT'`);
      if (dlg === 'READY') break; }
    if (dlg !== 'READY') { console.log('  abort: dialog'); break; }
    // fill
    await client.eval<any>(`(() => { const m=document.querySelector('[role="dialog"]');
      const ta=m.querySelector('textarea');
      const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      set.call(ta, window.__ct); ta.dispatchEvent(new Event('input',{bubbles:true}));
      const li=m.querySelector('input[data-testid="programming-language-input"]');
      if(li){ const s2=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s2.call(li, window.__lang||'text'); li.dispatchEvent(new Event('input',{bubbles:true})); }
      return 1; })()`);
    await sleep(500);
    r = await client.eval<any>(`(() => { const m=document.querySelector('[role="dialog"]'); if(!m) return 'NODLG';
      const b=[...m.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='插入'); if(!b) return 'NOBTN'; b.click(); return 'OK'; })()`);
    if (r !== 'OK') { console.log('  abort: insert btn', r); break; }
    await sleep(1500);
    // clear old quote block text
    r = await client.eval<any>(`(() => { try { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const b=bs.find(x=>((x.className||'')).includes('blockquote') && (x.innerText||'').trim());
      if(!b) return 'GONE';
      const rg=document.createRange(); rg.selectNodeContents(b);
      const s=window.getSelection(); s.removeAllRanges(); s.addRange(rg);
      b.closest('[contenteditable="true"]').focus();
      return s.toString().length>0?'HELD':'EMPTY';
    } catch(e){return 'ERR:'+e.message} })()`);
    if (r === 'GONE') { console.log('  quote already gone'); continue; }
    await sleep(450); await client.bringToFront(); await sleep(250);
    await deleteSelection(1, 'x-browser-profile');
    await sleep(1200);
    // backspace empty quote → unstyled
    r = await client.eval<any>(`(() => { const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
      const i=bs.findIndex(x=>((x.className||'')).includes('blockquote'));
      if(i<0) return 'GONE';
      const b=bs[i]; const rg=document.createRange(); rg.selectNodeContents(b); rg.collapse(true);
      const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
      b.closest('[contenteditable="true"]').focus(); return 'CARET'; })()`);
    if (r === 'CARET') {
      await sleep(400); await client.bringToFront(); await sleep(250);
      await sendKeys('{BS}', 'x-browser-profile');
      await sleep(1300);
    }
    const v = await client.eval<any>(`JSON.stringify({
      quotes:[...document.querySelectorAll('${C} [data-block="true"]')].filter(x=>((x.className||'')).includes('blockquote')).length,
      total:[...document.querySelectorAll('${C} [data-block="true"]')].length})`);
    console.log('  →', v);
  }
  // final state
  const fin = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    return JSON.stringify({total:bs.length,
      quotes:bs.filter(x=>((x.className||'')).includes('blockquote')).length,
      cards:bs.filter(x=>x.querySelector('button[aria-label="编辑块"]')).length,
      imgs:bs.filter(x=>x.querySelector('img')).length});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('FINAL:', fin);
} finally { browser.close(); }
