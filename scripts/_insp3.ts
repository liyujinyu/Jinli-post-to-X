import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  // any element with text 插入 anywhere
  const hit = await client.eval<any>(`(() => { try {
    const out=[];
    document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menu"], div[aria-haspopup]').forEach(el=>{
      const t=(el.innerText||'').trim();
      if(t && t.length<30 && (t.includes('插入')||t.includes('代码'))) out.push(el.tagName+'|'+(el.getAttribute('data-testid')||'')+'|'+t);
    });
    // also: elements whose aria-label mentions insert/code
    document.querySelectorAll('[aria-label]').forEach(el=>{
      const a=el.getAttribute('aria-label')||'';
      if(/插入|insert|code|代码/i.test(a)) out.push(el.tagName+'|AL|'+a);
    });
    return JSON.stringify([...new Set(out)]);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('INSERT-HITS:', hit);
  // hover over a paragraph gutter to reveal floating controls (+ icon)
  const hover = await client.eval<any>(`(() => { try {
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const b=bs.find(x=>((x.className||'')).includes('unstyled') && (x.innerText||'').includes('实际链路'));
    if(!b) return 'NOBLOCK';
    b.scrollIntoView({block:'center'});
    const r=b.getBoundingClientRect();
    // dispatch mouseover/mousemove at left gutter
    const opts={bubbles:true, clientX:r.left-30, clientY:r.top+10, view:window};
    b.dispatchEvent(new MouseEvent('mouseover',opts));
    b.dispatchEvent(new MouseEvent('mousemove',opts));
    b.parentElement.dispatchEvent(new MouseEvent('mouseover',opts));
    return 'HOVERED';
  } catch(e){return 'ERR:'+e.message} })()`);
  await sleep(900);
  const reveal = await client.eval<any>(`(() => { try {
    // any newly visible buttons near composer (all buttons in main area)
    const out=[];
    document.querySelectorAll('button').forEach(b=>{
      const t=(b.innerText||'').trim(); const tid=b.getAttribute('data-testid')||'';
      if(t.length<15 && t) out.push(tid+'|'+t);
      else if(tid && !['btn-bold','btn-italic','btn-strikethrough','btn-blockquote','btn-ul','btn-ol','btn-link','btn-emoji'].includes(tid)) out.push(tid+'|'+(b.getAttribute('aria-label')||''));
    });
    return JSON.stringify([...new Set(out)]);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('AFTER-HOVER BUTTONS:', reveal);
} finally { browser.close(); }
