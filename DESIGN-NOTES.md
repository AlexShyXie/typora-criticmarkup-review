# CriticMarkup Review for Typora — 设计决策速查

> v0.3.1（2026-10-03 深夜第八轮）。所有决策均已用户拍板或由调研证实。

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

- vitest 23/23 全绿（critic-thread 14 + critic-core 9）；tsc --noEmit 零错误；esbuild 生产构建通过
- 产物：dist/main.js + dist/main.css + manifest.json → criticmarkup-review.zip
- v0.1.0 的三个问题均已修复（根因见上）；**修复效果待用户实机复测**

## 关键实现速查

- 评论元数据解析在 parser.ts 的 `parseCommentMeta`（独立导出，thread.ts 复用）
- acceptAll/rejectAll 采用整文替换：getMarkdown → 纯函数变换 → 全选 #write → pasteHandler（单步 undo）
- 单条 accept/reject/评论编辑：DOM 文本流扫描定位 raw 串 → rangy 选中 → pasteHandler 替换
- 面板编辑豁免：controller.writeBackCounter > 0 期间 edit 事件不触发 refreshPanel（防打字被打断）
- 空评论流：插入 → 面板 open → 550ms 后 refreshPanel + focusByNavKey 直接聚焦编辑框
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
