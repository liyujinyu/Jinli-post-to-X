/** _inspect.ts — temporary: dump the draft's code-block DOM state via CDP. */
import { connect, sleep } from './cdp.ts';

const { browser, client } = await connect(9222, {
  tabUrl: /compose\/articles\/edit/,
});

try {
  const info = await client.eval<any>(`(() => {
    const c = document.querySelector('[data-testid="composer"]');
    if (!c) return { err: 'no composer' };
    const blocks = [...c.querySelectorAll('[data-block="true"]')];
    // Find blocks that contain known code content
    const pick = (needle) => blocks.filter(b => (b.innerText||'').includes(needle)).map(b => ({
      cls: b.className,
      tag: b.tagName,
      text: (b.innerText||'').slice(0, 120),
      html: b.outerHTML.slice(0, 300),
    }));
    // Any code/pre elements at all?
    const pre = [...c.querySelectorAll('pre, code, [class*="code" i], [data-testid*="code" i]')].map(e => ({
      tag: e.tagName, cls: e.className, text: (e.textContent||'').slice(0,80),
    }));
    // Scan for weird / undisplayable chars in the whole composer text
    const all = c.innerText || '';
    const weird = {};
    for (const ch of all) {
      const cp = ch.codePointAt(0);
      const bad = (cp < 32 && cp !== 10) || cp === 0xfffd || (cp >= 0xe000 && cp <= 0xf8ff);
      if (bad) weird[ch + '(U+' + cp.toString(16) + ')'] = (weird[ch + '(U+' + cp.toString(16) + ')'] || 0) + 1;
    }
    return {
      totalBlocks: blocks.length,
      hostBlocks: pick('127.0.0.1'),
      yamlBlocks: pick('remote-management'),
      hashBlocks: pick('E032EE60'),
      preLike: pre.slice(0, 5),
      weirdChars: weird,
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await sleep(300);
} finally {
  browser.close();
}
