import { connect } from './cdp';
const { browser, client } = await connect(9222, { tabUrl: /2099869574636490752/ });
try {
  const state = await client.eval(`(() => {
    const c = document.querySelector('[data-testid="composer"]');
    if (!c) return { error: 'no composer', url: location.href };
    const blocks = [...c.querySelectorAll('[data-block="true"]')].map((b, i) => ({
      i,
      cls: b.className,
      text: (b.innerText || '').slice(0, 160),
    }));
    return {
      url: location.href,
      textLength: (c.innerText || '').length,
      blockCount: blocks.length,
      imgCount: c.querySelectorAll('img').length,
      tail: blocks.slice(-35),
    };
  })()`);
  console.log(JSON.stringify(state, null, 2));
} finally {
  browser.close();
}
