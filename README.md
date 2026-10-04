# Typora CriticMarkup Review

English | [简体中文](https://github.com/AlexShyXie/typora-criticmarkup-review/blob/main/README.zh.md) | 

A CriticMarkup revision & review plugin for Typora: mark additions / deletions / substitutions / highlights, write typed, authored comment threads, and review, jump and accept/reject every change from a single right-dock panel. Built for [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin) (v2.10.21+); every command is registered in the F1 command palette.

Feature-wise it matches [obsidian-review-critics](https://github.com/rohrbachd/obsidian-review-critics) (the parser structure is ported from it, MIT), and the comment format follows the lazy-id thread idea of [obsidian-review-comments](https://github.com/shotashirai1719/obsidian-review-comments) — the implementation was rewritten from scratch and uses none of its code.

## Install

- **From a release**: download `plugin.zip` from the [Releases](https://github.com/AlexShyXie/typora-criticmarkup-review/releases) page and install it through the community-plugin installer.
- **Manual**: unzip `plugin.zip` into your plugins folder so that it reads `<plugins>/criticmarkup-review/{main.js, style.css, manifest.json}`, then reload Typora.

## Syntax (CriticMarkup)

| Markup | Meaning | Rendered as |
|---|---|---|
| `{++added++}` | Addition | green underline |
| `{--deleted--}` | Deletion | red strikethrough |
| `{~~old~>new~~}` | Substitution | red strikethrough + green underline |
| `{==highlighted==}` | Highlight | yellow background |
| `{>>comment<<}` | Comment | small blue badge |

## Comment format (lazy-id threads)

```markdown
This sentence has a {==problem==}{>>Hui|NOTE: needs an argument<<}, rewrite it.

# Adding a reply upgrades the pair to a thread (id + date, same id chains them)
This sentence has a {==problem==}{>>rc-a1b2c3|Hui|2026-10-02|NOTE: needs an argument<<}{>>rc-a1b2c3|Claude|2026-10-03|REPLY: rewritten<<}
```

- `author|TYPE: body` is the minimal form; TYPE ∈ ASK / EDIT / PRAISE / NOTE (replies are always REPLY)
- The legacy form `{>>[author=Hui] body<<}` is still understood
- `|` and newlines inside the body are escaped automatically (`\|`, `\n`), so multi-line comments stay on one source line
- Plain comments carry zero extra noise; a `rc-xxxxxx` thread id and dates are written only once a reply exists

## F1 commands (12)

- Mark Selection as Addition / Deletion / Highlight / Substitution
- Comment on Selection (anchors the comment to the selection; the right-dock editor box gets focus right after the write)
- Accept / Reject Change at Cursor
- Accept All Changes, Copy Clean Text (copies the document as if everything were accepted)
- Toggle Accepted View (renders as "all accepted" without touching the file)
- Toggle Review Panel, Refresh Review Panel

## Right-dock panel

- Quick Actions toolbar: + / − / ▮ / ⇄ / 💬 plus Accepted View and Accept All
- Changes: one card per revision with type badge, content and owning section — click to jump, Accept/Reject per card
  - Badges read `addition` / `deletion` / `replace` / `highlight` (v0.4.6: `{~~old~>new~~}` is labelled **replace**, blue; `{==..==}` is **highlight**, egg-yellow — the colour the document paints it with)
  - A standalone `{==..==}` gets its own card (v0.4.6). Accept keeps the text and removes the markup; **Reject deletes the highlighted text** (standard CriticMarkup — note `Reject All` therefore drops every unanchored highlight). A highlight anchored to a `{>>…<<}` is not listed twice: it shows as the yellow quote row on its comment card
  - An anchored comment card shows the `{==..==}` text it refers to in a yellow quote row above the body (v0.4.6); clicking the quote jumps to the anchored region in the document
- Comments: thread cards (author · line · type · body), inline Edit/Reply/Resolve; double-click a comment body or any reply row to edit that entry (double-click since v0.3.1, to avoid accidental edits)
  - Comment body and type can be edited in place; a write-back is refused when the document has changed (prevents misplacement)
  - A card being edited is never interrupted by an editor refresh
- Clicking a comment badge in the editor opens the panel and flashes the matching card
- Opening (or expanding) the panel re-scans the document automatically — no manual Refresh needed; clicking a reply row jumps to that reply's own source (the comment head still jumps to the first comment)

## Rendering behaviour

- Additions / deletions / substitutions / highlights / comments are rendered as styles in WYSIWYG (the markup itself is hidden)
- **Source is revealed per unit** (the same granularity Typora uses for `**bold**`): putting the caret in the anchor area reveals only `{==anchor==}` (the `==`/`~~` are Typora's hidden `.md-meta` spans, forced visible while revealed, so the full source is readable); clicking an ASK badge reveals only that ASK; clicking a REPLY badge reveals only that REPLY; a substitution shows the old word struck through in red and the new one highlighted in green (the native `<del>` line is taken over, so it no longer bleeds onto the new text). Moving the caret away restores the rendered view; typing inside a unit never re-wraps (IME-safe)
- Strip / accept / reject act exactly on the unit under the caret: the anchor area clears only `{==…==}`, a single comment deletes only itself
- Panel write-backs (Edit/Reply/Resolve/Accept) re-render immediately and keep the caret parked — no flash of raw markup

## Comment thread format (lazy id)

- A single comment stays clean and id-less: `{>>Hui|2026-10-03|NOTE: body<<}`
- Once a reply appears, the thread is upgraded to a shared id: `{>>rc-xxxxxx|Hui|2026-10-03|NOTE: body<<}{>>rc-xxxxxx|Hui|2026-10-03|REPLY: reply<<}`
- The id exists only to bind later replies to the first comment (two adjacent comments are otherwise indistinguishable: same thread or two separate ones?); it is invisible in the rendered view
- Resolve keeps the anchored text and removes the whole thread

## Known limits

- Source mode (Ctrl+/) shows the raw markup — same behaviour as Obsidian's source mode
- When a selection spans inline markup such as bold/italic, the wrapper is applied to the selection's plain text; an anchored comment containing inline syntax cannot be Resolved from the panel yet (DOM text and markdown source disagree)
- Track Changes (auto-marking while typing) is not implemented (assessed as high-risk, tracked separately)

Download [Boundary_Test](CriticMarkup_Multiline_Boundary_Test.md) to know the boundary.

## Installation
### Prerequisites
Install and enable the Typora Community Plugin Framework
Project address: https://github.com/typora-community-plugin/typora-community-plugin
### Method 1: Plugin Marketplace (Recommended)
Open Typora → Go to the Preferences of typora-community-plugin → **Plugin Marketplace**, search for `criticmarkup-review`, and install **and enable** it.

### Method 2: Manual Installation
1. Download the latest `plugin.zip` from [Releases](https://github.com/AlexShyXie/typora-criticmarkup-review/releases) and unzip it.
2. Place the unzipped files into the `criticmarkup-reviewr` folder, copy to:
   - Global: `C:\Users\<You>\.typora\community-plugins\plugins\criticmarkup-review\`
   - Or only for the current notebook library: `<Notebook Library>\.typora\plugins\criticmarkup-review\`
3. Open Typora → Go to the Preferences of typora-community-plugin → **Installed Plugins** → Check `criticmarkup-review` to enable it.

> Requires typora-community-plugin ≥ 2.8.2, Typora ≥ 1.5.0.

## License

MIT. The parser structure is ported from obsidian-review-critics (MIT, Daniel Rohrbach) — see LICENSE.md.
