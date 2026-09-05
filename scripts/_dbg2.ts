import { connect, sleep } from './cdp.ts';
const { browser, client } = await connect(9222, { tabUrl: /edit/ });
try {
  // close any open menu first
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  const btns = await client.eval<any>(`(() => {
    return [...document.querySelectorAll('button, [role="button"], [aria-haspopup], [aria-expanded]')]
      .filter(e => e.offsetParent !== null && /正文|文本|块|paragraph|Body/i.test((e.innerText||'') + (e.getAttribute('aria-label')||'')))
      .map((e, i) => ({ i, txt: (e.innerText||'').trim().slice(0,20), label: e.getAttribute('aria-label')||'', haspopup: e.getAttribute('aria-haspopup'), testid: e.getAttribute('data-testid')||'', y: Math.round(e.getBoundingClientRect().y) }));
  })()`);
  console.log('candidates:', JSON.stringify(btns, null, 1));
  // also enumerate ALL toolbar buttons (top strip)
  const toolbar = await client.eval<any>(`(() => {
    return [...document.querySelectorAll('button')]
      .filter(e => e.offsetParent !== null && e.getBoundingClientRect().y < 120)
      .map(e => ({ txt: (e.innerText||'').trim().slice(0,15), label: e.getAttribute('aria-label')||'', testid: e.getAttribute('data-testid')||'' }));
  })()`);
  console.log('top toolbar:', JSON.stringify(toolbar, null, 1));
} finally { browser.close(); }
