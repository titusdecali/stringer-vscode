<p align="center">
  <img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxOUllPdRtGwJSYT6Bm8zgo9sN2eULKVXRkc4b" alt="Stringer" width="350" />
</p>

<h1 align="center">Stringer i18n Helper</h1>

<p align="center">
  <b>The VS Code companion for <a href="https://stringer-cli.com">Stringer CLI</a></b>
</p>

<p align="center">
  Add i18n keys manually • Preview translations inline • Keep locales in sync
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=titusdecali.stringer-helper">Install Extension</a> · 
  <a href="https://docs.stringer-cli.com/vscode-extension">Documentation</a> · 
  <a href="https://discord.gg/hSfeCkej4y">Discord</a>
</p>

---

## Quick Start

1. Install [Stringer CLI](https://stringer-cli.com) and run `stringer convert` in your project
2. Install this extension
3. Start using the features below

> **Note:** You must run Stringer CLI at least once to create the config file this extension needs.

---

## Features

### 1. Add i18n Keys Manually

When Stringer CLI misses a string (it happens!), add it yourself in seconds.

**How to use:**
1. Select any text in your code
2. Right-click → **"🌎 Add i18n key via Stringer"**

**Before:**
```vue
<template>
  <h1>Welcome to our app</h1>
</template>
```

**After:**
```vue
<template>
  <h1>{{ t('components.header.0242') }}</h1>
</template>
```

Keys use the format `keyPath.4-digit-code` where `keyPath` is based on your file path (e.g., `components/Header.vue` → `components.header`).

The extension automatically:
- Adds the string to your base locale file (`en.json`)
- Replaces the text with the correct `t()` call
- Injects `const { t } = useI18n()` if needed (Vue/Nuxt)
- Detects context (template, attribute, script) and uses the right syntax

---

### 2. Inline Translation Previews

See translations directly in your code without switching files.

**What you see:**
```vue
<h1>{{ t('components.header.0242') }}</h1>  <!-- "Welcome to our app" -->
```

**Preview modes:**

| Mode | What it shows |
|------|---------------|
| **Text only** | Just the translated text |
| **Key + text** | Both the key and translation |
| **Off** | No previews |

**Change the mode:**
- Click the **eye icon** in the status bar
- Or run: `Stringer: Change Preview Mode`

---

### 3. Switch Preview Language

Preview your app in any language without changing your locale settings.

**How to use:**
- Click the **globe icon** in the status bar
- Select a language (e.g., Spanish, French, Japanese)

```vue
<!-- Previewing in Spanish -->
<h1>{{ t('components.header.0242') }}</h1>  <!-- "Bienvenido a nuestra app" -->
```

---

### 4. Missing Key Detection

Spot missing translations instantly with red indicators.

```vue
<!-- When a key is missing in Spanish -->
<p>{{ t('pages.home.8835') }}</p>  <!-- ⚠️ Locale Key Missing!! -->
```

**Fix it:** Run `Stringer: Align Translations` or `stringer align` in terminal.

---

### 5. Align Translations

Keep all your locale files in sync with one click.

**How to use:**
1. Click **"Stringer"** in the status bar
2. Select **"Align Translations"**

This runs `stringer align` which copies new keys from your base language to all other locales.

---

### 6. Revert to Original Text

Changed your mind? Revert an i18n key back to the original text.

**How to use:**
1. Place your cursor on a `t('...')` call
2. Right-click → **"↩️ Revert to original text"**

**Before:**
```vue
<h1>{{ t('components.header.0242') }}</h1>
```

**After:**
```vue
<h1>Welcome to our app</h1>
```

---

### 7. Ignore Lines or Files

Tell Stringer CLI to skip specific code.

**Right-click menu options:**
- **"🚫 Ignore this line"** — Adds `// @stringer-ignore-next-line` above the current line
- **"🚫 Ignore this file"** — Adds `// @stringer-ignore` at the top of the file

---

## Status Bar

The extension adds helpful buttons to your status bar:

| Button | What it does |
|--------|--------------|
| **Stringer** | Opens the main menu (align, docs, billing) |
| **👁 Preview** | Change preview mode |
| **🌐 Lang** | Change preview language |

---

## Supported Frameworks

| Framework | Injection Style |
|-----------|-----------------|
| Vue / Nuxt | `const { t } = useI18n()` |
| React | `import { useTranslation } from 'react-i18next'` |
| Next.js | `import { useTranslations } from 'next-intl'` |

---

## Settings

Open VS Code settings and search for "Stringer" to customize:

| Setting | Default | Description |
|---------|---------|-------------|
| `enableInlinePreview` | `true` | Show inline translation previews |
| `defaultPreviewLanguage` | `""` | Default language for previews |
| `inlinePreviewKeyMode` | `hidden` | Preview style: `hidden`, `full`, or `leaf` |
| `previewBackgroundColor` | `hsl(270, 55%, 43%)` | Badge background color |
| `autoAlignAfterAdd` | `false` | Auto-run align after adding a key |
| `framework` | `auto` | Force framework: `auto`, `vue`, `react`, `next` |

---

## Troubleshooting

### "Stringer CLI config not found"

Run any Stringer CLI command first:
```bash
stringer
```

This creates the config file (`~/.stringer-cli.json`) the extension needs.

### Previews not showing

1. Check that your locale files exist in the configured `outputDir`
2. Run `Stringer: Reload Locales` from the command palette
3. Make sure `enableInlinePreview` is `true` in settings

---

## Links

- **Website:** [stringer-cli.com](https://stringer-cli.com)
- **Docs:** [docs.stringer-cli.com](https://docs.stringer-cli.com)
- **Discord:** [Join our community](https://discord.gg/hSfeCkej4y)
- **Billing:** [stringer-cli.com/billing](https://stringer-cli.com/billing)

---

<p align="center">
  Built to work hand-in-hand with <b>Stringer CLI</b> for a smooth i18n workflow. Happy localizing! 🌍
</p>
