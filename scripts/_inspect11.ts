import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /x\.com/ });
try {
  await client.navigate('https://x.com/compose/articles/edit/2096067013068181505');
  await sleep(4000);
  // Method 1: set caret at start of the host: block, type "> "
  const prep = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const t = blocks.find(b => (b.innerText||'').startsWith('host: "127.0.0.1"'));
    if (!t) return {ok:false, n: blocks.length};
    t.scrollIntoView({block:'center'});
    const span = t.querySelector('[data-text="true"]');
    if (!span?.firstChild) return {ok:false, why:'no span'};
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, 0);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const ce = document.querySelector('[data-testid="composer"] [contenteditable="true"]');
    if (ce) ce.focus();
    return {ok:true};
  })()`);
  console.log('prep:', JSON.stringify(prep));
  await sleep(400);
  await client.insertText('> ');
  await sleep(700);
  const after = await client.eval<any>(`(() => {
    const blocks = [...document.querySelectorAll('[data-testid="composer"] [data-block="true"]')];
    const t = blocks.find(b => (b.innerText||'').includes('host: "127.0.0.1"'));
    return t ? {cls: t.className, txt: (t.innerText||'').slice(0,50)} : null;
  })()`);
  console.log('after "> ":', JSON.stringify(after));
} finally { browser.close(); }
