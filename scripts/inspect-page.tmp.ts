import { connect } from './cdp';
const { browser, client } = await connect(9222, { tabUrl: /x\.com/, openUrl: 'https://x.com/compose/articles' });
try {
  const state = await client.eval(`(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || '').slice(0, 4000),
    buttons: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => ({
      text: (b.innerText || '').trim(),
      aria: b.getAttribute('aria-label'),
      testid: b.getAttribute('data-testid')
    })).slice(0, 100)
  }))()`);
  console.log(JSON.stringify(state, null, 2));
  await client.screenshot('D:/tmp/jinli-x-current-page.png');
} finally { browser.close(); }