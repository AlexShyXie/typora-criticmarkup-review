# Changelog

Single source of truth for release notes. Entries are bilingual: English first, then Chinese.

Release flow: accumulate changes under `## Unreleased`, then rename that section
to `## <version>` in the commit you tag. Pushing tag `<version>` triggers
`.github/workflows/release.yml`, which copies this section into the GitHub
release notes. A tag without a matching section fails the build.

## Unreleased

## 0.4.8

### Editor → panel sync: flash the card under the caret

Clicking into any CriticMarkup in the editor (change, comment, consumed
`==`/`~~` shape) now scrolls the right panel to the matching entry and
flashes it egg-yellow for 1s — the reverse direction of the existing
panel → editor navigation.

- Fired when the caret settles inside a reveal unit; debounced to unit
  changes only (typing inside the markup does not re-flash).
- Comments match by their nav key, changes by file-space raw; consumed
  shapes are re-synthesized before matching (`{x}` → `{==x==}`).
- No-op while the dock is closed, or while a panel editor box has focus
  (never yanks focus/scroll mid-edit).
- Also fixed: the v0.4.4 chip-click flash never worked (the cards were
  never stamped with `data-entry-id`); it now shares this path — and the
  flash color changed from blue to egg-yellow, duration 1.2s → 1s.
- r2 fix: rapid clicks between markups left every visited card lit
  forever (the single removal timer was cancelled on each new hit before
  its callback ran). Now every already-lit card is cleared the moment a
  new one flashes — exactly one card can be lit at any moment.
- r3 fix: clicking a panel entry (or its quote row) used to flash the
  very card that was clicked — the jump lands the caret inside the target
  markup, and that arrival fired the caret flash (a feedback loop). The
  navigation now swallows exactly that one notification (one-shot, 800ms
  self-expiry); DIRECT clicks inside the editor's markup — and only
  those — flash the panel.

### 编辑器 → 面板联动：光标所在标记的卡片闪黄

在编辑器里点击任何 CriticMarkup（修订、评论、被消费的 `==`/`~~` 形态），
右侧面板自动滚动到对应条目并蛋黄色高亮 1 秒——与既有的"面板 → 编辑器"
导航形成双向联动。

- 光标在标记内落定时触发；按"标记变化"防抖（标记内打字不会反复闪）。
- 评论按 nav key 匹配，修订按源文件拼写匹配；消费形态先还原
  （`{x}` → `{==x==}`）再匹配。
- 面板未打开时不动作；面板编辑框聚焦时不打断（不抢焦点不滚动）。
- 顺带修复：v0.4.4 的 chip 点击高亮从未生效过（卡片从未打
  `data-entry-id`），现在共用本路径；闪色由蓝改蛋黄色，时长 1.2s → 1s。
- r2 修复：在标记间快速点击时，每张被点过的卡片会永久卡亮（单一移除
  计时器在每次新触发时被取消，旧卡片的移除回调永远不再执行）。现在
  新卡片亮起前先熄灭所有已亮卡片——任意时刻最多一张卡片处于高亮。
- r3 修复：点击面板条目（或其引用行）时，被点的那张卡自己也会闪——
  跳转把光标落进目标标记，这个"落定"又触发了光标闪卡（反馈环）。现在
  导航会恰好吞掉这一次通知（一次性、800ms 自过期）；只有**在笔记里
  直接点击标记**才闪面板。

## 0.4.7

### Comment without a selection: anchorless rc-notes

`Comment on Selection` (F1 / 💬 panel button) no longer requires selected
text. With a selection the anchored form is unchanged (`{==text==}{>>..<<}`);
with the caret in plain text it inserts a standalone note right at the caret:

- Form: `{>>rc-xxxxxx|Hui|2026-10-08|NOTE: <<}` — thread id + date from the
  start, so replies append to the same thread with no upgrade rewrite and the
  panel key is stable from day one.
- The panel opens and focuses the empty comment for immediate typing
  (same flow as the anchored path).
- Guard: inserting while the caret sits inside existing CriticMarkup is
  blocked with a notification (nested markup would break parsing).

### 无选中也能评论：无锚定的 rc 笔记

`Comment on Selection`（F1 命令 / 面板 💬 按钮）不再强制选中文本。有选中时锚定形式不变
（`{==文本==}{>>..<<}`）；光标位于普通文本时，在光标处插入独立笔记：

- 形态：`{>>rc-xxxxxx|Hui|2026-10-08|NOTE: <<}` —— 从一开始就带线程 id 和日期，
  回复直接追加到同一线程、无需升级改写，面板条目键从第一天起就稳定。
- 插入后面板自动打开并聚焦空评论，可直接输入（与锚定路径同款流程）。
- 防御：光标位于已有 CriticMarkup 内部时阻止插入并提示（嵌套标记会破坏解析）。

## 0.4.6

### fix replace panel bug

### 修补替换标记在右侧面板的bug。

