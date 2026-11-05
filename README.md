# Jinli-post-to-X

把一篇带**封面 + 正文配图**的 markdown 长文,自动装配成 **X Article 草稿**(标题 / 正文 / 正文图按位置插入 / 封面),**不自动发布**——你在浏览器核对后手动点发布。

零外部依赖(纯 Node builtins + bun + Windows PowerShell)。用 CDP 驱动真实 Chrome,正文配图靠 OS 级 `Ctrl+V` 粘贴(绕开 DraftJS 不认合成事件的坑)。

---

## 它解决什么

X Article 编辑器是 DraftJS,程序化「粘贴图片 / 按指定位置插图」极难:CDP 合成的 Ctrl+V 不读剪贴板、合成 paste 事件 DraftJS 不认、程序设的 DOM 选区 DraftJS 不跟踪。本 skill 把验证过的可靠路径封装好:正文里放唯一占位符 → 同一个 PowerShell 进程里「删占位符 + 粘贴图」原子完成 → 图精确落位、无残留。

## 要求

- **Windows**(正文配图粘贴用 PowerShell `SendKeys`;macOS/Linux 见 `os-clipboard.ts` 的 TODO,未实现)
- **bun** ≥ 1.3(`bun.sh` 安装;或 `npm i -g bun`)
- **Google Chrome**(系统装的即可,不用下 Chromium)
- 首次需要手动登录一次 X

## 安装(另一台电脑)

1. **装 bun**:见 https://bun.sh
2. **拷贝本目录**到 Claude 的 skills 路径:
   - 给 Claude Code 用:`~/.claude/skills/Jinli-post-to-X/`
   - 或 Obsidian vault 里:`<vault>/.claude/skills/Jinli-post-to-X/`
3. **首次登录 X**(一次性):
   ```bash
   bun ~/.claude/skills/Jinli-post-to-X/scripts/publish.ts "任意一篇.md" --port 9222
   ```
   脚本会用独立 profile(`~/.local/share/x-browser-profile`)拉起 Chrome。**在弹出的窗口里手动登录 X**(账号/2FA)。登录态会持久化在这个 profile 里,之后所有运行免登录。
   - 想隔离登录态就加 `--profile <别的目录>`。

## 用法

```bash
bun <skill路径>/scripts/publish.ts "你的文章.md" --port 9222
```

跑完打印草稿 URL(`x.com/compose/articles/edit/<id>`),**不发布**。浏览器里核对 → 手动点「发布」。

> ⚠️ 运行的几分钟内,别把别的窗口切到最前——正文配图粘贴要那个 Chrome 在 OS 前台。

### 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `<md>` | 必填 | 文章 markdown |
| `--no-images` | 关 | 只填文字+封面,跳过正文配图 |
| `--legacy-inline` | 关 | 改用旧的逐块打字/工具栏管线;默认使用富文本 HTML 粘贴 |
| `--finish-only` | 关 | 对当前已有草稿仅执行收尾和审计 |
| `--port` | `9222` | Chrome 调试端口 |
| `--profile <dir>` | `~/.local/share/x-browser-profile` | Chrome profile(存登录态) |
| `--chrome <path>` | 自动探测 | chrome.exe 路径 |

## 文章 markdown 格式

```markdown
---
title: 文章标题
cover_image: path/to/cover.png   # 可选;不写的话,正文第一张图会自动当封面
---

第一段正文,**加粗**可以。

![[imgs/a.png]]        ← Obsidian wikilink 或 ![](imgs/a.png) 标准语法
```

- 图片路径:绝对 / 相对 md 目录 / 相对运行目录,依次查找。
- 每张正文图会插在它**上一段**之后。

## 目录结构

```
Jinli-post-to-X/
├── SKILL.md                # Claude skill 触发与说明
├── README.md               # 本文件(安装/用法)
├── scripts/
│   ├── publish.ts          # CLI 入口(编排,停在草稿)
│   ├── cdp.ts              # 裸 WebSocket CDP 封装
│   ├── os-clipboard.ts     # OS 级:剪贴板 + 窗口激活 + pasteImage(原子删+粘)
│   ├── markdown.ts         # 无依赖 markdown 解析
│   └── package.json        # 零依赖
└── references/
    ├── selectors.md        # X UI selector 单点维护(JSONC,publish.ts 启动读它)
    ├── workflow.md         # 完整流程 / 首次登录 / 断点续
    └── troubleshooting.md  # 踩坑大全(每条带验证过的解法)
```

## X 改版了怎么办

selector 失效 → 只改 `references/selectors.md` 里的 JSONC 坑,publish.ts 启动时自动读取,**不用改代码**。

## 已知限制

- **不自动发布**(作者手动点发布)。
- 只测过 **Windows + 中文 X UI**。selector 表里附了英/日/韩占位。
- macOS/Linux 的 OS 剪贴板未实现(代码里有 TODO)。
- 正文配图粘贴依赖 OS 前台焦点:运行时别切走那个 Chrome 窗口。

## 致谢

方法源自一次 40+ 轮 CDP 实操磕通的发布过程,详见 `references/troubleshooting.md`。
