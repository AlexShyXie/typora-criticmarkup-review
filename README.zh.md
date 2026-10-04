# CriticMarkup Review — typora-community-plugin

简体中文 | [English](https://github.com/AlexShyXie/typora-criticmarkup-review/blob/main/README.md)

CriticMarkup 修订与批注插件：在 Typora 里标记增/删/改/高亮，写下带类型和作者的评论线程，并在右侧栏的统一面板里审阅、跳转、接受/拒绝全部更改。面向 typora-community-plugin（v2.10.21+）开发，命令全部注册进 F1 命令面板。

功能对标 [obsidian-review-critics](https://github.com/rohrbachd/obsidian-review-critics)（解析器结构自其移植，MIT），评论格式设计参考 [obsidian-review-comments](https://github.com/shotashirai1719/obsidian-review-comments) 的懒 ID 线程方案（实现全部独立重写，未使用其任何代码）。

## 语法（CriticMarkup）

| 标记 | 含义 | 渲染 |
|---|---|---|
| `{++新增++}` | 添加 | 绿色下划线 |
| `{--删除--}` | 删除 | 红色删除线 |
| `{~~旧~>新~~}` | 替换 | 红删绿增 |
| `{==高亮==}` | 高亮 | 黄色底纹 |
| `{>>评论<<}` | 评论 | 蓝色小徽章 |

## 评论格式（懒 ID 线程）

```markdown
这句话有{==问题==}{>>Hui|NOTE: 论证不足<<}，需要重写。

# 加回复时自动升级为线程（补 id + 日期，同 id 串联）
这句话有{==问题==}{>>rc-a1b2c3|Hui|2026-10-02|NOTE: 论证不足<<}{>>rc-a1b2c3|Claude|2026-10-03|REPLY: 已重写<<}
```

- `作者|TYPE: 正文` 为最小格式；TYPE ∈ ASK / EDIT / PRAISE / NOTE（回复固定 REPLY）
- 兼容旧格式 `{>>[author=Hui] body<<}`
- 正文内的 `|`、换行自动转义（`\|`、`\n`），多行评论保持单行存储
- 普通评论零额外噪声；只有出现回复时才写入 `rc-xxxxxx` 线程 id 与日期

## F1 命令（12 条）

- Mark Selection as Addition / Deletion / Highlight / Substitution
- Comment on Selection（选区锚定评论，写入后右侧栏自动聚焦编辑框）
- Accept / Reject Change at Cursor
- Accept All Changes、Copy Clean Text（复制全部接受后的干净文本）
- Toggle Accepted View（按“全部接受”渲染，不改动文件）
- Toggle Review Panel、Refresh Review Panel

## 右侧栏面板

- Quick Actions 工具条：+ / − / ▮ / ⇄ / 💬 与 Accepted View、Accept All
- Changes 区：每条修订显示类型徽章、内容、所属章节，点击跳转，Accept/Reject 单条处理
- Comments 区：线程卡片（作者 · 行号 · 类型 · 正文 · 锚点引文），内联 Edit/Reply/Resolve；双击评论正文或任一回复行可直接编辑该条（v0.3.1 起为双击，避免误触）
  - 面板内直接编辑评论正文与类型；文档若已变化则拒绝写回（防错位）
  - 编辑中的卡片不会被编辑器刷新打断
- 编辑区评论徽章点击 → 打开面板并高亮对应卡片
- F1 打开/展开面板即自动重扫文档（无需再手动 Refresh）；点击 reply 行跳到该条 reply 自己的源码（comment 头仍跳首条 comment）

## 渲染行为

- 增/删/改/高亮/评论在所见即所得中渲染为样式（标记语法隐藏）
- **按单元显示源码**（与 Typora 对 `**粗体**` 的行为一致，粒度到每个单元）：点/光标落在锚点区只显示 `{==锚文本==}`（`==`/`~~` 实为 Typora 的 `.md-meta` 隐藏跨度，reveal 时由样式强制显示，完整源码可见）；点 ASK 徽章只显示 ASK 自己的源码；点 REPLY 徽章只显示 REPLY 的源码；替换标记显示旧词红色删除线 + 新词绿色高亮（原生 `<del>` 删除线已被接管，不再波及新词）。光标移开自动恢复渲染；在单元内打字零重包裹（输入法安全）
- 清除/接受/拒绝按光标所在单元精确作用：锚点区只清 `{==…==}`、单条评论只删自己
- 面板写回（Edit/Reply/Resolve/Accept）后立即重渲染并驻留光标，不会闪现源码

## 评论线程格式（懒 ID）

- 单条评论保持干净、无 ID：`{>>Hui|2026-10-03|NOTE: 正文<<}`
- 一旦产生回复，线程升级为共享 ID 绑定：`{>>rc-xxxxxx|Hui|2026-10-03|NOTE: 正文<<}{>>rc-xxxxxx|Hui|2026-10-03|REPLY: 回复<<}`
- ID 仅用于把后续回复绑定到首条评论（否则两个相邻评论无法区分是"同一线程"还是"两条独立评论"）；渲染视图中完全不可见
- Resolve 保留锚定文本、移除整个线程

## 已知边界

- 源码模式（Ctrl+/）显示原始标记——与 Obsidian source mode 行为一致
- 选区跨粗体/斜体等行内标记时，包裹标记会作用于选区纯文本；含行内格式语法的锚定评论暂不能从面板 Resolve（DOM 文本与 markdown 源不一致）
- Track Changes 自动修订（打字自动生成标记）未实现（评估为高风险项，独立攻坚）

## 开发

```bash
npm install
npm run test        # vitest（35 用例）
npm run typecheck   # tsc --noEmit
npm run build       # esbuild -> dist/main.js + dist/main.css
npm run pack        # 构建 + 打包到 out/（版本化 + latest），并在根目录生成 plugin.zip
npm run deliver     # 同上，再把 out/latest 拷进本机 Typora 插件目录
```

推送数字 tag 会触发 `.github/workflows/release.yml`：装依赖 → 打包 → 把 `plugin.zip` 作为发布资产发布。

打包产物（out/ 与 plugin.zip 已 git-ignore）：

| 路径 | 内容 |
|---|---|
| `plugin.zip`（根目录） | 发布资产，扁平的 main.js + style.css + manifest.json |
| `out/criticmarkup-review-<version>/` | main.js + style.css + manifest.json |
| `out/criticmarkup-review-<version>.zip` | 该版本安装包（历史留档） |
| `out/latest/`、`out/criticmarkup-review.zip` | 始终指向当前版本 |

分发目标目录可用 `TYPORA_PLUGIN_DIR` 覆盖；默认 `criticmarkup-review-delivery`。

## 许可

MIT。解析器结构移植自 obsidian-review-critics（MIT，Daniel Rohrbach），见 LICENSE.md。
