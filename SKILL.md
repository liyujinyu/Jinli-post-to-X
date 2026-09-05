---
name: Jinli-post-to-X
description: 把一篇带封面+正文配图+代码块的 X Article 长文自动「装配」到 X 草稿箱(标题/正文/正文配图按位置插入/代码块原生格式/封面),不自动发布,留给作者手动点发布。触发词:发X长文、X Article、X正文配图、把这篇发到X、装配X草稿、Jinli发X。用 CDP + OS 级 SendKeys 驱动真实 Chrome。
---

# Jinli-post-to-X

把一篇 **带封面 + 正文配图**的 X Article 长文,自动填进 X 的草稿箱(标题、正文、按位置插入正文图、封面),**不自动发布**——作者在浏览器里核对后手动点「发布」。

独立自包含,零外部依赖(纯 Node builtins + bun + Windows PowerShell)。

## 何时用

- 把一篇 markdown 长文(封面 + 若干正文配图)装配成 X Article 草稿。
- 触发:「发X长文」「X Article」「X正文配图」「把这篇发到X」「装配X草稿」。

## 流程(两步)

### ① 准备 markdown(标准图片语法 + frontmatter)

```markdown
---
title: 文章标题
cover_image: attachments/cover.png   # 可选;或把封面图写在正文第一行也行(会自动提为封面)
---

正文第一段。**加粗**可以。

![[imgs/a.png]]        ← Obsidian wikilink,或
![](imgs/b.png)        ← 标准语法;每张图会插在它「上一段」之后

正文第二段。
```

- 图片路径:绝对 / 相对 md 所在目录 / 相对 vault 根(脚本依次找)。
- 正文图位置:脚本把每张图插在其**前一段**末尾(选中占位符 → 原子删除+粘贴替换)。
- 见 [[references/workflow.md]]「输入格式」。

### ② 装配到草稿箱

```bash
bun "${SKILL_DIR}/scripts/publish.ts" "创作输出/我的长文.md" --port 9222
```

脚本跑完会打印 **草稿 URL**(`x.com/compose/articles/edit/<id>`),**不会发布**。你在浏览器里核对图文 → 手动点「发布」。

> 运行的几分钟里,保持那个自动化 Chrome 窗口在前台(别切走)——正文配图粘贴靠 OS 级 Ctrl+V。

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `<md>` | (必填)| 文章 markdown 路径 |
| `--no-images` | 关 | 只填文字+封面,跳过正文配图 |
| `--port` | `9222` | Chrome 调试端口 |
| `--profile <dir>` | `~/.local/share/x-browser-profile` | Chrome user-data-dir(存登录态)|
| `--chrome <path>` | 自动探测 | 指定 chrome 可执行文件 |

## Script Directory

| 脚本 | 层 | 职责 |
|------|----|------|
| `${SKILL_DIR}/scripts/publish.ts` | 编排 | CLI 入口,串联全流程,停在草稿,每步打快照 |
| `${SKILL_DIR}/scripts/cdp.ts` | 稳定 | 裸 WebSocket CDP(连/eval/坐标点击/insertText/截图)|
| `${SKILL_DIR}/scripts/os-clipboard.ts` | 稳定 | OS 级:写图剪贴板 + 激活窗口(AttachThreadInput)+ SendKeys + `pasteImage`(原子删+粘)|
| `${SKILL_DIR}/scripts/markdown.ts` | 稳定 | 无依赖解析:frontmatter + 段落 + 图片/代码块占位符(首图自动提为封面)|
| `${SKILL_DIR}/scripts/package.json` | — | 无外部依赖 |

## 关键设计(改之前必读)

1. **易变/稳定分离**:X 的 selector 集中在 [[references/selectors.md]] 的 JSONC 块——`publish.ts` 启动读它,**X 改版只改这一个文件**。
2. **OS 级优先**:粘贴/删除走 PowerShell `SendKeys`(CDP 合成事件不读剪贴板、DraftJS 不认合成 paste);CDP 只管点击/坐标/insertText/DOM 查询。详见 [[references/troubleshooting.md]]「铁律」。
3. **正文配图 = 占位符 + 原子替换**:正文先把图位置写成唯一占位符 → `pasteImage(deleteFirst=true)` 在同一 PowerShell 进程里删占位符 + 粘贴图 → 图落在精确位置、无残留。从前往后顺序处理,靠占位符唯一文本定位(不依赖 block 索引)。
4. **每步可验证**:每步打印快照(img 计数/URL),失败可定位。
5. **不发布**:停在草稿,作者手动发布。

## 参考

- 完整流程 / 首次登录 / 断点续:[[references/workflow.md]]
- Selector 单点维护表:[[references/selectors.md]]
- 踩坑大全(每条带解法):[[references/troubleshooting.md]]
- 跨机器安装:[[README.md]]

## 范围边界

- **不自动发布**(作者手动)。
- 不做普通推文。
- macOS/Linux 的 OS 剪贴板未实现(`os-clipboard.ts` 留 TODO,先 Windows)。
