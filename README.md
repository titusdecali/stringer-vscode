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

## What is this for?

This VS Code extension is a companion to [Stringer CLI](https://stringer-cli.com)—the AI-powered i18n tool that automatically extracts and translates strings in your codebase.

This `i18n Helper` extension shows translation previews inline in your code and let's you easily add i18n keys. It also lets you trigger some Stringer CLI commands from within VS Code such as `Align Translations`.

> ⚠️ **Requires Stringer CLI** — This extension only works with projects that have been processed by Stringer CLI.

---

## Quick Start

1. Install [Stringer CLI](https://stringer-cli.com) and run the `convert` flow in your project
2. Install this extension
3. Start using the features below

---

## Smart Locale Detection

The extension automatically finds the nearest `locales` folder relative to your active file. This works seamlessly with monorepos containing multiple locale directories—each file always displays translations from its correct locale folder.

---

## Features

### 1. Inline Translation Previews

See translations directly in your code without switching files.

**Preview modes:**

| Mode | What it shows |
|------|---------------|
| **No Preview** | Hide all inline translations (same as without the extension) |
| **Key + Locale** | Show full key and translation |
| **Locale Only** | Show translation only |

---

**Mode 1: No Preview**

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMx35wDhNKYjqG7AZN1DnQa0P6iR94vShMJtspg" alt="No Preview mode" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

**Mode 2: Key + Locale Preview**

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxmJVk1udLm6IDJ4XKro19PaqHNzYigRBA2Gdl" alt="Key + Locale Preview mode" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

**Mode 3: Locale Only Preview**

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxCJkN3rnyJh7YzOR8f3VcmeaGEdBtMPuWN9si" alt="Locale Only Preview mode" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

**Change the mode:**
- Click the **eye icon** in the status bar
- Or run: `Stringer: Change Preview Mode`

---

### 2. Add i18n Keys Manually

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

### 4. Missing Key Detection

Spot missing translations instantly with red indicators.

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxJfKNHVseTUu4iXbmOcV85AHzQMIt9LDshJEe" alt="Missing key indicator" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

**To fix it:** 

CAST 1: No values exist in the baseLanguage file after conversion: `Manually right click the value and select "Add i18n key via Stringer"`.
CASE 2: In the case that baseLanguage values exist: Run `Stringer: Align Translations` or `stringer align` in terminal.

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
NOTE: This feature only works to revert basic string conversions, and is not yet capable of reverting complex i18n-t tag, or complex pluralization conversions.

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
- **"🚫 Ignore from here"** — Adds `// @stringer-ignore-from-here` at the cursor position

---

## Status Bar

The extension adds helpful buttons to your status bar:

| Button | What it does |
|--------|--------------|
| **Stringer** | Opens the main menu (align, docs, billing) |
| **👁 Preview** | Change preview mode |
| **🌐 Lang** | Change preview language |

**Open the Stringer menu (bottom right corner in VS Code / Cursor):**

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxe1LdqGaRM1phAkmwqjtZOXTeYPzVD9GcrE6F" alt="Stringer menu location" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

**Stringer menu options:**

<img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxKWQ7teg8MVImcFvZXSLeyz2H3A5lxN7wbGRY" alt="Stringer menu options" style="border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />

---

## Troubleshooting

### "Stringer CLI config not found"

Run any Stringer CLI command first:
```bash
stringer
```

This creates the config file (`~/.stringer-cli.json`) the extension needs.

### Previews not showing

1. From the Stringer i18n helper menu, click the `Select locales folder` button and select the folder that contains your locale *.json files.
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
