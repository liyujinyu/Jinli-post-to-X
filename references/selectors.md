# X Article 编辑器 Selector 表（易变层 · 单点维护）

> **这是 selector 的唯一来源**。`scripts/publish.ts` 启动时会读取本文件里第一个
> ` ```jsonc ` 代码块并解析；**X 改版时只改本文件的 JSON**，脚本自动生效。
> 解析失败时脚本回退到 `publish.ts` 里的 `DEFAULT_SELECTORS`，所以编辑本文件不会让脚本静默崩。

当前 X（中文 UI）Article 编辑器实测可用值如下。每个数组按优先级从高到低排列（脚本取第一个命中的）。

```jsonc
{
  // 标题输入框：DraftJS 之外的独立 textarea。中文 locale 实测命中第一个。
  "titleInput": [
    "textarea[placeholder=\"添加标题\"]",
    "textarea[placeholder=\"Add a title\"]",
    "textarea[placeholder=\"タイトルを追加\"]",
    "textarea[placeholder=\"제목 추가\"]",
    "textarea[name=\"Article Title\"]"
  ],

  // 正文编辑器（DraftJS 容器）——填正文、插图、计数的根
  "composer": "[data-testid=\"composer\"]",

  // DraftJS 内容根与块节点（用于 TreeWalker 定位段末）
  "contentRoot": "[data-contents=\"true\"]",
  "block": "[data-block=\"true\"]",
  "contentEditable": "[contenteditable=\"true\"]",

  // 文章列表页的"Write / 写文章"按钮（进入编辑器）
  "emptyStateWrite": "[data-testid=\"empty_state_button_text\"]",

  // 封面"添加照片或视频"按钮（封面专用，走裁剪流程；区别于"添加媒体内容"）
  "coverButton": [
    "[aria-label=\"添加照片或视频\"]",
    "[aria-label=\"Add photos or video\"]",
    "[aria-label=\"写真や動画を追加\"]"
  ],

  // 封面上传走的隐藏 file input（DOM.setFileInputFiles 写入，无需 OS 级）
  "fileInput": "input[data-testid=\"fileInput\"]",

  // 封面裁剪后的"应用 / Apply"按钮
  "applyButton": "[data-testid=\"applyButton\"]",

  // 正文配图计数选择器（验证插图成功）
  "composerImages": "[data-testid=\"composer\"] img",

  // 工具栏引号（blockquote）按钮候选；都 miss 时脚本还会按 aria-label
  // /引用|引用文|blockquote|quote/i 兜底查找
  "quoteButton": [
    "[data-testid=\"btn-block-quote\"]",
    "[data-testid=\"btn-quote\"]"
  ],

  // 发布按钮的可选可见文本（toolbar 与 confirm dialog 复用）
  "publishText": ["发布", "Publish", "公開", "게시"]
}
```

## 常见改版信号（出现即来本表改）

| 现象 | 多半是 | 改哪里 |
|------|--------|--------|
| `Editor not found` / 标题填不上 | `titleInput` placeholder 文案变了 | `titleInput` |
| 正文计数 `imgs=-1` 或定位失败 | composer testid 改名 | `composer` / `contentRoot` / `block` |
| 封面传完没 apply 按钮 | `applyButton` testid 改名 | `applyButton` |
| 点发布没反应 | 发布按钮文案/结构变 | `publishText` |

## 注意：不要启用的相关能力

- 不要开 `Page.setInterceptFilesAllowed`——会让 `applyButton` 不出现（见 troubleshooting.md）。
- "添加媒体内容"按钮（`aria-label="添加媒体内容"`）**不要用来插正文图**：它实际走封面裁剪流程。正文图只走 OS 级粘贴。
