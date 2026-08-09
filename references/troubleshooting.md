# 踩坑大全（本次 40+ 轮 CDP 实操血泪，每条都带验证过的解法）

> 阅读顺序：先看「铁律」一节，它决定了整个脚本的架构。下面每条都是真实踩过的坑。

## 一、铁律：CDP 合成事件不可靠，OS 级才管用

DraftJS（X 正文用的富文本内核）对 CDP 合成的键盘事件基本无响应，且合成 Ctrl+V **不读系统剪贴板**。这张表是架构基石：

| 操作 | CDP 合成（❌ 不可靠） | OS 级 SendKeys（✅ 可靠） |
|------|------|------|
| 粘贴图片 | `Input.dispatchKeyEvent` Ctrl+V → **不读剪贴板，失败** | PowerShell `SendKeys '^v'` → **成功** |
| 点击按钮 | `.click()` → React 上不可靠；`Input.dispatchMouseEvent` 坐标点击 → ✅ 可用 | — |
| 输入文字 | `Input.insertText` → **可用**（正文逐段、删占位符都靠它）| — |
| 删除文字/占位符 | `Input.insertText('')` 替换选区 → **可用** | — |

→ 架构后果：**粘贴走 `os-clipboard.ts`（OS 级）；点击/坐标/文字/DOM 查询走 `cdp.ts`（CDP）。**

## 二、正文配图（最硬的骨头 —— 最终验证可用法）

### 2.0 总策略：先填完整正文(图片位置放占位符)→ 再逐个选中占位符 → OS 粘贴替换 → 删占位符文字

`markdown.ts` 把每张图解析成一个**唯一占位符** `XAP-IMG-<n>-PLACEHOLDER`，作为独立段落写进正文（`fillBody` 一次性把整篇文章文字 + 占位符全填完）。然后 `insertImages` 对每个占位符：

1. **选中占位符文字**（DOM Selection + TreeWalker 找 token 文本节点 → `range.setStart/setEnd` 覆盖 token → `getSelection().addRange`）。
2. **OS 级粘贴**：`Page.bringToFront` + PowerShell `Clipboard.SetImage` + `SendKeys '^v'`。图就落在占位符位置。
3. **删掉残留占位符文字**：DraftJS 粘贴图是「**插在选区旁边**，不替换选区」，所以 token 文字还在。用 **CDP `insertText('')`**（替换选区为空）删掉它。

### 2.1 为什么是「选中 token + 粘贴」，不是「定位光标 + 粘贴」

- ❌ 用坐标点击定位光标：`activeElement` 离开 composer / DraftJS 不认程序设的 DOM 选区 → 粘贴落空或错位。
- ❌ 用「上一段全文当锚点」在 DOM 里找回那段：DraftJS 把加粗拆 span、normalize 不一致 → 匹配漂移、图错位。
- ✅ **token 是唯一精确字符串**，TreeWalker 一次命中唯一位置，选中它再粘贴，图位置天然 = 作者在 markdown 里放图的位置。

### 2.2 窗口前台必须可靠（多 Chrome 窗口时）

- ❌ `AppActivate('Google Chrome')` 按标题匹配 —— 你日常 Chrome 也开着时，键发到错的窗口，图进不去（表现为 0 张）。
- ✅ `os-clipboard.ts` 的 `activateAndSendKeysWindows`：按 **profile 目录名**(如 `x-browser-profile`)在 `chrome.exe` 命令行里匹配我们的窗口 → 拿 `MainWindowHandle` → **`AttachThreadInput` + `SetForegroundWindow`** 强制前台（绕过 Windows 前台锁）→ `SendKeys '^v'`。
- 经验证：这套激活能把键送进 composer（发字母 `ZQ` 能打进去）。键能进、剪贴板有图，Ctrl+V 才成。

### 2.3 删占位符 + 粘贴必须「原子化」(同一 PowerShell 进程)

- DraftJS 粘贴图是「插在选区**旁边**」,不替换选区 → token 文字会残留。
- ❌ 分两步:「粘贴」后再单独删 token —— `insertText('')` 在新版 Chrome 上是 no-op(没真删,占位符漏到发布稿里);OS `{DELETE}` 单独发又会把空块和图块合并、带歪下一张图。
- ✅ **`pasteImage(path, marker, deleteFirst=true)`** —— 同一个 PowerShell STA 进程里:激活窗口 → `{DELETE}` 删掉选中的 token → `Clipboard.SetImage` → `^v` 粘贴。删与粘之间无进程边界、无焦点空隙,token 被删、图落在原位,且后续 token 靠唯一文本重新选中不受块漂移影响。验证:token 三种查法全 0、4 图位置全对、无多余空块。

### 2.4 首张图首次粘贴要「预热」

- 第一张图的第一次粘贴偶发不出图（剪贴板冷启动 / 焦点未稳）→ 触发重试 → **重试会让落点偏**。
- ✅ `insertImages` 里首张图 `bringToFront` 后多等(600ms)、`copyImage` 后多等(500ms)再粘贴。验证：4 张全部首次粘贴成功、无重试 = 位置全对。

### 2.5 DraftJS 不认合成 paste 事件

- ❌ `new ClipboardEvent('paste', {clipboardData: dt})` 派发：DraftJS 检查 `isTrusted`，合成事件被忽略（图不进）。CDP `dispatchKeyEvent` 也一样不触发真实 paste。
- ✅ 只有 OS 级真实 Ctrl+V 才产生 trusted paste。

## 三、封面（比正文图简单）

- ✅ 点"添加照片或视频"按钮 → `DOM.setFileInputFiles` 写 `input[data-testid="fileInput"]` → 等 `applyButton` → 点击。
- 封面**不需要 OS 级粘贴**，`setFileInputFiles` 直接有效。
- ⚠️ **不要开 `Page.setInterceptFilesAllowed`**：开了之后 `applyButton` 不出现（实测踩坑）。
- ⚠️ 区分按钮：「添加照片或视频」= 封面；「添加媒体内容」**看似插正文图，实际走封面裁剪流程**，不要用它插正文图。

## 四、发布（已改为手动）

- 本 skill **不自动发布**：填好标题/正文/正文图/封面后停在草稿，打印草稿 URL，作者在浏览器核对后手动点「发布」。
- 历史经验（如以后要恢复自动发布可参考）：React 按钮必须真实坐标点击（`Input.dispatchMouseEvent`）；流程 ① 点顶部"发布"弹 confirm 对话框 → ② 点**对话框内** `[role="dialog"]` 里的"发布"（不能全局取最后一个，会点错）→ ③ 等 URL 跳 `status/<id>`。`clickTextButton({scopeSelector:'[role="dialog"]'})` 已封装这步。

## 五、Chrome 实例 / 端口

### 5.1 Chrome 在 Windows 上不写 DevToolsActivePort

- 现象：明明端口活着，读 `DevToolsActivePort` 文件却读不到，脚本以为没实例就再启一个。
- ✅ 本脚本用 `http://127.0.0.1:<port>/json/version` 直接探测端口（`isPortLive`），**不依赖该文件**；启动新实例后还顺手写一份 `DevToolsActivePort` 方便别的工具复用。

### 5.2 首次登录

- 独立 profile（默认 `~/.local/share/x-browser-profile`）+ 端口 9222，**首次手动登录 X 一次**，cookie 持久化在 profile 里，之后无需再登。
- 登录态丢了就再来这个 profile 手动登一次。

## 六、标题

- ✅ React 兼容写法：取 `HTMLTextAreaElement.prototype` 的原生 `value` setter，`.call(el, title)`，再 `dispatchEvent(new Event('input', {bubbles:true}))`。
- 直接 `el.value = x` 在 React 里不生效（React 覆盖了 setter 并打 flag）。
- selector 见 `selectors.md` 的 `titleInput`。

## 七、调试技巧

- **每步快照**：`publish.ts` 每个 step 后打印 `url / imgs / title`，失败可一眼定位。
- **断点续**：哪步失败，修完 selector/网络后重跑即可（草稿每次新建）。
- **截图**：`client.screenshot(path)` 可在任意步骤存 PNG 人工核对。
- **数正文图**：`document.querySelectorAll('[data-testid="composer"] img').length`。
- **验占位符残留**：正则要写 `/XAP-IMG-[0-9]+-PLACEHOLDER/g`（别写成 `\\d`，那匹配字面 `\d`）。

## 八、走不通的路（别再踩）

- **Playwright + Chrome 151**：`chromium.connectOverCDP`（browser 级 WS 握手超时）和 `launchPersistentContext`（debug pipe 连不上）都失败 —— Chrome 151 太新，Playwright 1.62 不兼容。最终用裸 CDP（page 级 WS，`cdp.ts`）+ OS 级粘贴才成。
- **CDP `Input.dispatchKeyEvent` Ctrl+V**：不读剪贴板，铁律。
- **合成 `ClipboardEvent`**：DraftJS 看 `isTrusted`，忽略。
- **OS `{DELETE}` 删占位符**：会带歪相邻图块，见 2.3。
