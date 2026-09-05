import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /compose\/articles\/edit\/2096095610722283520/ });
const C = '[data-testid="composer"]';
try {
  const r = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const card=bs.find(b=>b.querySelector('button[aria-label="编辑块"]') && (b.innerText||'').includes('-config'));
    // dump text lines + any small label elements
    const lines=(card.innerText||'').split(NL).slice(0,4);
    return JSON.stringify({lines});
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('card text:', r);
  // full-block order dump for final verification
  const dump = await client.eval<any>(`(() => { try { const NL=String.fromCharCode(10);
    const bs=[...document.querySelectorAll('${C} [data-block="true"]')];
    const out=[];
    bs.forEach((b,i)=>{
      const c=(b.className||'').split(' ')[0]||'-';
      const t=(b.innerText||'').trim();
      if(b.querySelector('img')) out.push(i+1+':IMG');
      else if(b.querySelector('button[aria-label="编辑块"]')) out.push(i+1+':CODE|'+t.split(NL)[0].slice(0,22));
      else if(c.includes('header-one')) out.push(i+1+':H1|'+t.slice(0,16));
      else if(c.includes('header-two')) out.push(i+1+':H2|'+t.slice(0,16));
      else if(c.includes('unordered')) out.push(i+1+':UL|'+t.slice(0,14));
      else if(c.includes('ordered')) out.push(i+1+':OL|'+t.slice(0,14));
      else if(!t) out.push(i+1+':(blank)');
    });
    return JSON.stringify(out);
  } catch(e){return 'ERR:'+e.message} })()`);
  console.log('ORDER:', dump);
} finally { browser.close(); }
