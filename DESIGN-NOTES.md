# CriticMarkup Review for Typora — 设计决策速查

> v0.4.6（2026-10-04 第十六轮）。所有决策均已用户拍板或由调研证实。

## v0.4.6 面板 replace 徽章 / highlight 入列 / Reject 语义（第十六轮）

现象（用户原话）：
1. 右侧栏徽章写着 `substitution`，想改成 `replace`，颜色不要绿色（选了蓝色 `#3f87c5`）。
2. 右侧栏里**没有 highlight**；highlight 应该用现在 substitution 的蛋黄色。
3. 追问：comment 前面的高亮到底有没有被锚定？面板 Comments 区**并没有显示**对应的高亮。

**取证**：
1. 徽章文案 = `entry.token.type`（`review-view.ts` 直接把内部类型当显示名）⇒ 显示 `substitution`。配色在 `style.scss`：`.critic-change-substitution` / `.critic-badge-substitution` 是蛋黄 `#d6a40e`。
2. `parser.buildChangeEntries()` 的 filter 只有 `addition / deletion / substitution` ⇒ highlight 永远不进列表；`TrackedChangeToken` 也没包含 `HighlightToken`。
3. 锚定**确实存在**：`buildAnchoredPairs()` 把紧邻的 `{==..==}` + `{>>..<<}` 配成一对，highlight token 被 consumed，信息挂到 `comment.anchored` → `CommentThread.anchor`。但 `renderCommentCard()` 只画徽章 / 作者·日期·行号 / 正文 / 回复，**`anchor` 从未被渲染**（只在 `commentNavKey` 里用于切前缀）⇒ 面板确实无处显示被引用的高亮。用户观察属实。

**修法**：
1. 显示层新增 `CHANGE_LABEL`（`substitution → 'replace'`），`badge.textContent` 查表；**内部 token 类型、CSS 类名一律不动**（parser / renderer / nav key 全依赖 `'substitution'`）。
2. 配色：`substitution`（文案 replace）改蓝色 `#3f87c5` 系（与 comment 色条 / NOTE 徽章同色系，靠文案区分）；新增 `.critic-change-highlight` / `.critic-badge-highlight` 接管蛋黄 `#d6a40e`，与文档里 `.critic-highlight`（`rgba(250,205,70,.38)`）同色。
3. `TrackedChangeToken` 加 `HighlightToken`；`buildChangeEntries` filter 加 `highlight`；preview switch 加 highlight 分支（黄底，无 +/- 前缀）。被锚定的高亮已被 consumed，**不会重复入列**。
4. comment 卡片在正文前插入 `.critic-comment-quote`（`thread.anchor.text`，蛋黄底 + 细条），单击走现有 `navigate()` 跳转；不碰 `.critic-comment-body` 的 `user-select:none` 与双击编辑语义。
5. `rejectToken` 的 highlight 由"返回 text"改为**返回 `''`**（标准 CriticMarkup：Reject 删除被高亮文字），`acceptToken` 不变；`comment` 分支的 `anchored` 仍返回 `anchored.text`（锚定文字必须保留，否则 comment 失去落点）。副作用已告知用户：**Reject All 现在会删除所有未锚定的高亮**。

**不改的部分**：内部 token 类型名、`resolveComment`（走 comment 自己的替换路径）、`REPLY_NAV_DELAY` 与双击编辑。

## v0.4.5 面板打开空列表 + reply 行跳到首条 comment（第十五轮）

现象（用户原话）：
1. F1 打开 Review Panel 后是空的，**每次都要手动点一次 Refresh** 才有内容。
2. 右侧栏点 reply 行，实测**定位到该线程的 comment 上**，不是被点的那条 reply。

**取证**：
1. `main.ts` 的 `toggle-review-panel` 命令体只有 `placement.toggle()`；面板数据唯一的更新源是 `mdEditor.on('edit') → schedulePanelRefresh()`。`ReviewView.data` 初值是 `{changes:[],comments:[],…}`，`onOpen()` 只 `render()` ⇒ **首次打开必然渲染空列表**；重新展开时数据是上次编辑的快照（换文件即过期）。与现象 1 完全吻合。
2. `renderCommentCard()` 里 reply 行的 `scheduleNav` 调的是同一个 `navigate()`，而 `onNavigateComment(entry)` **不带索引**；`ReviewController.navigateComment()` 固定用 `thread.first.raw` 当定位键 ⇒ 无论点哪一行都跳首条 comment。现象 2 属实。
3. 可行性：reply 是完整 `CommentToken`（`raw` = 它自己的 `{>>…<<}`，`anchored` 为 null）；渲染器 `planComment()` 给每条评论（含 reply）打 `data-critic-nav-key = t.raw`，raw 文本以 `font-size:0` 留在 DOM ⇒ `findNavTarget` 属性能命中 reply 徽章，`moveCaretToKey`（落点 `{>>` 之后）会 reveal 该单元。

**修法**：
1. **面板打开即刷新（双保险）**：① `ReviewView.onOpen()` 末尾回调新增的 `onPanelOpened()` → `controller.refreshPanel()`（覆盖"视图首次挂载"）；② `toggle-review-panel` 在 `placement.toggle()` 后用新的 `refreshReviewPanel(delay)`（= `renderService.process()` + `refreshPanel()`，与 Refresh 按钮同款）刷一次，并 400ms 后再刷一次兜住异步创建的 leaf。新增 `RightDockPlacement.isVisible()`（leaf 存在 **且** `rightSplit.collapsed !== true`；核心无该字段时退化为"leaf 存在即可见"），**只在面板真的可见时才刷新**——收起时不白跑一遍全文档 re-wrap。`refresh-review` 命令与 onload 的 300ms 首扫一并复用该方法（消重）。
2. **reply 精准跳转**：`onNavigateComment(entry, replyIndex?)`；`navigateComment` 取 `thread.replies[replyIndex]`（索引缺失/越界回落 `thread.first`），用该 token 的 `raw` 当 key 走既有链路。抽纯函数 `commentNavKey(token)` 收敛"是否切掉锚定 `{==..==}` 前缀"，`navigateComment` / `replaceThread` / `resolveComment` / `stripToken` 四处共用（原先是四份手写 slice）。
3. `head.onclick` 由 `= navigate` 改成 `() => navigate()`：否则 MouseEvent 会被当成 `replyIndex` 传进去（新增可选参数的经典陷阱）。

**不改的部分**：`REPLY_NAV_DELAY = 220` 与双击编辑语义、跳转前清空 `editingKey/editingReply/replyingKey`、写回后的 `schedulePanelRefresh()`（250ms panel-only，防打字被打断）。

## v0.4.4 徽章点击定位：点 comment / reply 徽章光标进不去（第十四轮）

现象（用户原话，源码 `纯批注{>>rc-h20vku|Hui|2026-10-03|NOTE: 好吧s吧<<}{>>rc-h20vku|Hui|2026-10-03|REPLY: 可以三小的吗<<}的`）：
1. 单击 note 徽章**不显示源码**；双击却会选中徽章里的 `{`（选中即显示源码）。
2. 单击 reply 徽章，光标停在 note 的 `}` 与 reply 的 `{` 之间，**要再按一次右方向键**才显示源码。
3. 光标点在"注"字后面（徽章边界外）不显示源码 —— 用户认为可以理解。
4. **增 / 删 / 改 / 高亮全都正常**，只有徽章不行。

**取证（读现有代码）**：
1. `style.scss` 的 `.critic-comment-chip` 是 `display:inline-block; font-size:0; line-height:0; user-select:none`，徽章图形由 `::before` 的 content 画出，raw 文本留在 DOM 里但**零宽且不可选**。
2. 于是鼠标点击根本无法把光标放进该 span：Chromium 只能落在徽章**边界外**——点 note ⇒ offset = `unit.from`；点 reply ⇒ 落在两块之间的 `}{`（= `reply.from`）。与现象 1、2 完全吻合。
3. `resolveReveal()` 两条规则全部落空：规则 1 要求光标锚点元素在 `[data-critic-unit]` 内（此刻在 span 外）；规则 2 `revealUnitForCaret()` 要求 `offset >= from + margin`，token 单元 `margin = 3` ⇒ 边界 offset 被排除。**按一次右方向键让光标进入 span 内的文本节点 ⇒ 规则 1 命中 ⇒ 显示源码**，正是"右移一下才会"。
4. 其它标记的正文可见且可选，点击天然落在 span 内 ⇒ 规则 1 命中 ⇒ 正常（现象 4）。

**为什么不放宽判定 / 改 CSS**：把 `margin` 降到 0 会让"光标紧贴标记外侧就展开源码"，破坏 Typora 原生"光标必须进入语法内部才显示"的语义；让 raw 文本占位可见则直接毁掉渲染态。唯一既不改视觉、又不放宽揭示判定的做法是**显式泊靠光标**。

**v0.4.4 修法（用户拍板：光标停在评论正文开头，并高亮右栏卡片）**：
1. `src/critic/comment-caret.ts`（新，DOM-free 纯函数，9 个单测）：`commentCaretOffset(raw)` 返回徽章 raw 内"正文开头"的相对偏移。三级规则：① 有类型标签（`|NOTE:` / `|REPLY:` …）⇒ 冒号 + 跳过空格；② 无标签但有元数据 ⇒ 最后一个元数据 `|` 之后（最多数 3 根 `|`，因此正文里的 `|` 不会被误当分隔符）；③ 纯文本评论 ⇒ `{>>` 之后。结果恒被夹在 `[open, close)` 内，不可能落在 `<<}` 上。
2. `CriticRenderService.focusCommentChip(chipEl)`：取 leaf block → 读 `data-critic-unit` 序号 → 重建 units → 算落点 → **`setReveal()` 先投影 `.is-raw`**（`critic-raw-body` 带 `user-select:text !important`，先变源码态再放光标，规避 `user-select:none` 下选区被浏览器挪走）→ `placeCaret()` 精确泊靠 → `markUserIntent()` → `processCaretBlock(..., allowClear=false)` 同步簿记。返回 navKey 供面板高亮。
3. `attachPointerFocus(root, onChipClick?)`：`mousedown` 记下命中的徽章元素 + `data-critic-nav-key`（`::before` 不是事件目标，故 `e.target.closest()` + `elementFromPoint` 兜底）；`click`（浏览器默认落位之后）才执行，并按 navKey 重查元素——Typora 可能在 down 与 click 之间重建该行。守卫：`e.button !== 0`、`acceptedView`、选区非折叠（拖拽框选）一律不劫持。卸载对称地挂在 `detachMutationGuard()`。
4. `main.ts` 的 `attachGuard()` 挂载，回调 `placement.getView<ReviewView>()?.highlightByNavKey(navKey)`；面板未打开时静默跳过，不自动打开。
5. `ReviewView.highlightByNavKey` 原只匹配 `thread.first`，点 REPLY 徽章传的是 reply 的 raw ⇒ 必然 miss；补第三条 `thread.raw.includes(navKey)`，reply 也能命中所属 thread 卡片。

**不改的部分**：`margin` 仍是 3（现象 3 保持"光标必须进入标记"）、拖拽框选 / 双击 / IME / accepted view、`clearGate()` 与 v0.4.2/v0.4.3 的全部防闪语义（点击徽章走 `allowClear=false`，永不清除）。

## v0.4.3 残留闪烁（只有光标所在那一个标记闪）的真正根因：reveal 是"每帧重算的派生量"（第十二轮）

v0.4.2 之后整行不再闪，但**输入 / IME 上屏 / 删除时，光标所在的那一处标记仍会闪成渲染态（色块 / 徽章 chip）**，随后又回源码。实测三种输入方式全中 ⇒ 不是时序漏网，而是**表示方式本身不稳定**。

**取证（读 `src/render/critic-processor.ts` 现状）**：
1. reveal 的唯一载体是 **span 上的 `.is-raw` class**，而 span 被反复销毁重建（Typora `$(block).html()` 重写、我们自己的 `unwrapBlock`+rewrap）。于是**每一个 pass 都必须重新"解析出 key → 贴 class"**；任何一个 pass 解析落空 ⇒ 那一帧该 unit 没有 `.is-raw` ⇒ chip 上屏，直到 150ms 后 selectionchange 才补回。块里其他 unit 本来就不是 raw 态，所以症状精确表现为"只有光标所在那一块在闪"。v0.4.2 的 `allowClear=false` 只堵住了守卫/`cursorChange` 两条路径，`handleCaretMove`、`process()` 全量 pass 仍在"决策落空 = 摘掉"。
2. **身份用的是 raw 字符串 `data-critic-raw-key`，编辑时必然漂移**：输入/删除/上屏会改 raw。快速路径 A 不 rewrap ⇒ wrapper 上的 key 停在旧值（= `lastRevealKey`）；等 Typora brush 重渲染后 rewrap 出新 span（新 key），回退链两条全废 —— `seed = caretOffset >= 0 ? caretOffset : lastCaretOffset` 在"offset=0 伪读"时错误地优先用 0；`blockHasKey(block, lastRevealKey)` 拿旧字符串比新 span，**构造性地必 miss**。只剩 `unitAtOffset(lastCaretOffset)` 一条兜底，删除/上屏后偏移漂移或 token↔consumed 形状翻转导致区间变化时即丢失。
3. 打字时 `keyup` 让 `userIntentAt` 永远新鲜 ⇒ `handleCaretMove` 的 allowClear 恒为 true，任何一次读到错误块/错误偏移就会摘掉当前 unit。

**v0.4.3 三条规则（把"派生量"改成"持久状态 + 同步投影"）**：
1. **真源上移**：`block.dataset.criticReveal = <单元序号>`。一个块元素属性，Typora 重写 innerHTML 时天然存活；`unwrapBlock` 不删它。
2. **身份换成序号**：units 排序后按下标编号，写入 `data-critic-unit`（segment span 与 consumed 的原生 `mark/del` 都写）。输入/删除/raw 漂移/形状翻转都不改变序号 ⇒ reveal 无法漂移。
3. **只投影、不清除**：`syncReveal(block)` 只读真源、把 `.is-raw` / `.critic-anchor-reveal` / `.critic-subst-reveal` 同步到 DOM；`processBlock`、`processCaretBlock` 的 rewrap 路径、守卫、`repairAfterRender`、`compositionend`、框架全量 pass 全部以投影收尾 ⇒ **重建 wrapper 在结构上不可能丢 reveal**。摘除只能走 `clearReveal()`，且必须过 `clearGate()`：编辑器静止（距最后一次编辑类 mutation ≥ `QUIET_MS=250`）+ 二次确认（两次落空读相隔 ≥ `CONFIRM_MS=120`）+ 确有用户意图。打字/上屏/删除 200ms 内必 mutation ⇒ 静止期一条就全挡掉。

**配套修正**：
- `renderSuspectedAt` 只由"编辑类" mutation 打点（块内有 `{` / 有我们的 wrapper / 是光标块 / 有 reveal 真源），否则 Typora 常驻装饰性 mutation 会永久锁死清除。
- `restoreCaret` 遇不可信读（offset=0 伪读）直接跳过，不再把光标拽到块首。
- Typora 整块换 `<p>` 时 `adoptReveal()` 把真源复制到继任元素。
- 门控拦下的清除交给**有界重扫**（`runRevealRecheck`，最多 5 次，扫 `[data-critic-reveal]`），避免出现"永不收回的源码态"。
- **CSS 加固带**：`style.scss` 用 `@for 0..24` 生成 `[data-critic-reveal="N"] [data-critic-unit="N"]` 的源码态规则（与 `.is-raw` 共用 `@mixin critic-raw-body`）。即便存在没想到的 JS 路径忘了投影，也不会出现"wrapper 已建、源码态未上"的帧 —— 投影于是从竞态降级为优化。
- **诊断**：`debugDump()` 增 `revealAttr / lastRevealOrdinal / suppressed / gate / TRACE`（最近 12 条决策）。健康编辑会话：`kept` 连续增长、`suppressed` > 0、`cleared` 不因打字增长、`revealAttr` 始终等于 `lastRevealOrdinal`。

### v0.4.3.2 "离开标记后不渲染"与"点 reply 不跳转"（第十三轮补丁）

1. **跨块离开被门控卡住**：v0.4.3 把"清除"统一交给 `clearGate()`（quiet 250ms + confirm 120ms + 用户交互），但**跨块移动本身就是用户离开的确证**——Typora 的重渲染只会把选区塌缩在**同一块**内（offset-0 伪读已被 `isCaretTrustworthy` 滤掉），不可能把可信光标搬到另一个块。于是：打字后 `renderSuspectedAt` 被 mutation guard 不断续期 → quiet 永远不满足 → 走 recheck（每 150ms 一轮、**5 次后静默放弃**）→ 残留源码态直到某个无关事件来扫，表现正是"不立即渲染、有时又突然渲染、找不到触发模式"。
   修法：跨块 + trusted 时**直接 `clearReveal(prev)` 立即渲染**；仅保留一条"渲染刚发生（≤ `LEAVE_RENDER_GRACE=120ms`）就交给重扫"的兜底，避免在 Typora 重写那一帧里清除（那才是 chip 闪烁的来源）。**同块内移出 unit 的清除完全不变**，v0.4.2/v0.4.3 的防闪语义不回退。recheck 放弃时写 `TRACE: …giveup`，不再静默。
2. **右栏 reply 行没有导航绑定**：comment 卡片只有 `head.onclick = navigate`；reply 的 `critic-reply-head`/`critic-reply-body` 只绑了 dblclick 编辑。补上单击导航（reply 与首条评论同 entry，`navigateComment` 用 `thread.first` 的 key 天然正确，controller 无需改）。
   **坑**：`navigate()` 会 `render()` 重建整个面板 DOM，单击即导航会让被点的行在 dblclick 到达前就被移除 → 双击编辑永久失效。所以 reply 的导航延迟 `REPLY_NAV_DELAY=220ms`，且 dblclick 会 `clearTimeout` 取消它。

### v0.4.3.1 两个"新机制自己踩自己"的坑（第十二轮补丁）

1. **wrapper schema 版本**：v0.4.3 给 span 加了 `data-critic-unit`，但 `data-critic-sig` 只看文本 ⇒ 旧构建包出来的 span（无该属性）在每次 pass 都命中快速路径，**永远不会被重建**，`applyReveal` 找不到任何 `[data-critic-unit]` ⇒ 升级后 reveal 根本投影不上去（表现：打字时该 unit 恒为渲染态）。修法：签名前缀 `WRAP_SCHEMA='v3'`，wrapper 携带的属性集一变就 bump（代价：升级后每块多一次 rewrap）。**诊断要点**：dump 里 `unitSpans` 必须为 revealed 段数，为 0 即命中此坑。
2. **dump 命令自己清掉了要观测的状态**：`debug-dump-block` 注册为 `scope:'global'`，从命令面板调用会**抢走焦点** → `handleCaretMove` 走"焦点离开编辑器"分支 → 无条件 `clearReveal` + `lastCaretOffset=-1` ⇒ 任何 dump 必然显示 `revealKey=null / lastCaretOffset=-1`，永远拍不到闪烁。修法：焦点离开的清除也过 `clearGate()`（被拦下则交有界重扫），且 dump 增补**不落库**的 `resolveNow`（当场算光标解到哪个 ordinal）与 `unitSpans/schema/sig`。

## v0.4.2 闪徽章的真正修法：修在 `cursorChange`，而不是 MutationObserver（第十一轮，Typora 源码确认）

v0.4.0 / v0.4.1 都还在闪 —— 本轮直接读 `D:\Program Files\Typora\resources\appsrc\window\frame.js`（1.7MB bundle，Typora 编辑器内核全在里面）确认时序，结论是**修复的时机根本选错了**。

**取证（全部来自 frame.js 源码）**：
- `editor.brush`：`this.interval = 200`，`scheduleNext` 用 `setTimeout(async () => { await brushQueue(); scheduleNext() }, 200)` 常驻轮询。
- 入队：input/beforeinput 分支 `h.brush.addToQueue(h.focusCid)`；Backspace/Delete 分支同样 `h.brush.addToQueue(h.focusCid)`；IME 上屏的 `p()` 里 `h.isIME = 0; setTimeout(() => h.brush.brushQueue(), 10)` ⇒ **每上屏一个字 / 每次删除必有一次重渲染**。
- 重渲染 `E() → m()`：`s = e[0].cloneNode(true)`（当前 DOM，**含**我们的 `[data-critic-seg]` span）与 `l.innerHTML = n.innerHtml`（重新生成，**不含**）比 innerHTML，`f(s), f(l)` 只剥 `cid/contenteditable/id`，**两者必然不等** ⇒ 走 `e.html(a)`（jQuery 覆盖 innerHTML）⇒ wrapper 与 `.is-raw` 每次全丢。
- `brushQueue` 顺序：`await Promise.all(queue.map(E))` → `s.queue = []` → `t && i && s.editor.undo.exeCommand(i)`（**恢复光标**）→ `this.expand(true, false, n)` → expand 各分支末尾 `$(editor.sessionStr).trigger("cursorChange", editor.styleBookmark)`。
- Typora 自己的语法显示（`md-expand`）正是"渲染之后、光标已恢复"时同步补回的：`$(".md-expand").removeClass("md-expand")` … `F(e.addClass("md-expand")…)`。它从不闪，就是因为补在正确时机。
- `window.$ = window.jQuery` 在 module "50" 被全局赋值 ⇒ **可以用 jQuery 监听 `cursorChange`**（jQuery `.trigger` 不派发原生 DOM 事件，原生 `addEventListener` 收不到）。

**v0.4.1 为什么没生效**：断言"选区不可读时 `findCaret` 返回 null"是错的。Chromium 在 innerHTML 被整体替换后会把选区**塌到块首**，于是 `findCaret` 返回的是一个**合法但 offset = 0** 的 caret —— `!caret` 分支永不进入，v0.4.1 的续期链因此根本没跑；代码把它当成"用户把光标移到了块首"，解析不到 unit → `syncRawState(block, null, null)` → **摘掉 `.is-raw`** → 徽章上屏，直到 150ms 后 selectionchange 才补回源码。

**v0.4.2 两条规则**：
1. **REPAIR 永不清除**。把"修复"与"清除"彻底分离：`MutationObserver` 守卫、框架 post-processor 全量 pass、`compositionend`、`cursorChange` 全是修复路径，只能重建 wrapper + 续期上一次 reveal；`syncRawState(..., allowClear=false)` 在解析落空时**直接 return**（一个 class 都不动）。只有 `handleCaretMove` 在**光标可信 + 确有用户意图（mousedown/click/keyup，400ms 窗口）或跨块跳转**时才允许清除。
2. **权威修复挂在 `cursorChange`**。新增 `repairAfterRender(containerEl)`：在 Typora 完成"重渲染 + 恢复光标"之后、同一宏任务内同步跑，只处理光标块 + 脏块（不遍历全部 leaf，`cursorChange` 很频繁）。浏览器于是只绘制一帧，且该帧已是源码态。守卫降级为兜底，且已非破坏性。
   - 主传输：jQuery `$(editor.writingArea).on('cursorChange', …)`；兜底：包一层 `editor.brush.expand`（`try/finally` 中原样返回），两者都 try/catch，`onunload` 还原。

**可信光标判定**：`isCaretTrustworthy(caret)` —— caret 缺失、offset < 0，或"offset 恰为 0 且 `lastCaretOffset > 0` 且距最近一次编辑器 mutation 不足 400ms（`RENDER_SUSPECT_WINDOW`）"→ 不可信。窗口限制保证用户真的按 Home/点到块首时，下一次 selectionchange 仍会正常清除，不会留下永不消失的源码态。
**防污染**：`processCaretBlock` 与 `handleCaretMove` 只在可信时写入 `lastCaretOffset`，否则 offset-0 假值会毒化所有续期回退。
**诊断**：`debugDump()` 增补 `repairSource / repairs / kept / cleared / caretTrusted / renderSuspectAge / userIntentAge`。健康编辑应表现为 `kept` 单调增长、`cleared` 不因打字而增长。

## v0.4.1 打字闪徽章的最终根因：Typora brush 的 await 窗口（第十轮，实测取证）

高亮配色已解决，本轮专攻"每上屏一个字/按删除都先闪成徽章（渲染态）再回源码"。

**取证（`resources/appsrc/window/frame.js`）**：
- 每次输入/删除都走 `beforeinput(insertText)` → `selection.prepNode()`（或 Backspace → `UserOp.backspaceHandler()`）改 DOM 并 `brush.addToQueue(cid)`。
- brush 是 **`setTimeout(…, 200)` 宏任务**队列（`interval=200`）：约 200ms 后 `brushQueue` 从 AST 重建该块 inline DOM（销毁我们的 wrapper span）。
- `brushQueue` 是 **async**：`i = selection.buildUndo()`（保存选区）→ `await Promise.all(… E.call … 重建 DOM …)` → **之后才** `exeCommand(i)` 恢复选区。`await` 处 JS 栈展开触发微任务检查点——**我们的 MutationObserver 守卫恰在此窗口运行，此时选区挂在已摘除的节点上**。
- `brushQueue` 开头 `isIME ||` 短路：组字期间不跑，`compositionend`（isIME 清零）后 ~200ms 必跑一次 ⇒ "每上屏一个字闪一次"；Backspace 同样入队 ⇒ "按删除也闪"。

**缺陷链**：守卫里 `findCaret(root)` 返回 null（或整块 `<p>` 被替换、`lastCaretBlock` 引用失配）→ v0.4.0 的术后兜底 `post ? resolve : {key:null}` → `syncRawState(block, null)` **主动摘掉 `.is-raw`** → 徽章渲染 → Typora `exeCommand` 恢复选区触发 `selectionchange`（150ms 防抖）→ `handleCaretMove` 重新点亮 → 回源码。可见闪烁 ≈150ms。

**v0.4.1 三条规则**：
1. **选区不可读绝不主动清 reveal（续期链）**：`processCaretBlock` 重包裹分支里 `!post` 时——① `unitAtOffset(units, caretOffset)` 宽容闭区间命中（守卫喂的是 `lastCaretOffset`，每次成功读光标都刷新、含刚输入字符、偏差至多 ±1）取该单元**新 key**；② 仍无 → `lastRevealKey` + `blockHasKey`（文本未变、Typora 仅重建 DOM 时新旧 key 相同，直接续期）。**post 可读时行为与 v0.4.0 完全一致**（可读且在单元外 → 尊重 null → 渲染，光标移出语义不回归）。key 匹配一律走 `dataset` 逐个比对，不拼属性选择器（raw 含 `{`/`|`/`<` 会 throw）。
2. **块收养**：守卫发现 `lastCaretBlock` 失联（isConnected/contains 均 false）且脏块恰为单块时，收养该块走 `processCaretBlock(block, lastCaretOffset, null)`（函数入口即刷新 `lastCaretBlock`），并补 `lastRevealKey` 匹配兜底；多块 + 选区不可读属罕见场景，保守走 `processBlock`。
3. **焦点守卫**：`handleCaretMove` 的 `!caret` 分支不再无差别当"光标离开编辑器"——`document.activeElement` 是 `containerEl`/其后代/`body`/null 时视为 Typora 手术窗口的瞬时不可读，直接 return 保持现状；焦点真到面板/弹窗才清空 reveal。代价：点击不可聚焦区域时源码态可能多停留到下一次光标移动，属可接受折衷。

## v0.4.0 打字闪烁根因 + 锚点配色硬化（第九轮实测两问题）

1. **打字每上屏一个字闪一下渲染态（问题1，主因已代码定位）**：根因是 `processCaretBlock` 的 reveal 求解**早于** DOM 手术。`resolveReveal` 规则1 取手术前 `anchorEl.closest('[data-critic-raw-key]')` → 得到**旧** raw key；而 `unwrapBlock + wrapSegment` 之后新建的 span 携带的是**含刚输入字符的新** raw key。`syncRawState(reveal.key)` 于是一个 span 都匹配不上 → 本帧无 `.is-raw` → 显示渲染态；要等 `selectionchange`（main.ts 150ms 防抖）重解才回源码态。触发条件"每键必重包裹"：Typora 每次输入都重排该行 inline DOM，wrapper 被销毁 → `wrappersMatch` 必失配 → 必走全量分支。修复：**reveal 解析下沉到手术之后**——`restoreCaret` 之后用 `findCaret(block)`（传 block 作容器，`closest` 含自身）取术后 `anchorEl/offset` 再 `resolveReveal`；快路径（无手术）保持原样（DOM 未变，术前术后等价）。
2. **守卫时序三点加固（问题1 次因）**：
   - `onCompositionEnd` 去掉 `setTimeout(…,0)`：宏任务可能落在一次 paint 之后 → 改为**同步**修复；组字期间被抑制的块记入 `dirtyBlocks`，在 compositionend 同帧 flush（手术仍只在组字外进行，IME 安全不变）。
   - `onGuardMutations` 原来只看 `record.target`（=变更的父节点）：Typora 整块替换 `<p>` 时 target 是 `#write`，`closest(LEAF_BLOCK)` 为 null → 该块**永远漏修**，只能等框架 ~400ms 回环。改为同时扫描 `record.addedNodes/removedNodes`。
   - 新增 `lastCaretOffset` / `lastRevealKey`：光标瞬时读不到（Typora 重排时摘掉光标的文本节点）时，脏块若 === `lastCaretBlock` 仍走 caret 模式，不再退化成"按普通块渲染 → 清掉 `.is-raw`"。
3. **锚点金黄（问题2，改用 inline 强制接管）**：实测 Typora 1.14.10 / Electron 42.2.0（`:has()` 可用），`base.css` 唯一金黄来源 `mark{background:#ff0;color:#000}`（0-0-1、无 `!important`），`dist/main.css` 里 `mark:has([data-critic-raw-key])` 与 `mark.critic-native-host` 两条 transparent 规则都在，且替换标记的红/绿（同为 `:has()` 规则）正常 ⇒ 层叠链上仍有未覆盖环节，静态推演无法定论。修复：`syncNativeHostClasses` 升级为 **`neutralizeNativeHosts`，直接写 inline `!important`**（`background-color:transparent`、`color:inherit`、del 另加 `text-decoration:none`）——inline important 无法被任何外部样式表规则覆盖。宿主识别双路：(a) 从每个 `[data-critic-raw-key]` span **向上遍历祖先**收集 mark/del/s/strike（覆盖嵌套变体，`querySelector` 单层判定会漏）；(b) 单元与原生元素的**文本区间重叠**（覆盖 span 与 mark 是兄弟而非父子的形态）。消费态单元（`critic-anchor-consumed`/`critic-consumed-del`）**刻意不写 inline**：inline 会压过 `.critic-anchor-reveal{background:transparent!important}`，reveal 时底色去不掉；它们继续走样式表。
4. **可逆性（硬约束）**：所有 inline 写入配 `removeProperty`；新增 `clearNeutralization(root)`，`unwrapAll`/`dispose`/`detachMutationGuard` 全部清理，保证插件卸载后 Typora 原生外观完整恢复。
5. **组字期兜底样式**：`critic-composing` 打在光标块上（compositionstart 加 / compositionend 摘 / detach 兜底摘），CSS 仅中和 `mark/del/s/strike` 并显示它们的 `.md-meta`，防止组字期间 Typora 重排导致整段露出原生渲染；作用域只限 mark/del，不波及其它 markdown 语法。
6. **诊断命令**：F1 `Debug: Dump Block DOM at Cursor` → 复制光标块 outerHTML + 原生元素的 class/inline/computed 颜色到剪贴板并 console.log。配色问题下一轮可直接拿真实 DOM 定论，不再靠静态推演。
7. **顺带补齐**：`processCaretBlock` 原先漏了 `planConsumedAnchorSegments`（`processBlock` 有），导致消费态锚点的字面 `{`/`}` 在光标块里一直可见。

**DOM 结构更正（推翻 v0.3.1 的描述）**：`resources/appsrc/window/frame.js` 里高亮的真实模板是
`<span md-inline='highlight' class='md-pair-s'><span class='md-meta md-before'>==</span><mark>inner</mark><span class='md-meta md-after'>==</span></span>`
—— `==` 是 mark 的**兄弟** md-meta span，**不是** mark 内部；`{`/`}` 在 md-pair-s 之外。即"mark 内含 md-meta"的说法有误，但 `textContent` 与偏移计算不受影响。

## v0.3.1 md-meta 真相模型（第八轮实测六问题，推翻"消费"理论）

**重大更正**：Typora 1.14.10 从未把 `==`/`~~` 从 DOM 删除。重载后 `{==软件的潜==}` 的真实 DOM = `{`文本 + `<mark>` 内含 `<span class="md-meta">==</span>` + 正文 + `<span class="md-meta">==</span>` + `}`文本（证据：base-control.css `.md-meta{display:none}`、base.css `mark{background:#ff0}`、`.md-expand mark .md-meta{opacity:.3!important}`）。textContent 里源码完整、token 正常解析——v0.2.1/v0.3.0 的"消费态检测"是对重载场景的误诊（从未命中）。

1. **金黄高亮 + `====` 显示不出（问题1）**：金黄 = 原生 mark 的 `#ff0` 底色透出；`==` 显示不出 = md-meta 被 display:none 藏着，is-raw 只能显示自己 span 里的纯文本。修复（纯 CSS，style.scss v0.3.1）：`mark:has([data-critic-raw-key])` 背景透明化（自有 critic-highlight 提供蛋黄色）、`[data-critic-raw-key].is-raw .md-meta` 强制 display:inline/opacity:1（特异性压过 Typora 两条规则）、is-raw 内克隆壳 mark/del 中性化。锚点 reveal 从此显示完整 `{==软件的潜==}`。
2. **F1 Replace 无效（问题2）**：comment-modal 的 promptText 在 30ms 后 input.focus() 抢走文档选区，确认时 pasteHandler 无处可贴。修复：弹窗打开前 captureEditableRange()，confirm 先 restoreEditableRange()（恢复 Range + focus 回 contenteditable host）再回调 onConfirm。
3. **替换标记新词也有删除线（问题3）**：旧词+`~>`+新词全在原生 `<del>` 里，line-through 波及全部。修复：`del/s/strike:has([data-critic-raw-key])` text-decoration:none + color:inherit；旧词由 critic-subst-old 自带红删除线、新词绿色干净、`~>` 隐藏；reveal 时 md-meta 显示 `~~`。
4. **行尾清除吃换行 + 时不时失效（问题4）**：locateOffset 用严格 `<`，range 终点落在文本节点末尾时跳到下一块首节点 → 选区跨块 → 空串 paste 合并段落。修复：locateOffset 增加 preferEnd（终点=节点末尾时留在本节点），performReplace 的 end 与 moveCaretToKey/parkCaretPast 均启用；findCursorTarget 增加选区锚元素回退（wrapper closest + 消费元素 contains），光标停在零宽徽章边界也能命中。
5. **编辑闪烁 + 中文重复（问题5）**：三因叠加——进入光标块首键 hashSig 失配触发 unwrap+rewrap+restoreCaret 摧毁 IME 组合；staleKey 自愈在打字时必触发（解析 raw 已漂移而 wrapper key 旧）；reveal 按解析 key 匹配。修复：双签名方案（criticSig=上次完整包裹的文本哈希 + criticCaret='C:单元数' 光标态盖章）——光标块仅单元数变化或 wrapper 缺失才重包裹，打字期间零 DOM 手术；reveal 改 resolveReveal 三级解析（wrapper 键优先 → 偏移 → 消费元素），key 与单元解耦，打字中照常显示源码；离开光标块时 processBlock 按 criticSig 失配触发一次完整重包裹刷新漂移的 key。删除 staleKey/hasWrapperForKey/revealTargetByWrapper。
6. **面板双击编辑（问题6，用户拍板）**：评论正文与回复行 onclick → ondblclick（+title 提示 + user-select:none 防双击选词闪烁）；Edit/Reply/Resolve 按钮保持单击。

**消费形态守卫**：detectConsumedAnchors 跳过文本以 `==` 开头且结尾的 mark（源码完整，token 已覆盖）；detectConsumedSubstitutions 本就跳过 token 覆盖区间。真消费形态（语法确实不在 DOM）仍走 v0.3.0 的伪元素合成路径。

**收尾补齐（本轮执行时落定）**：

- `locateOffset` 抽到纯模块 `src/critic/text-offset.ts`（只读 textContent，可脱离 DOM 单测），`preferEnd` 语义固定为"终点=节点末尾时留在本节点"；`performReplace` 仅 end 端、`moveCaretToKey`/`parkCaretPast` 停靠启用。新增 `test/critic-core.test.ts` 边界用例 9 条（块尾、空节点、流末、越界、泛型节点类型）。
- `:has()` 之外补 `.critic-native-host` 类规则：`syncNativeHostClasses` 盖在承载我们 span 的原生 mark/del 上，`:has` 不可用或失效时仍能中和原生金黄/删除线（此前该类无对应样式，等于空转）。
- 清理 `planConsumedAnchorSegments` 的重复实现（TS2393），保留 v0.3.2 版本（accepted view 下花括号也隐藏）。

## v0.3.0 reveal 单元模型（第七轮实测五问题）

**核心重构**：渲染层与光标路径统一按"reveal 单元"粒度工作——解析器新增 `mergeAnchored: false` 模式（parser.ts），`{==text==}` 与每条 `{>>...<<}` 各自成 token、各持独立 `data-critic-raw-key`；锚点/ASK/REPLY 显示源码与清除彻底解耦。面板数据流（getMarkdown、合并解析、accept 语义）零改动。

1. **锚点 `====` 无法显示（问题1）**：重载后 `==` 被 Typora 原生高亮消费，元素驱动检测（mark + 前后 `{`/`}` + 后随评论 token）生成 consumed-anchor 单元；reveal 时在 mark 上切 `.critic-anchor-reveal`，CSS 伪元素合成左右 `==`。替换原 v0.2.2 的块级 `.critic-has-raw`（粒度错误：任何 token reveal 都带出 `==`，点击内部反而不生效）。reveal 判定改闭区间，消费单元 margin=1（`{`/`}`），token 单元 margin=3。
2. **点击语义单元化（问题2，用户拍板模型）**：点锚点区只显 `{==软件的潜==}`；点 ASK 徽章只显 ASK 源码；点 REPLY 徽章只显 REPLY 源码。revealTargetByWrapper 按 raw-key 反查唯一单元；光标路径同粒度（修"光标在锚点里带出 ASK、REPLY 要右移才显"）。新增 stale-key 自愈：reveal 请求的 key 在块内找不到 wrapper 时强制重包裹。
3. **替换语法被原生删除线吞掉（问题3）**：`{~~a~>b~~}` 重载后成 `{<del>a~>b</del>}`，新词也在 del 内全段删除线。元素驱动检测（del + 前后 `{`/`}` + 纯函数扫描 `findConsumedSubstitutionRanges`，critic/consumed.ts 新建）生成 consumed-subst 单元；重规划 old（自带红删除线）/`~>`（critic-subst-join 隐藏）/new（绿色无删除线）三段；`.critic-consumed-del { text-decoration: none !important; color: inherit }` 杀掉原生删除线与灰化；reveal 时 del 上切 `.critic-subst-reveal` 合成 `~~` 并经 is-raw 展开 `~>`。accepted view 下 old/join 隐藏。
4. **面板 reply 无法编辑（问题4）**：reply 行加 REPLY 徽章 + 点击进入内联编辑框（Save/Cancel + Ctrl+Enter/Esc）；`buildThreadWithEditedReply`（thread.ts）仅重写目标回复块，保留锚点/首条评论/其他回复与 id/作者/日期；editingReply 状态与 editingKey/replyingKey 互斥，导航/刷新时正确清理。
5. **清除标记按单元作用（问题5）**：`findCursorTarget`（critic-processor 导出，main.ts 的 findTokenAtCursor 删除）用不合并解析 + 消费形态单元定位光标落点；stripToken 语义单元化（锚点→保留文本、单条评论→仅删该条、替换→保留新词）；resolveTokenAt 直接对单元 token 应用 accept/reject 纯函数（不再经面板 entry raw 匹配）；findNavTarget/moveCaretToKey 增加消费形态拼写兜底（`{text}`/`{a~>b}`）。

**行为保持**：独立成行的 `{==?? ==}` 消费态继续交给 Typora 原生 reveal（不生成单元，避免字面 `{text}` 误判）；sig 短路保留（C:单元数 / 文本 hash 双格式）；class/attribute 级切换零文本节点增删，MutationObserver 收敛契约不变。

## v0.2.2 修复（第六轮实测七问题）

1. **锚点两套黄色 + `==` 显示行为**：确认存在两个元素——面板插入的 `{==..==}` 是我们的渲染（蛋黄色），重载后被 Typora 原生高亮消费（金黄色 mark）。修复：markConsumedAnchors 检测"非我们元素 + 间隙文本恰为 `}`"打 .critic-anchor-consumed 类；渲染态统一我们的蛋黄；reveal 态 CSS 合成 `==`。
2. **点击语义简化（用户拍板）**：点锚点区 = 只显示锚点源码（伪元素 `==`）；点 ASK/REPLY 徽章 = 各自 token 源码（revealTargetByWrapper 按raw-key反查）。
3. **替换语法撞车（新发现）**：`{~~a~>b~~}` 的 `~~` 被 Typora 当原生删除线消费（与 `==` 同病）——手写/重载后整段删除线、`~>` 可见。本轮：命令更名 "Mark Selection as Replace"；面板插入的 markup 重载前存活；消费形态渲染与单条 accept 属已知边界（文档记录）。图片中的"正确词也有删除线"即 Typora 原生 strike 覆盖全段。
4. **面板点击移动光标**（用户要求）：navigateTo(el, caretKey) 把光标放到 token 定界符内（idx+3）→ 光标逻辑自动显源码 → scrollIntoView。change/comment 导航都传 key。
5. **编辑框不自动关闭**：change/comment 卡的 head/body 导航点击先清 editingKey/replyingKey 再 render。
6. **类型按钮即时切换**（用户要求）：tag 点击立即写回（body+tag 一起），编辑框保持打开（pendingFocusKey 重聚焦），无需 Save；Save/Ctrl+Enter 仍是"应用并关闭"。
7. **Reply 无法进入编辑**：根因是 entry.id 位置基（`comment:from:to:index`）——文档任何偏移变化使 replyingKey/editingKey 与新数据失配被清。改稳定 id：rc 线程用 `thread:rc-xxx`，普通评论用内容 hash + 出现序号。

## v0.2.1 修复（第五轮实测：Typora 原生高亮消费 `==`）

**重大发现**：Typora 原生支持 `==高亮==` 语法！文件重载时 Typora 自己的解析器把锚定评论的 `{==软件的潜==}` 消费成原生 `<mark>` 元素——`==` 字符从此不存在于 DOM（面板插入时走纯文本粘贴所以当时存活，重载即死）。这解释了"左侧 == 永远无法显示"和锚定渲染路径的种种怪象。

1. **左侧 `==` 无法显示**（问题1）：根因如上。修复：CSS 合成——`critic-has-raw` 块级类 + `mark:has(~ [data-critic-raw-key].is-raw)::before/::after { content: '==' }`，raw 态下视觉补全 `==`（零 DOM 变更，Typora 解析器无法循环）；渲染态 anchor 显示交给 Typora 原生 mark（视觉等价黄底）。
2. **chip 点击打开 panel**（问题2）：按用户要求移除 chipHandler（点击徽章只显源码，不开面板；面板入口=F1 命令）。
3. **REPLY 徽章点击不显源码**（问题3）：chip 点击落点在 token 边界，严格内部判定永不命中。修复 revealTargetByWrapper：点击任意自家 segment（按 data-critic-raw-key 反查）或 Typora mark（向后找最近 raw-key 兄弟）→ 直接触发该 token raw。
4. **清除光标处标记**（问题4）：F1 命令 `strip-at-cursor` + 面板 🧹 按钮。语义=accept：增/改保留文本、删清空、高亮保留文本、评论移除（锚定保留锚文本）。
5. **潜伏 bug 修复（锚定写回）**：重载后 thread.raw 含锚点但 DOM 无 `==` → indexOf 失败"markup not found"。replaceTextRange 重构为 readTextStream/locateExpected/performReplace 三助手 + replaceFirstMatch 双候选：edit/reply 回退到仅评论段替换（源文件锚点保留）；resolve/strip 回退到 `{text}` 消费形态匹配。

## v0.2.0 架构改造（第四轮实测，参考 typora-plugin-callout）

**问题**：① 点击进入 token 光标瞬间跳到行首/最左；② 评论线程只能半显示源码、REPLY 完全无法显示源码。

**根因**：v0.1.x 的 raw↔渲染切换靠 unwrap（销毁全部 span、文本节点重建合并）——光标所在文本节点被销毁，浏览器把光标重置到块首（问题①）；点击 chip 徽章时 anchorNode 是元素节点，TreeWalker 找不到返回 -1，被当作"块外"永不进入 raw 分支（问题②）。

**新架构（callout 插件启发：只加 class，绝不重构 DOM）**：
- 所有 token **恒久包裹**（含光标所在 token）；raw↔渲染 = 该 token 全部 segment 上的 `is-raw` class 切换（syncRawState，按 data-critic-raw-key 匹配）
- 两种模式 DOM 结构完全一致 → 文本节点零创建/销毁 → **光标天然保持**
- CSS 一条 flat 规则重置一切视觉（display:inline 解 critic-mark/hidden 的 display:none；font-size/line-height inherit 解 chip 的 0；::before content:none 去 chip 徽章）
- findCaret 改用 `Range.toString()` 计算块内偏移——元素容器（chip/伪元素区/br）也能算出正确 offset，问题②的判定死角消除
- 签名双格式校验：C:count（光标块，token 内打字零 DOM 触碰）或 hash（文本未变）+ wrapper 存在性（Typora 重建自愈）任一匹配即免重建；块间移动光标 = 纯 class 切换零 churn
- processBlock 兼容存留的 C-sig（wrappers 完好即早退，防离场抖动）

**遗留边角**：同一块内两个完全相同的 token（raw 串一致）会同时 is-raw（罕见，记录在案）。

## v0.1.3 修复（第三轮实测）

1. **"点击标记内部源码一闪而过，再也点不出"**：根因是 handleCaretMove 的粗粒度早退——`caret.block === lastCaretBlock` 就 return，块内 token 成员关系变化与 Typora 的 DOM 内部重建（同元素 innerHTML 换掉、wrapper 消失但 data-critic-sig 残留）都被挡在门外，一旦状态漂移永远无法恢复。修复三层：
   - handleCaretMove 同块也重估（processCaretBlock 内部有签名短路，代价低）；光标离开编辑器（进面板/弹窗）时回包 lastCaretBlock
   - isConsistent 签名+wrapper 存在性交叉校验：签名说"已渲染"但 wrapper 没了 → 判不一致 → 自愈重渲
   - caret 签名编入 token 数（C:skip/count）：同 skip 粘贴出新 token 也能察觉；仍然不含文本 hash（token 内打字零 DOM 触碰不变）
2. **Reply 后 rc-xxxxx 源码可见**：懒 ID 设计本身正确（单评论无 ID、有回复才升级绑定，见 README"评论线程格式"），用户看到的是渲染 bug——Typora 粘贴重建块后回包要等框架 observer ~400ms，整个窗口都是裸文本；若粘贴把光标留在标记内则一直 raw。修复：写回后 settle（120/420ms 双定时器）= parkCaretPast + afterWrite 钩子直接调 renderService.process（不等 observer）；parkCaretPast 改为遍历所有相同文本出现位置找包含光标的那处（同文两次回复的边角）。
3. manifest 版本 0.1.0 → 0.1.3（此前两轮忘了升）。

## v0.1.2 修复（第二轮实测反馈）

1. **类型按钮切换失败 + "location not found"**（问题1）：根因是 focusout 竞态——点类型按钮时 textarea 先失焦，setTimeout(0) 里 flushPendingRender 把整个面板 render() 销毁重建，click 落在已替换的按钮上被吞。修复：focusout 的 relatedTarget 仍在面板内时不 flush（面板内焦点转移不触发重渲）。"location not found" 是 navigate 在光标块 raw 态下找不到 wrapper——findNavTarget 加文本流 fallback（locateBlockByText）；navigateTo 改为只 scrollIntoView 不动光标（防光标跳进块引发源码显示）。
2. **dock 面板宽度固定右侧空白**（问题2）：Core 2.10.21 对 split 子项给 flex 但 side-dock tabs 不给（tpov 踩过同坑）。修复：:has(.critic-review-view) 作用域下给 tabs/leaf flex 修正 + view 自身 width:100%（与 tpov 同款方案）。
3. **光标所在行整行源码**（问题3）：v0.1.1 的 caretBlock 整块 unwrap 太粗。重写为 token 级：只有光标**严格位于单个 token 定界符内部**（from+3 < off < to-3，开区间——边界位置保持渲染，见第4条）才显示该 token 源码，块内其余 token 照常渲染。caret 块的签名不用文本 hash 只用 skip 指纹——同一 token 内打字零 DOM 触碰（防 caret 抖动），token 成员关系变化才重渲。
4. **Reply 后出现 rc-xxxxx 源码**（问题4）：thread 升级本身正确，问题是 Typora 粘贴后把光标留在标记内部 → 触发源码显示。修复：判定边界改开区间（粘贴残留位置 to-3 不触发）+ 写回后 parkCaretPast（120ms/420ms 双定时器，光标在刚写回的标记内部时移到末尾之后）。
5. **浮动评论图标移除**（用户拍板）：FloatingCommentBar 整类删除，selectionchange 只保留 caret 渲染驱动。评论入口收敛为 F1 命令 + 快捷键。

## v0.1.1 修复（用户实测反馈三问题）

1. **无限渲染循环**（根因）：process() 无条件 unwrapAll → 每次都产生 DOM 变更 → Typora MutationObserver('edit', debounce 400ms) → 框架 processAll 再跑 → 循环。症状：光标块每 400ms 被拆装（caret 被毁=问题1）、面板每周期 replaceChildren（textarea 失焦=问题2）。
   修复：块级内容签名（djb2 hash 存 data-critic-sig），未变化的块零触碰 → observer 一轮后收敛。
2. **光标块显示源码**：光标所在块永远保持 raw（unwrap），与 Typora 原生"编辑时显示语法"行为一致 → comment 可直接在所见即所得里编辑（问题1 的功能面）。selectionchange 防抖 150ms → handleCaretMove，仅光标块变化时才 process。
3. **anchor lost**（根因有二）：offsetOfRangeStart 拿 selectNodeContents(元素) 的 startContainer 去文本节点表里 find，永远 -1；文本流收集在 expected.length+8 处提前截断。修复：replaceTextRange 全 #write 文本流（数组 join）indexOf 定位 + hint 元素首文本节点偏移消歧 + locateOffset 边界严格化。写回不再依赖渲染 wrapper（块 raw 时也能写）。
4. **面板失焦**：refresh(force) 增加 isInteracting 守卫（panel 内 TEXTAREA/INPUT/SELECT/BUTTON 聚焦时挂起渲染，pendingRender + focusout 时补渲）。写回路径 refreshSoon(force=true) 绕过守卫。
5. **CSS 类名错位**（问题3）：TSX 用 critic-card/critic-change，CSS 写的是 critic-change-card → change 卡片裸奔。style.scss 全量重写，与 TSX 类名逐一核对（grep className 清单比对）。
6. **chip 徽章**：font-size:0 隐藏原文 + ::before 按类型画徽章（critic-chip-ASK/EDIT/PRAISE/NOTE/REPLY），原文保留在 DOM（复制/写回/unwrap 恢复都不受影响）。
7. main.ts 重布线：edit 只刷面板（渲染归框架 processAll，消除双跑）；scroll 防抖 200ms 捕获懒加载块；selectionchange 统一驱动浮动条+caret。

## 交付状态

- vitest 43/43 全绿（critic-thread 17 + critic-core 9 + comment-caret-offset 9 + critic-resolve 8）；tsc --noEmit 零错误；esbuild 生产构建通过
- 产物：`npm run pack` → out/criticmarkup-review-<version>/ + 同名 zip + out/latest/ + plugin.zip；`npm run deliver` 再拷进 `…\community-plugins\plugins\criticmarkup-review-delivery`（v0.4.6 已交付）
- 构建必须用 `npm run build`（= `node build.js --prod`）才会 minify；直接 `node build.js` 出的是带 sourcemap 的开发包
- v0.4.6 起 release notes 不再由 `git log` 拼：push tag 后 `.github/workflows/release.yml` 用 awk 从**该 tag 提交树里的** `CHANGELOG.md` 抽取 `## <tag>` 一节（双语 `###` 条目）直接当 `--notes-file`；缺文件 / 缺章节 / 空章节一律 `::error` + `exit 1`。发版流程：把 `## Unreleased` 改名为 `## <version>` → 提交 → 打同名 tag → push。历史 tag（0.3.0–0.4.4，树里没有 CHANGELOG.md）重跑该 workflow 会失败，属既定取舍（既往版本视为冻结）
- v0.4.0 的两个问题（打字闪烁、锚点金黄）均已修复（根因见上）；**修复效果待用户实机复测**
- 锚点若仍偏金黄：F1 跑 `Debug: Dump Block DOM at Cursor`，把剪贴板内容贴回来即可精确定位

## 关键实现速查

- 评论元数据解析在 parser.ts 的 `parseCommentMeta`（独立导出，thread.ts 复用）
- acceptAll/rejectAll 采用整文替换：getMarkdown → 纯函数变换 → 全选 #write → pasteHandler（单步 undo）
- 单条 accept/reject/评论编辑：DOM 文本流扫描定位 raw 串 → rangy 选中 → pasteHandler 替换
- 面板编辑豁免：controller.writeBackCounter > 0 期间 edit 事件不触发 refreshPanel（防打字被打断）
- 空评论流：插入 → 面板 open → 550ms 后 refreshPanel + focusByNavKey 直接聚焦编辑框
- v0.4.4 徽章点击：`commentCaretOffset(raw)` 算正文起点 → `focusCommentChip(el)`（先 `setReveal` 后 `placeCaret`）→ 回调 `highlightByNavKey` 闪卡片；监听挂在 `attachPointerFocus(#write)`
- v0.4.5 面板刷新：数据只在 `mdEditor.on('edit')` 时重建 ⇒ 打开/展开面板必须显式刷（`onPanelOpened` + `toggle` 后 `refreshReviewPanel`）；`isVisible()` 用 `rightSplit.collapsed !== true` 判定，收起时不刷
- v0.4.5 reply 跳转：`onNavigateComment(entry, replyIndex?)` → `commentNavKey(thread.replies[i] ?? thread.first)`；`commentNavKey` 是"去锚定前缀"的唯一出处（thread.ts）
- ReviewView 构造签名：(leaf, callbacks, settings?)——containerEl 自建于 section 元素
- 'typora' 类型解析：npm 别名 `@types/typora@npm:@typora-community-plugin/typora-types`（与官方 example 同款）
- 设置页：SettingTab 基类 addSettingTitle/addSetting + addText/addSelect/addCheckbox
- setting 变更钩子：settings.onChange('*', key)——acceptedViewEnabled 切换即时重渲染

## 格式（方案 C：懒 ID 内联）

- 普通：`{>>Hui|NOTE: body<<}`（author|TYPE: body，13 字符噪声）
- 升级：`{>>rc-a1b2c3|Hui|2026-10-02|NOTE: body<<}`（首次加回复时自动补 id+date）
- 回复：紧跟首块的 `{>>rc-xxxxxx|author|date|REPLY: body<<}`，同 id 相邻串联
- 兼容 orc 老格式：`{>>[author=Hui] body<<}`
- TYPE 标签：ASK/EDIT/PRAISE/NOTE（可选）/REPLY（回复专用）
- 转义：`\`→`\\`、`|`→`\|`、LF→`\n`；解析用 `(?<!\\)\|` 切段
- 分段算法：seg0 匹配 `rc-[0-9a-z]{6}` → id；剩余 ≥3 段 → author/[date]/body；=2 段 → author/body；=1 段 → 纯 body（无 author）；body 剥 TYPE 前缀
- 无 `|` 单段以 `TYPE: ` 开头 → 有 type 无 author

## 关键 API（typora-community-plugin v2.10.21+，均已实测源码）

- 命令：`this.registerCommand({id,title,scope:'global',callback})` → F1 面板（showInCommandPanel 默认 true）
- 右侧栏：`app.viewManager.registerView(type, factory)` + `app.commands.run('core.workspace.right-split:ensure-leaf', ['typ://<type>/<name>'])` + `app.workspace.rightSplit.expand()/toggle()`（照抄 tpov right-dock.ts 70 行）
- postprocessor：`app.features.markdownEditor.postProcessor.register(HtmlPostProcessor.from({selector?, process(el,ctx)}))`；edit 事件 400ms debounce 后自动 processAll；leaf:open 也触发；预览模式 containerEl 是 `.typ-markdown-view`
- 写回原语：rangy 选中 → `editor.UserOp.pasteHandler(editor, text, true)`（bibtex-citation v3 已验证，undo/光标/重解析正确）
- `editor.EditHelper.showNotification(msg)` 通知
- `app.features.markdownEditor.on('edit'|'scroll')`、`.selection.save()/restore()`
- WorkspaceView 基类（tpov outline-view.ts 为模板）：containerEl、onOpen/onClose

## 解析器（src/critic/，44 测试全绿）

- parseTokens：fence 跳过（``` 与 ~~~）→ 五类正则候选 → overlap 归一（先到先得）→ anchored 合并（highlight+comment 中间仅空白）
- anchored comment：comment.from 扩展覆盖 highlight，raw 拼接（accept/reject 整块替换）
- buildCommentThreads：相邻（between 仅空白，`<=` 含紧贴）同 id 聚合；无 id 单块自成线程
- resolve.ts：acceptToken/rejectToken 纯函数；applyTokenReplacements 逆序替换
- thread.ts：buildThreadMarkupWithReply（懒 ID 升级+追加回复）/ buildThreadWithNewBody（只改首块 body，保留回复）/ buildPlainCommentMarkup / buildAnchoredCommentMarkup

## 待实测风险（用户实机）

- pasteHandler 写回后面板 textarea 焦点归还
- 面板编辑态与 edit 事件刷新的豁免时序
- 预览模式 postprocessor 实际触发
- anchored 写回：rangy 范围跨 span（{==a==}{>>...<<} 在 Typora DOM 里可能被 md-inline 分割）

## 许可证红线

- orc (MIT)：解析器结构已移植，保留版权注释 ✓
- orc2 (AGPL-3.0)：代码一行都不能抄，仅借鉴格式设计（懒 ID/TYPE/回复）——格式与协议不受版权保护，实现全部独立重写 ✓
