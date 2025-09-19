<div align="center" style="font-weight: bold; margin-top: 10px; margin-bottom: 10px; font-size: 2em;">
Stringer i18n Helper (VS Code Extension)
</div>

<div align="center" style="font-weight: bold; margin-top: 10px; margin-bottom: 10px;">
This extension is a companion to the Stringer CLI.
</div>

<div align="center" style="font-weight: bold; padding: 5px 0; margin-top: 10px; margin-bottom: 10px; background: linear-gradient(90deg, #47FFC5 0%, #00FF77 100%); color: #000000;">
This is a BETA and currently only supports VUE & NUXT projects!!
</div>

<div align="center" style="background: linear-gradient(90deg, #FF4794 0%, #FF7700 100%); color: #fff; padding: 12px 0; border-radius: 7px; font-weight: bold; font-size: 1.1em;">
  You must run the Stringer CLI in your project folder at least once to use this extension.
</div>

<div align="center" style="font-weight: bold; margin-top: 10px;">
  Install and try the CLI for free at: <a href="https://stringer-cli.com" target="_blank">https://stringer-cli.com</a>.
</div>

<div align="center" style="margin: 30px 0 30px 0;">
If <b>Stringer CLI</b>'s AI model struggles to translate a string in your project, <br>this extension provides a fast way to add new internationalization (i18n) keys.<br>
It then helps you synchronize translations across all your language files with these new keys.
</div>

<div align="center">
  <img src="https://c81fz8ovlk.ufs.sh/f/pOylDC1T5WMxOUllPdRtGwJSYT6Bm8zgo9sN2eULKVXRkc4b" alt="Stringer CLI" width="400" />

  **Effortless i18n for modern web apps**
  
  Transform your codebase into a globally-ready application with intelligent string extraction, seamless translation workflows, and framework-specific optimizations.
  
  [🚀 Get Started](https://stringer-cli.com) • [📚 Documentation](https://docs.stringer-cli.com) • [💬 Join our Discord](https://discord.gg/hSfeCkej4y)
</div>

> What is Stringer CLI?
>
> Stringer CLI is a powerful developer tool that automates adding multilingual support in modern
> web frameworks (Vue, Nuxt, React, Next). It extracts user‑visible strings, converts them to
> i18n calls, generates your locale files, and translates them to 40+ target languages.

## Why this helper?

Automations are great, but real projects always have a few tricky strings that are hard to
convert automatically — maybe they live in unusual code paths, sit inside framework‑specific
APIs, or were simply ambiguous enough that the CLI chose to play it safe. This helper is
built for those moments: quickly add the exact strings you want to your i18n system with
surgical precision, right where you’re working.

In plain terms: if there’s a string you know should be part of your i18n, but the CLI didn’t
convert it automatically, select it and run the helper. It will add the string to your base
language file with a unique key and replace the source with the correct i18n call — context‑aware.

Then, simply click the `Stringer` button in the bottom status bar of your VSCode / Cursor window to open the Stringer menu.
From there, you can trigger the `Align Translations` command to align any other locale files to your base language file via the Stringer CLI.

---

## What this extension does

- Adds a context menu action: **"🌎 Add i18n key via Stringer"**
- Writes the selected text into your base language JSON using a globally unique 4‑digit leaf key
- Replaces the selection in your source file with the correct i18n call
- Detects context (Vue templates, attributes, script literals) and applies the right syntax
- Offers a quick, non‑blocking prompt to align other locale files (only when targets exist)
- Provides a status bar button to open a small Stringer menu (align, website, docs, billing)
- Shows inline translation previews for `t('key.path')` calls using your project locales
- Hover over a `t('key.path')` call to see the original i18n key and current value
- Change the active preview language from the status bar or command palette
- Multiple inline preview modes: Key + locale preview, or Locale-only preview that overlays the translated value
- Highlights missing keys in the active preview language (in Vue templates) with a red inline indicator so you can fix alignment fast

## Usage

1) Ensure you’ve run the Stringer CLI at least once in your project folder, including running the stringer `convert` flow.
2) Select user‑visible text in your source file.
3) Right‑click → **"🌎 Add i18n key via Stringer"**.
4) The extension:
   - Adds the string to `<outputDir>/<baseLanguage>.json` under a unique 4‑digit key
   - Replaces your selection with a context‑appropriate call (`t(...)`, `{{ t(...) }}`, or `:attr="t(...)"`)
   - Injects `const { t } = useI18n()` into .vue files if needed
   - Shows a non‑blocking align suggestion if other locale files exist

### Inline translation preview

- Open a `.vue` file that contains `t('...')` calls.
- The extension reads your Stringer CLI config from `~/.stringer-cli.json` (matching your open workspace) to find `outputDir` and `baseLanguage`, then loads locale JSON files.
- It displays an inline preview of the resolved translation after each `t('key.path')` call.
- Hover on a `t('...')` call to see the original key and the current language value.

### Preview modes

- <b>Key + locale preview</b>: Shows the full key plus the translated value next to the call.
- <b>Locale-only preview</b>: Hides the original `t('...')` code visually and overlays just the translated value inline for a clean reading view.
- <b>Off</b>: No inline preview decorations are shown.

You can switch modes from:

- Status bar: click the “Preview” eye → select a mode.
- Command palette: run `Stringer: Change Preview Mode`.
- Control Panel: run `Stringer: Open Control Panel` and change the mode there.

### Change preview language

- Click the “Lang” globe in the status bar → select a locale; or
- Run command: `Stringer: Change Preview Language`.

By default, the preview language is your configured `baseLanguage`. You can set a persistent default in settings.

### Missing key highlighting

- When the active preview language is missing a key that is used inside Vue template text, the inline preview shows a red indicator with “Locale Key Missing!!”.
- This is a strong signal that your target locales are out of sync with the base language.
- Fix it by running alignment: click the status bar “Stringer” button → pick “Align Translations”, or run `stringer align` in your terminal.

### Control Panel

- Open with `Stringer: Open Control Panel`.
- Change preview mode and preview language, reload locales, and open quick links for the website, docs, and billing.

### Settings

- `stringerHelper.enableInlinePreview` (boolean, default `true`): toggle inline previews on/off.
- `stringerHelper.defaultPreviewLanguage` (string, default empty): set a preferred preview language code. If empty, falls back to `baseLanguage` from your CLI config.
- `stringerHelper.inlinePreviewKeyMode` (string, default `hidden`): choose the preview content. Supported values: `full` (key + text), `hidden` (text only).
- `stringerHelper.hoverShowsKey` (boolean, default `true`): show the i18n key in hover tooltips.
- `stringerHelper.autoAlignAfterAdd` (boolean, default `false`): when adding a new key via the command, automatically trigger `stringer align` if other locale files exist.

Notes:
- Make sure you’ve run any Stringer CLI flow at least once so `~/.stringer-cli.json` exists and your project is registered.
- Locale changes are watched live; edits to `<outputDir>/*.json` refresh previews automatically.

## Troubleshooting

- **"Stringer CLI config not found"**
  - Run any Stringer CLI command (e.g., `stringer help`) from the project root to create/update `~/.stringer-cli.json`
  - Confirm the `projectName`/`projectPath` match your open folder

## Learn more

- Website: `https://stringer-cli.com`
- Docs: `https://docs.stringer-cli.com`
- Billing: `https://stringer-cli.com/billing`

---

Built to work hand‑in‑hand with the **Stringer CLI** for a smooth, delightful i18n
workflow right inside VS Code. Happy localizing! 🌍
