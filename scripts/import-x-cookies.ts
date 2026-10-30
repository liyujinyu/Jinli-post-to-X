/**
 * import-x-cookies.ts — 把日常浏览器的 X 登录态搬进自动化 profile（2026-10-30）
 *
 * 用途：自动化 profile 登录时 2FA/短信过不了，改为直接复制 auth_token + ct0。
 * Cookie 值从 ../x-cookies.txt 读取（auth_token=xxx / ct0=xxx 两行），
 * 通过 CDP Storage.setCookies 写入 https://x.com，全程不打印值。
 * 用完请删除 x-cookies.txt（脚本会自动删）。
 *
 * 前提：自动化 Chrome 在 9222 端口运行（publish.ts 会拉起，或手动：
 *   chrome.exe --user-data-dir=%USERPROFILE%/.local/share/x-browser-profile --remote-debugging-port=9222
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.ts';

const PORT = 9222;
const COOKIE_FILE = path.resolve(import.meta.dir, '..', 'x-cookies.txt');

function readCookies(): { name: string; value: string }[] {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`找不到 ${COOKIE_FILE}，请先按模板填好 auth_token 和 ct0`);
  }
  const out: { name: string; value: string }[] = [];
  for (const line of fs.readFileSync(COOKIE_FILE, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*(auth_token|ct0)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[2].trim();
    if (!value || /粘贴|替换/.test(value)) {
      throw new Error(`${m[1]} 还没填真实值（文件里还是提示文字）`);
    }
    out.push({ name: m[1], value });
  }
  const names = new Set(out.map((c) => c.name));
  for (const need of ['auth_token', 'ct0']) {
    if (!names.has(need)) throw new Error(`x-cookies.txt 里缺少 ${need}`);
  }
  return out;
}

async function main() {
  const cookies = readCookies();
  const { browser, client, tab } = await connect(PORT, {
    tabUrl: /x\.com/,
    openUrl: 'https://x.com/home',
  });

  // 浏览器级写入，无需页面会话；Secure+SameSite=None 与 X 原始 Set-Cookie 属性一致
  await browser.send('Storage.setCookies', {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: c.name === 'auth_token',
      sameSite: 'None',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    })),
  });
  console.log('[cookies] 已写入 2 个 Cookie（值不回显）');

  // 跳到首页验证登录态。注意：X 未登录会重定向到 /i/flow/login（不是 /login），
  // 且 SPA 渲染慢，判定要等足 10 秒并用侧边栏导航标志确认（2026-10-30 修正误判）
  await client.send('Page.navigate', { url: 'https://x.com/home' });
  await new Promise((r) => setTimeout(r, 10_000));

  const store = await browser.send<{ cookies: { name: string; domain: string }[] }>(
    'Storage.getCookies',
  );
  const have = store.cookies.filter((c) => c.domain.includes('x.com')).map((c) => c.name);
  const cookieOk = have.includes('auth_token') && have.includes('ct0');
  console.log(`[verify] x.com 域 Cookie：${have.length} 个，auth_token+ct0 ${cookieOk ? '齐全' : '缺失'}`);

  const kicked = await client.eval<boolean>(
    "location.pathname.includes('/flow/login') || location.pathname === '/login' || !!document.querySelector('[data-testid=\"loginButton\"]')",
  );
  const nav = await client.eval<boolean>(
    "!!document.querySelector('[data-testid=\"AppTabBar_Home_Link\"]')",
  );
  const loggedIn = cookieOk && !kicked && nav;
  console.log(loggedIn
    ? '[result] ✓ 登录态有效'
    : '[result] ✗ 仍未登录，Cookie 可能已失效（日常浏览器退出登录会让 auth_token 作废）');

  // 只有验证成功才删除敏感文件；失败保留以便重试/排查（2026-10-30 修正：失败不再误删）
  if (loggedIn) {
    try { fs.unlinkSync(COOKIE_FILE); console.log('[cleanup] 已删除 x-cookies.txt'); } catch {}
  } else {
    console.log('[cleanup] 验证未通过，保留 x-cookies.txt 供排查');
  }
  // 不关闭标签页/浏览器（唯一窗口关闭会导致整个浏览器退出，2026-10-30 修正）
  process.exit(loggedIn ? 0 : 1);
}

main();
