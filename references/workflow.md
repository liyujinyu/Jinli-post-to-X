# 完整流程 · 首次登录 · profile 机制 · 断点续

## 三步极简（日常用）

1. **准备 markdown**：标准图片语法 + frontmatter（见下「输入格式」）。
2. **确保 X 已登录**：端口 9222 上有活的 Chrome（见「首次登录」），或脚本自动拉起登录过的 profile。
3. **装配到草稿箱**：
   ```bash
   bun "${SKILL_DIR}/scripts/publish.ts" "创作输出/我的长文.md" --port 9222
   ```
   脚本填好标题/正文/正文图/封面后**停在草稿**，打印草稿 URL，**不发布**。你在浏览器核对 → 手动点「发布」。

> 运行时保持那个 Chrome 窗口在前台别切走（正文图粘贴靠 OS 级 Ctrl+V）。

## 输入格式（publish-ready markdown）

```markdown
---
title: 文章标题（必填）
cover_image: attachments/cover.png   # 可选；不写则正文第一张图自动当封面
---

# 可选 H1（脚本会跳过第一个标题行，标题以 frontmatter 为准）

正文第一段，**加粗**可以。

![[imgs/a.png]]        ← Obsidian wikilink 图，或
![](imgs/b.png)        ← 标准语法图；每张图会插在它"上一段"的后面

正文第二段。
```

- 图片路径：绝对路径 / 相对 md 所在目录 / 相对 vault 根（脚本依次找）。
- 正文图位置：脚本把每张图插在其**前一段**之后——正文里先放唯一占位符，再 `pasteImage(deleteFirst=true)` 原子「删占位符 + 粘贴图」（见 troubleshooting §2.3）。

## 命令行参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `<md>` | （必填）| 文章 markdown 路径 |
| `--no-images` | 关 | 只填文字+封面，跳过正文配图 |
| `--port` | `9222` | Chrome 调试端口 |
| `--profile <dir>` | `~/.local/share/x-browser-profile` | Chrome user-data-dir（存登录态）|
| `--chrome <path>` | 自动探测 | 指定 chrome 可执行文件 |

## 首次登录（一次性）

1. 任选一个专用 profile 目录，例如 `~/.local/share/x-browser-profile`。
2. 跑一次：
   ```bash
   bun "${SKILL_DIR}/scripts/publish.ts" "某篇.md" --port 9222 --profile ~/.local/share/x-browser-profile
   ```
   脚本会拉起 Chrome；**在弹出的窗口里手动登录 X**（账号密码 / 2FA）。
3. 登录后 cookie 落在 profile 里，**之后所有运行免登录**（只要 profile 不删、端口不换）。

> 本脚本默认 profile 就用 `x-browser-profile`（与 baoyu 的 x-browser 共享登录态，省一次登录）。想隔离就 `--profile` 指别的目录。

## 复用实例机制

- 启动时先 `http://127.0.0.1:<port>/json/version` 探测；活着就直接连（`connect()`）。
- 没活就 spawn Chrome（带 `--remote-debugging-port` + `--user-data-dir`），并手写 `DevToolsActivePort` 文件（Chrome 在 Windows 上不自动写，见 troubleshooting §5.1）。
- 连上后：取/建 x.com 的 tab → `Target.attachToTarget` flatten → enable Page/Runtime/DOM → 返回 session-scoped client。

## 断点续

- 主脚本每个 step 都打印 before/after 快照（`url / imgs / title`），失败可一眼看到卡在哪步。
- 失败后**重跑同一命令**即可（每次新建草稿；无需手动清理上次半成品）。
- 想核对当前页面：临时在脚本里加 `await client.screenshot('D:/shot.png')`。
- selector 失效 → 只改 `references/selectors.md` 的 JSON，重跑（无需改代码）。

## 与其它流程的边界（不做）

- **普通推文**：走 baoyu 的 `x-browser`，本 skill 不碰。
- **macOS/Linux 的 OS 剪贴板**：`os-clipboard.ts` 已留接口与 TODO，未验证前不实现。
- **不修改原 `baoyu-post-to-x`**：本 skill 完全独立自包含。
