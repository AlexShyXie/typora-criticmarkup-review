# Changelog

Single source of truth for release notes. Entries are bilingual: English first, then Chinese.

Release flow: accumulate changes under `## Unreleased`, then rename that section
to `## <version>` in the commit you tag. Pushing tag `<version>` triggers
`.github/workflows/release.yml`, which copies this section into the GitHub
release notes. A tag without a matching section fails the build.

## Unreleased

## 0.4.5

### fix replace panel bug

### 修补替换标记在右侧面板的bug。

