/**
 * audit.ts — 终审校验(final review)模块。
 *
 * 装配完成后,把草稿 DOM 与源 markdown 解析结果逐项比对,输出 PASS/FAIL 报告。
 * 这是发布前的最后一道闸门:任何错块、丢块、残留 token、链接缺失都会在这里
 * 被点名,而不是等作者肉眼在预览里发现。
 *
 * 两种用法:
 *   1. 被 publish.ts 调用:auditDraft(client, article, composerSelector)
 *   2. 单独运行(修补已有草稿后复检):bun audit.ts <article.md> [draftUrlFragment]
 *      例:bun audit.ts "创作输出/xxx/xxx.md" 2096095610722283520
 *
 * 校验项(全部来自 2026-09-05 在真实草稿上验证过的 DOM 事实):
 *   - 残留占位 token(composer 内不得出现 XAP-)
 *   - 标题已填且与 frontmatter 一致
 *   - 块类型计数:H1/H2/UL/OL/CODE 卡片/图片/段落
 *   - 块顺序:期望 kind 序列 vs 实际序列逐项比对(空行/伪块忽略),含文本抽查
 *   - 链接:每个 markdown 链接 URL 都有对应 <a href>
 */

import { connect } from './cdp.ts';
import { parseArticle, type Block, type ParsedArticle } from './markdown.ts';

export type AuditIssue = { check: string; detail: string };
export type AuditReport = {
  pass: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  issues: AuditIssue[];
};

type DomBlock = { kind: string; text: string };

/** markdown block → expected DOM kind(## → H1 标题,≥### → H2 副标题)。 */
function expectedKind(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return b.level <= 2 ? 'H1' : 'H2';
    case 'listitem':
      return b.ordered ? 'OL' : 'UL';
    case 'code':
      return 'CODE';
    case 'image':
      return 'IMG';
    default:
      return 'P';
  }
}

/** 页内执行:把 composer 的每个块映射为 kind + 文本(空行/伪块返回 null 忽略)。 */
function dumpExpr(composer: string): string {
  return `(() => { try {
    const NL = String.fromCharCode(10);
    const c = document.querySelector(${JSON.stringify(composer)});
    if (!c) return JSON.stringify({ error: 'NO_COMPOSER' });
    const out = [];
    for (const b of c.querySelectorAll('[data-block="true"]')) {
      let kind = null;
      if (b.querySelector('img')) kind = 'IMG';
      else if (b.querySelector('button[aria-label="编辑块"]')) kind = 'CODE';
      else {
        const cls = b.className || '';
        if (cls.includes('header-one')) kind = 'H1';
        else if (cls.includes('header-two')) kind = 'H2';
        else if (cls.includes('unordered-list-item')) kind = 'UL';
        else if (cls.includes('ordered-list-item')) kind = 'OL';
        else if ((b.innerText || '').trim()) kind = 'P';
      }
      if (kind) out.push({ kind, text: (b.innerText || '').trim().split(NL).join(' ') });
    }
    const anchors = [...c.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
    return JSON.stringify({ blocks: out, anchors, error: null });
  } catch (e) { return JSON.stringify({ error: 'ERR:' + e.message }); } })()`;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '').slice(0, 12);
}

/** 核心校验:期望(markdown 解析)vs 实际(草稿 DOM)。 */
export async function auditDraft(
  client: any,
  article: ParsedArticle,
  composer = '[data-testid="composer"]',
  titleSelector = 'textarea[placeholder="添加标题"]',
): Promise<AuditReport> {
  const checks: AuditReport['checks'] = [];
  const issues: AuditIssue[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) issues.push({ check: name, detail });
  };

  const raw = await client.eval<any>(dumpExpr(composer));
  let dom: { blocks: DomBlock[]; anchors: string[] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error) throw new Error(parsed.error);
    dom = parsed;
  } catch (e) {
    add('DOM dump', false, `无法读取草稿块: ${(e as Error).message}`);
    return { pass: false, checks, issues };
  }

  // 1. 残留 token
  const leftover = dom.blocks.filter(b => /XAP-/.test(b.text));
  add(
    '无残留占位 token',
    leftover.length === 0,
    leftover.length ? `${leftover.length} 处残留: ${leftover.map(b => b.text.slice(0, 30)).join(' / ')}` : 'composer 内无 XAP-',
  );

  // 2. 标题
  const titleVal = await client.eval<string>(
    `(() => { const t = document.querySelector(${JSON.stringify(titleSelector)});
       return t ? (t.value || '') : ''; })()`,
  );
  add('标题', !!titleVal && titleVal.trim() === article.title.trim(),
    titleVal ? `已填: ${titleVal.slice(0, 30)}` : '标题为空');

  // 3. 计数
  const expected = article.blocks.map(expectedKind);
  const count = (arr: string[], k: string) => arr.filter(x => x === k).length;
  const actual = dom.blocks.map(b => b.kind);
  for (const k of ['H1', 'H2', 'UL', 'OL', 'CODE', 'IMG', 'P']) {
    const e = count(expected, k), a = count(actual, k);
    add(`数量 ${k}`, e === a, `期望 ${e} / 实际 ${a}`);
  }

  // 4. 顺序逐项比对 + 文本抽查
  if (expected.length === actual.length) {
    let mismatches = 0;
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) {
        mismatches++;
        if (mismatches <= 5) {
          add(`顺序 #${i + 1}`, false,
            `期望 ${expected[i]}("${article.blocks[i].kind === 'image' ? (article.blocks[i] as any).path.split(/[\\/]/).pop() : ('text' in article.blocks[i] ? String(article.blocks[i].text).slice(0, 15) : '')}") 实际 ${actual[i]}("${dom.blocks[i].text.slice(0, 15)}")`);
        }
      }
    }
    if (mismatches === 0) add('块顺序', true, `${expected.length} 个内容块顺序与原文完全一致`);
    else add('块顺序(汇总)', false, `${mismatches} 处类型错位(共 ${expected.length} 块)`);

    // 文本抽查:段落/标题/列表首 12 个归一化字符
    let textBad = 0;
    for (let i = 0; i < article.blocks.length; i++) {
      const b = article.blocks[i];
      if (b.kind === 'image' || b.kind === 'code') continue;
      const want = normalize(b.text);
      if (want && normalize(dom.blocks[i].text) !== want) {
        textBad++;
        if (textBad <= 5) add(`文本 #${i + 1}`, false,
          `期望 "${b.text.slice(0, 18)}" 实际 "${dom.blocks[i].text.slice(0, 18)}"`);
      }
    }
    if (textBad === 0) add('文本抽查', true, '段落/标题/列表文本逐块一致');
  }

  // 5. 链接
  const wantUrls = new Set<string>();
  for (const b of article.blocks) if (b.kind === 'paragraph') {
    for (const r of b.runs) if (r.url) wantUrls.add(r.url);
  }
  const missing = [...wantUrls].filter(u => !dom.anchors.some(a => a === u || (a || '').includes(u)));
  add('链接', missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : `${wantUrls.size} 个链接全部就位`);

  return { pass: issues.length === 0, checks, issues };
}

export function printReport(r: AuditReport): void {
  console.log(`\n=== 终审校验 (${r.pass ? '✅ 全部通过' : `❌ ${r.issues.length} 项问题`}) ===`);
  for (const c of r.checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }
}

// ---------------------------------------------------------------------------
// Standalone: bun audit.ts <article.md> [draftUrlFragment]
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const [, , mdPath, urlFrag] = process.argv;
  if (!mdPath) {
    console.error('Usage: bun audit.ts <article.md> [draftUrlFragment]');
    process.exit(1);
  }
  const article = parseArticle(mdPath);
  const tabUrl = urlFrag ? new RegExp(urlFrag) : /compose\/articles\/edit\//;
  const { browser, client } = await connect(9222, { tabUrl });
  try {
    const r = await auditDraft(client, article);
    printReport(r);
    process.exitCode = r.pass ? 0 : 2;
  } finally {
    browser.close();
  }
}
