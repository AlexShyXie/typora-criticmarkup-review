# Changelog

Single source of truth for release notes. Entries are bilingual: English first, then Chinese.

Release flow: accumulate changes under `## Unreleased`, then rename that section
to `## <version>` in the commit you tag. Pushing tag `<version>` triggers
`.github/workflows/release.yml`, which copies this section into the GitHub
release notes. A tag without a matching section fails the build.

## Unreleased

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

