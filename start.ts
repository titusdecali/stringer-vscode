import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import os from 'os'

let isProcessingCommand = false
let activePreviewLanguage: string | null = null
let projectContext: {
  projectRoot: string
  localesDir: string
  baseLanguage: string
} | null = null
let localeCache: Record<string, any> = {}
let localeWatcher: vscode.FileSystemWatcher | null = null
let cliConfigWatcher: fs.FSWatcher | null = null
const decorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 0.6em',
    color: new vscode.ThemeColor('editorCodeLens.foreground') as any
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})
const hiddenTextDecorationType = vscode.window.createTextEditorDecorationType({
  // Hide original text when rendering locale-only mode and collapse width
  textDecoration: 'none; opacity: 0; font-size: 0; letter-spacing: 0;'
})
// Separate decoration type for rendering values with 'before' so it is not affected by hidden style
const valueBeforeDecorationType = vscode.window.createTextEditorDecorationType({})

// Utilities to mirror CLI behavior
function isWsl(): boolean {
  try {
    if (process.platform !== 'linux') return false
    const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf-8')
    return /microsoft/i.test(release)
  } catch {
    return false
  }
}

function findCliConfigPath(): string | null {
  const candidates: string[] = []

  // 1) Primary: same location as CLI uses
  const home = os.homedir()
  candidates.push(path.join(home, '.stringer-cli.json'))

  // 2) Windows explicit USERPROFILE (sometimes differs from homedir in edge setups)
  if (process.platform === 'win32') {
    const userProfile = process.env.USERPROFILE
    if (userProfile && userProfile !== home) {
      candidates.push(path.join(userProfile, '.stringer-cli.json'))
    }
    // Common OneDrive profile redirect (rarely needed, harmless to check)
    const oneDrive = process.env.OneDrive || process.env.ONEDRIVE
    if (oneDrive) candidates.push(path.join(oneDrive, '..', '.stringer-cli.json'))
  }

  // 3) WSL: look for Windows home mirror under /mnt/c/Users/*
  if (isWsl()) {
    const base = '/mnt/c/Users'
    try {
      const users = fs.readdirSync(base)
      for (const u of users) {
        candidates.push(path.join(base, u, '.stringer-cli.json'))
      }
    } catch {}
  }

  // 4) Optional override via setting (user can provide an absolute path)
  try {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const override = cfg.get<string>('cliConfigPath')
    if (override && path.isAbsolute(override)) candidates.unshift(override)
  } catch {}

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function readAllCliConfigs(): any[] | null {
  const configPath = findCliConfigPath()
  try {
    if (!configPath) return null
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (_e) {
    return null
  }
}

function getProjectName(projectRoot: string): string {
  try {
    const pkgPath = path.join(projectRoot, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      return pkg.name || projectRoot
    }
  } catch (_e) {}
  return projectRoot
}

function normalizePath(p?: string | null): string | null {
  if (!p) return null
  try {
    return path.resolve(p).replace(/\\/g, '/')
  } catch {
    return p
  }
}

async function loadCliProjectConfig(projectRoot: string): Promise<any | null> {
  const all = readAllCliConfigs()
  if (!all) return null

  const projectName = getProjectName(projectRoot)
  let match = all.find((c: any) => c.projectName === projectName)
  if (match) return match

  // Fallback: match by projectPath
  const rootNorm = normalizePath(projectRoot)
  match = all.find((c: any) => normalizePath(c.projectPath) === rootNorm)
  if (match) return match

  // Fallback 2: match configs whose projectPath contains the current root (handles nested workspaces)
  match = all.find((c: any) => {
    const cp = normalizePath(c.projectPath)
    return !!cp && !!rootNorm && (rootNorm.startsWith(cp) || cp.startsWith(rootNorm))
  })
  return match || null
}

function generateKeyPath(filePath: string, basePath: string): string | null {
  const relativePath = path.relative(basePath, filePath)
  if (!relativePath.includes(path.sep)) return null
  return relativePath
    .replace(/\\/g, '/')
    .replace(/\.[^/.]+$/, '')
    .split('/')
    .join('.')
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true })
}

// ---- Global unique 4-digit key generation ----
function collectAllNumericLeafKeys(
  obj: Record<string, any>,
  used: Set<string> = new Set()
): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    if (/^\d{4}$/.test(k) && typeof v !== 'object') {
      used.add(k)
    }
    if (v && typeof v === 'object') {
      collectAllNumericLeafKeys(v as Record<string, any>, used)
    }
  }
  return used
}

function nextGlobalLeafKey(used: Set<string>): string {
  // Prefer random selection for better distribution
  for (let tries = 0; tries < 500; tries++) {
    const k = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0')
    if (!used.has(k)) return k
  }
  // Fallback: deterministic scan if too many collisions
  for (let i = 0; i < 10000; i++) {
    const k = i.toString().padStart(4, '0')
    if (!used.has(k)) return k
  }
  // Extremely unlikely: generate until unique
  let k = (Math.floor(Math.random() * 10000)).toString().padStart(4, '0')
  while (used.has(k)) {
    k = (Math.floor(Math.random() * 10000)).toString().padStart(4, '0')
  }
  return k
}

function addStringToBaseLanguage(
  baseLangJson: Record<string, any>,
  keyPathPrefix: string,
  text: string
): { updated: Record<string, any>; fullKeyPath: string } {
  const parts = keyPathPrefix.split('.').filter(Boolean)
  const used = collectAllNumericLeafKeys(baseLangJson)

  // Ensure intermediate containers are objects and lift strings when needed
  let container = baseLangJson as any
  for (const part of parts) {
    if (typeof container[part] === 'string') {
      const prev = container[part]
      container[part] = {}
      const prevKey = nextGlobalLeafKey(used)
      used.add(prevKey)
      container[part][prevKey] = prev
    } else if (container[part] === undefined) {
      container[part] = {}
    }
    container = container[part]
  }

  const leafKey = nextGlobalLeafKey(used)
  // Merge rather than overwrite whole file
  setDeepValue(baseLangJson, parts, leafKey, text)

  return { updated: baseLangJson, fullKeyPath: `${keyPathPrefix}.${leafKey}` }
}

function setDeepValue(
  obj: Record<string, any>,
  pathParts: string[],
  leafKey: string,
  value: string
) {
  let node = obj
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i]
    const isLast = i === pathParts.length - 1
    if (!isLast) {
      if (node[part] === undefined) node[part] = {}
      else if (typeof node[part] === 'string') node[part] = { '0000': node[part] }
      node = node[part]
    } else {
      if (node[part] === undefined) node[part] = {}
      else if (typeof node[part] === 'string') node[part] = { '0000': node[part] }
      node[part][leafKey] = value
    }
  }
}

async function withEdit(editor: vscode.TextEditor, replacer: (edit: vscode.TextEditorEdit) => void) {
  await editor.edit((edit) => replacer(edit), { undoStopAfter: true, undoStopBefore: true })
}

async function runAlignInTerminal(cwd: string) {
  const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Stringer Align'), cwd })
  terminal.show()
  terminal.sendText('stringer align', true)
}

// ---------- Simple Vue SFC context detection ----------
function isVueFile(filePath: string): boolean {
  return /\.vue$/i.test(filePath)
}

function getTemplateRange(source: string): { start: number; end: number } | null {
  const open = source.match(/<template(?:\s[^>]*)?>/i)
  if (!open || typeof open.index !== 'number') return null
  const start = open.index + open[0].length
  const closeIdx = source.indexOf('</template>', start)
  if (closeIdx === -1) return null
  return { start, end: closeIdx }
}

function isInsideOpeningOrClosingTag(source: string, offset: number): boolean {
  const lastLt = source.lastIndexOf('<', offset)
  const lastGt = source.lastIndexOf('>', offset)
  return lastLt > lastGt
}

function isVueTemplateTextNode(source: string, offset: number): boolean {
  const tpl = getTemplateRange(source)
  if (!tpl) return false
  if (offset < tpl.start || offset > tpl.end) return false
  if (isInsideOpeningOrClosingTag(source, offset)) return false
  return true
}

function getAttributeContext(
  source: string,
  offset: number
):
  | {
      name: string
      isBound: boolean
      attrStart: number
      valueStart: number
      valueEnd: number
    }
  | null {
  const tpl = getTemplateRange(source)
  if (!tpl) return null
  if (offset < tpl.start || offset > tpl.end) return null

  if (!isInsideOpeningOrClosingTag(source, offset)) return null

  const tagStart = source.lastIndexOf('<', offset)
  const tagEnd = source.indexOf('>', tagStart + 1)
  if (tagStart === -1 || tagEnd === -1 || tagEnd < offset) return null

  const slice = source.slice(tagStart + 1, tagEnd)
  const rel = offset - (tagStart + 1)
  const eqRel = slice.lastIndexOf('=', rel)
  if (eqRel === -1) return null
  const eqAbs = tagStart + 1 + eqRel

  let qIdx = eqAbs + 1
  while (qIdx < tagEnd && /\s/.test(source[qIdx])) qIdx++
  const quote = source[qIdx]
  if (quote !== '"' && quote !== "'") return null
  const valueStart = qIdx + 1
  const valueEnd = source.indexOf(quote, valueStart)
  if (valueEnd === -1 || offset < valueStart || offset > valueEnd) return null

  let nEnd = eqAbs - 1
  while (nEnd > tagStart && /\s/.test(source[nEnd])) nEnd--
  let nStart = nEnd
  while (nStart > tagStart && /[A-Za-z0-9_:\-]/.test(source[nStart - 1])) nStart--
  let rawName = source.slice(nStart, nEnd + 1)
  const isBound = rawName.startsWith(':') || rawName.startsWith('v-bind:')
  const name = rawName.replace(/^:/, '').replace(/^v-bind:/, '')

  return {
    name,
    isBound,
    attrStart: nStart,
    valueStart,
    valueEnd
  }
}

// ---------- Simple React/Next JSX helpers ----------
function isJsxFile(filePath: string): boolean {
  return /\.(jsx|tsx)$/i.test(filePath)
}

function isLikelyJsxUiContext(source: string, offset: number): boolean {
  // Heuristic: inside a JSX element's content or attribute
  const lastLt = source.lastIndexOf('<', offset)
  const lastGt = source.lastIndexOf('>', offset)
  const nextLt = source.indexOf('<', offset)
  const nextGt = source.indexOf('>', offset)
  if (lastLt === -1 || (nextGt === -1 && nextLt === -1)) return false
  // Inside opening tag attributes
  if (lastLt > lastGt) return true
  // Between tags = text content
  if (lastGt > lastLt && nextLt !== -1 && lastGt <= offset && offset <= nextLt) return true
  return false
}

function getJsxAttributeContext(
  source: string,
  offset: number
):
  | {
      name: string
      nameStart: number
      valueStartQuote: number
      valueEndQuote: number
    }
  | null {
  const tagStart = source.lastIndexOf('<', offset)
  const tagEnd = source.indexOf('>', tagStart + 1)
  if (tagStart === -1 || tagEnd === -1 || tagEnd < offset) return null
  const slice = source.slice(tagStart + 1, tagEnd)
  const rel = offset - (tagStart + 1)
  const eqRel = slice.lastIndexOf('=', rel)
  if (eqRel === -1) return null
  const eqAbs = tagStart + 1 + eqRel
  // Find attribute name
  let nEnd = eqAbs - 1
  while (nEnd > tagStart && /\s/.test(source[nEnd])) nEnd--
  let nStart = nEnd
  while (nStart > tagStart && /[A-Za-z0-9_:\-]/.test(source[nStart - 1])) nStart--
  const rawName = source.slice(nStart, nEnd + 1)
  // Find quoted value following '='
  let qIdx = eqAbs + 1
  while (qIdx < tagEnd && /\s/.test(source[qIdx])) qIdx++
  const quote = source[qIdx]
  if (quote !== '"' && quote !== "'") return null
  const valueStartQuote = qIdx
  const valueEndQuote = source.indexOf(quote, valueStartQuote + 1)
  if (valueEndQuote === -1 || offset < valueStartQuote || offset > valueEndQuote) return null
  return { name: rawName, nameStart: nStart, valueStartQuote, valueEndQuote }
}

// ---------- Ensure Vue t() availability ----------
function hasUseI18nTDeclaration(block: string): boolean {
  return /const\s*\{\s*t\s*\}\s*=\s*useI18n\s*\(\s*\)/.test(block)
}

async function ensureVueTDeclaration(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document
  const filePath = doc.uri.fsPath
  if (!isVueFile(filePath)) return

  const text = doc.getText()
  if (hasUseI18nTDeclaration(text)) return

  // Find existing script block
  const scriptOpen = text.match(/<script(?:\s[^>]*)?>/i)
  if (scriptOpen && typeof scriptOpen.index === 'number') {
    const openIdx = scriptOpen.index
    const insertPos = openIdx + scriptOpen[0].length
    const closeIdx = text.indexOf('</script>', insertPos)
    const scriptBlock = closeIdx !== -1 ? text.slice(insertPos, closeIdx) : ''
    if (hasUseI18nTDeclaration(scriptBlock)) return

    const updated = text.slice(0, insertPos) + '\nconst { t } = useI18n()\n' + text.slice(insertPos)
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length))
    await withEdit(editor, (edit) => edit.replace(fullRange, updated))
    return
  }

  // No script block -> create one before <template>
  const tplIdx = text.search(/<template(?:\s[^>]*)?>/i)
  const scriptTag = '<script setup lang="ts">\nconst { t } = useI18n()\n</script>\n\n'
  let updated: string
  if (tplIdx !== -1) {
    updated = text.slice(0, tplIdx) + scriptTag + text.slice(tplIdx)
  } else {
    updated = scriptTag + text
  }
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length))
  await withEdit(editor, (edit) => edit.replace(fullRange, updated))
}

// ---------- Ensure React/Next t() availability ----------
function ensureImported(text: string, importLine: string): { updated: string; changed: boolean } {
  if (new RegExp('^\\s*' + importLine.replace(/[.*+?^${}()|\\[\\]\\\\]/g, '\\$&'), 'm').test(text)) {
    return { updated: text, changed: false }
  }
  // Insert after last import (or at top)
  const rx = /^\s*import\b.*$/gm
  let lastMatch: RegExpExecArray | null = null
  for (let m = rx.exec(text); m; m = rx.exec(text)) lastMatch = m
  if (lastMatch) {
    const idx = (lastMatch.index || 0) + lastMatch[0].length
    return { updated: text.slice(0, idx) + '\n' + importLine + text.slice(idx), changed: true }
  }
  return { updated: importLine + '\n' + text, changed: true }
}

async function ensureReactTDeclaration(editor: vscode.TextEditor, selectionOffset: number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('stringerHelper')
  const style = cfg.get<string>('reactInjection', 'react-i18next')
  if (style !== 'react-i18next') return
  const doc = editor.document
  const text = doc.getText()
  // 1) Ensure import
  const { updated: withImport, changed } = ensureImported(text, "import { useTranslation } from 'react-i18next'")
  let working = withImport
  // 2) Ensure const { t } = useTranslation() inside nearest function before selection
  const fnIdx = (() => {
    // Find nearest "function" or "=>" block start before selection
    const before = working.slice(0, selectionOffset)
    const lastFunc = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=>'))
    if (lastFunc === -1) return -1
    const brace = working.indexOf('{', lastFunc)
    return brace !== -1 ? brace + 1 : -1
  })()
  if (fnIdx !== -1) {
    // Check if already declared in function block following fnIdx (first 300 chars)
    const lookahead = working.slice(fnIdx, fnIdx + 300)
    if (!/\bconst\s*\{\s*t\s*\}\s*=\s*useTranslation\s*\(\s*\)/.test(lookahead)) {
      working = working.slice(0, fnIdx) + "\nconst { t } = useTranslation()\n" + working.slice(fnIdx)
    }
  }
  if (changed || working !== text) {
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length))
    await withEdit(editor, (edit) => edit.replace(fullRange, working))
  }
}

async function ensureNextTDeclaration(editor: vscode.TextEditor, selectionOffset: number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('stringerHelper')
  const style = cfg.get<string>('nextInjection', 'next-intl')
  if (style !== 'next-intl') return
  const doc = editor.document
  const text = doc.getText()
  // 1) Ensure import
  const { updated: withImport, changed } = ensureImported(text, "import { useTranslations } from 'next-intl'")
  let working = withImport
  // 2) Ensure const t = useTranslations() inside nearest function before selection
  const fnIdx = (() => {
    const before = working.slice(0, selectionOffset)
    const lastFunc = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=>'))
    if (lastFunc === -1) return -1
    const brace = working.indexOf('{', lastFunc)
    return brace !== -1 ? brace + 1 : -1
  })()
  if (fnIdx !== -1) {
    const lookahead = working.slice(fnIdx, fnIdx + 300)
    if (!/\bconst\s*t\s*=\s*useTranslations\s*\(\s*\)/.test(lookahead)) {
      working = working.slice(0, fnIdx) + "\nconst t = useTranslations()\n" + working.slice(fnIdx)
    }
  }
  if (changed || working !== text) {
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length))
    await withEdit(editor, (edit) => edit.replace(fullRange, working))
  }
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

function findEnclosingStringLiteralBounds(
  source: string,
  offset: number
): { quote: '"' | "'" | '`'; qStart: number; qEnd: number } | null {
  // Search backward for an opening quote that is not escaped
  let qStart = -1
  let quote: '"' | "'" | '`' | null = null
  for (let i = offset; i >= 0; i--) {
    const ch = source[i]
    if ((ch === '"' || ch === "'" || ch === '`') && !isEscaped(source, i)) {
      qStart = i
      quote = ch as any
      break
    }
    // Stop if we hit a newline and haven't found a quote (heuristic)
    if (ch === '\n') break
  }
  if (qStart < 0 || !quote) return null

  // Ensure offset is after the opening quote (inside the literal)
  if (offset <= qStart) return null

  // Search forward for the closing quote of the same type
  for (let j = qStart + 1; j < source.length; j++) {
    const ch = source[j]
    if (ch === quote && !isEscaped(source, j)) {
      return { quote, qStart, qEnd: j }
    }
    // For template literals, skip simple ${ ... } blocks (best-effort)
    if (quote === '`' && ch === '$' && source[j + 1] === '{') {
      // Jump to matching '}'
      let depth = 1
      j += 2
      while (j < source.length && depth > 0) {
        if (source[j] === '{') depth++
        else if (source[j] === '}') depth--
        // Handle string-like chars inside expression naively by skipping escapes
        if (source[j] === '\\') j++
        j++
      }
      j--
    }
  }
  return null
}

export async function activate(context: vscode.ExtensionContext) {
  async function ensureProjectContext(editor?: vscode.TextEditor | null): Promise<boolean> {
    const ed = editor ?? vscode.window.activeTextEditor
    if (!ed) return false
    const workspaceFolders = vscode.workspace.workspaceFolders
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri) || (workspaceFolders && workspaceFolders[0])
    if (!folder) return false
    const projectRoot = folder.uri.fsPath
    const config = await loadCliProjectConfig(projectRoot)

    // Determine localesDir/baseLanguage with fallbacks for missing CLI config
    let localesDir: string | null = null
    let baseLanguage: string = 'en'

    if (config) {
      const outputDirConfigured: string = config.outputDir || path.join('i18n', 'locales')
      // Resolve relative to the CLI-configured projectPath when available (handles nested projects)
      let effectiveRoot = projectRoot
      try {
        const cfgPath = (config as any).projectPath as string | undefined
        if (cfgPath) effectiveRoot = path.isAbsolute(cfgPath) ? cfgPath : path.resolve(projectRoot, cfgPath)
      } catch {}
      localesDir = path.resolve(effectiveRoot, outputDirConfigured)
      baseLanguage = config.baseLanguage || 'en'
      // Use effective root for project context so other features compute paths correctly
      projectContext = { projectRoot: effectiveRoot, localesDir, baseLanguage }
      
      // Initialize preview language from settings or base language
      const extConfig = vscode.workspace.getConfiguration('stringerHelper')
      const preferred = extConfig.get<string>('defaultPreviewLanguage')
      // Derive available languages from actual filenames in localesDir
      let available: string[] = []
      try {
        available = fs
          .readdirSync(localesDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''))
      } catch {}
      // Choose active language strictly from available filenames
      if (preferred && available.includes(preferred)) activePreviewLanguage = preferred
      else if (available.includes(baseLanguage)) activePreviewLanguage = baseLanguage
      else activePreviewLanguage = available[0] || baseLanguage

      // Setup locale watcher
      if (localeWatcher) {
        localeWatcher.dispose()
        localeWatcher = null
      }
      try {
        const pattern = new vscode.RelativePattern(localesDir, '*.json')
        localeWatcher = vscode.workspace.createFileSystemWatcher(pattern)
        const reload = async () => {
          localeCache = {}
          await preloadLocales()
          refreshActiveEditorDecorations()
        }
        localeWatcher.onDidChange(reload)
        localeWatcher.onDidCreate(reload)
        localeWatcher.onDidDelete(reload)
        context.subscriptions.push(localeWatcher)
      } catch {}

      await preloadLocales()

      // Watch CLI config for changes so we can refresh projectContext if user runs the CLI again
      try {
        const configPath = findCliConfigPath()
        if (cliConfigWatcher) {
          try { cliConfigWatcher.close() } catch {}
          cliConfigWatcher = null
        }
        if (configPath && fs.existsSync(configPath)) {
          cliConfigWatcher = fs.watch(configPath, { persistent: false }, async () => {
            await ensureProjectContext(vscode.window.activeTextEditor)
            refreshActiveEditorDecorations()
          })
        }
      } catch {}
      return true
    } else {
      // 1) Try previously saved selection for this workspace
      const stateKey = `stringer.localesDir.${projectRoot}`
      try {
        const saved = context.workspaceState.get<string | undefined>(stateKey)
        if (typeof saved === 'string' && saved && fs.existsSync(saved)) localesDir = saved
      } catch {}

      // 2) Search the workspace for any */locales/*.json
      if (!localesDir) {
        try {
          const found = await vscode.workspace.findFiles(
            new vscode.RelativePattern(folder, '**/locales/*.json'),
            '**/node_modules/**',
            50
          )
          if (found && found.length > 0) {
            localesDir = path.dirname(found[0].fsPath)
            try { await context.workspaceState.update(stateKey, localesDir) } catch {}
          }
        } catch {}
      }

      // 3) Prompt user to pick the locales folder
      if (!localesDir) {
        const pick = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          title: vscode.l10n.t('No locales folder found. Please select it manually if it exists.'),
          defaultUri: folder.uri
        })
        if (!pick || pick.length === 0) {
          return false
        }
        localesDir = pick[0].fsPath
        try { await context.workspaceState.update(stateKey, localesDir) } catch {}
      }

      // Try to infer base language from files
      try {
        const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))
        if (files.includes('en.json')) baseLanguage = 'en'
        else if (files.length > 0) baseLanguage = files[0].replace(/\.json$/, '')
      } catch {}
    }

    projectContext = { projectRoot, localesDir: localesDir!, baseLanguage }

    // Initialize preview language from settings or base language
    const extConfig = vscode.workspace.getConfiguration('stringerHelper')
    const preferred = extConfig.get<string>('defaultPreviewLanguage')
    // Derive available languages from actual filenames in localesDir
    let available: string[] = []
    try {
      available = fs
        .readdirSync(localesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch {}
    // Choose active language strictly from available filenames
    if (preferred && available.includes(preferred)) activePreviewLanguage = preferred
    else if (available.includes(baseLanguage)) activePreviewLanguage = baseLanguage
    else activePreviewLanguage = available[0] || baseLanguage

    // Setup locale watcher
    if (localeWatcher) {
      localeWatcher.dispose()
      localeWatcher = null
    }
    try {
      const pattern = new vscode.RelativePattern(localesDir, '*.json')
      localeWatcher = vscode.workspace.createFileSystemWatcher(pattern)
      const reload = async () => {
        localeCache = {}
        await preloadLocales()
        refreshActiveEditorDecorations()
      }
      localeWatcher.onDidChange(reload)
      localeWatcher.onDidCreate(reload)
      localeWatcher.onDidDelete(reload)
      context.subscriptions.push(localeWatcher)
    } catch {}

    await preloadLocales()

    // Watch CLI config for changes so we can refresh projectContext if user runs the CLI again
    try {
      const configPath = findCliConfigPath()
      if (cliConfigWatcher) {
        try { cliConfigWatcher.close() } catch {}
        cliConfigWatcher = null
      }
      if (configPath && fs.existsSync(configPath)) {
        cliConfigWatcher = fs.watch(configPath, { persistent: false }, async () => {
          await ensureProjectContext(vscode.window.activeTextEditor)
          refreshActiveEditorDecorations()
        })
      }
    } catch {}
    return true
  }

  function getValueByPath(obj: any, keyPath: string): any {
    if (!obj) return undefined
    const parts = keyPath.split('.').filter(Boolean)
    let node = obj
    for (const part of parts) {
      if (node && typeof node === 'object' && part in node) node = node[part]
      else return undefined
    }
    return typeof node === 'string' ? node : undefined
  }
  // Support numeric-leaf patterns where the key may be the leaf id (e.g., 4-digit code)
  function getValueByPathLoose(obj: any, keyPath: string): any {
    if (!obj) return undefined
    const parts = keyPath.split('.').filter(Boolean)
    let node = obj
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (node && typeof node === 'object' && part in node) {
        node = node[part]
        continue
      }
      // If this is the last part and the parent is an object with a single 4-digit key, return that
      const isLast = i === parts.length - 1
      if (isLast && node && typeof node === 'object') {
        const leafKeys = Object.keys(node)
        const four = leafKeys.find((k) => /^\d{4}$/.test(k) && typeof node[k] === 'string')
        if (four) return node[four]
      }
      return undefined
    }
    return typeof node === 'string' ? node : undefined
  }

  async function loadLocale(lang: string): Promise<Record<string, any> | null> {
    if (!projectContext) return null
    if (localeCache[lang]) return localeCache[lang]
    const tryPaths = (() => {
      const variants = new Set<string>()
      const L = (lang || '').trim()
      const low = L.toLowerCase()
      const dash = low.replace(/_/g, '-')
      variants.add(L)
      variants.add(low)
      variants.add(dash)
      if (dash.includes('-')) variants.add(dash.split('-')[0])
      return Array.from(variants).map((v) => path.join(projectContext!.localesDir, `${v}.json`))
    })()
    try {
      for (const fp of tryPaths) {
        try {
          const txt = await fs.promises.readFile(fp, 'utf-8')
          const json = JSON.parse(txt)
          localeCache[lang] = json
          return json
        } catch {}
      }
      return null
    } catch {
      return null
    }
  }

  async function preloadLocales(): Promise<void> {
    if (!projectContext) return
    await loadLocale(projectContext.baseLanguage)
    if (activePreviewLanguage && activePreviewLanguage !== projectContext.baseLanguage) {
      await loadLocale(activePreviewLanguage)
    }
  }

  function getTranslation(keyPath: string): string | null {
    if (!projectContext) return null
    const lang = activePreviewLanguage || projectContext.baseLanguage
    // Try direct match
    const primary = getValueByPath(localeCache[lang], keyPath)
    if (primary) return primary
    // Try loose match (handles numeric leaf keys)
    const loose = getValueByPathLoose(localeCache[lang], keyPath)
    if (loose) return loose
    // Fallback to base language
    const fallbackBase = getValueByPath(localeCache[projectContext.baseLanguage], keyPath)
    if (fallbackBase) return fallbackBase
    const fallbackLoose = getValueByPathLoose(localeCache[projectContext.baseLanguage], keyPath)
    if (fallbackLoose) return fallbackLoose
    // Last-resort: try any loaded locale (helps if baseLanguage file is missing)
    for (const k of Object.keys(localeCache)) {
      const v = getValueByPath(localeCache[k], keyPath) || getValueByPathLoose(localeCache[k], keyPath)
      if (typeof v === 'string') return v
    }
    return null
  }

  function findTTupleRanges(doc: vscode.TextDocument): Array<{ range: vscode.Range; key: string }> {
    const text = doc.getText()
    const results: Array<{ range: vscode.Range; key: string }> = []
    // Best-effort regex for t('...') calls; supports nested dot keys and dashes/underscores
    const rx = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]\s*\)/g
    for (let m: RegExpExecArray | null = rx.exec(text); m; m = rx.exec(text)) {
      const key = m[1]
      const start = m.index
      const end = m.index + m[0].length
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end))
      results.push({ range, key })
    }
    return results
  }

  function decorateEditor(editor: vscode.TextEditor) {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const enable = cfg.get<boolean>('enableInlinePreview', true)
    const keyMode = (cfg.get<string>('inlinePreviewKeyMode') || 'hidden') as 'hidden' | 'full' | 'leaf'
    const hoverShowsKey = cfg.get<boolean>('hoverShowsKey', true)
    if (!enable) {
      editor.setDecorations(decorationType, [])
      return
    }
    const found = findTTupleRanges(editor.document)
    const decorations: vscode.DecorationOptions[] = []
    const hiddenRanges: vscode.DecorationOptions[] = []
    const hiddenModeValueDecorations: vscode.DecorationOptions[] = []
    const docText = editor.document.getText()
    const filePath = editor.document.uri.fsPath
    const isVue = isVueFile(filePath)
    const isJsx = isJsxFile(filePath)
    for (const item of found) {
      const value = getTranslation(item.key)
      const textToShow = value ?? ''
      const startOffset = editor.document.offsetAt(item.range.start)
      const inVueTemplate = isVue && isVueTemplateTextNode(docText, startOffset)
      const inJsxUi = isJsx && isLikelyJsxUiContext(docText, startOffset)
      // Missing is determined against the ACTIVE locale file only (no fallback),
      // so removing a key from the active file turns it red immediately.
      const lang = (activePreviewLanguage || projectContext?.baseLanguage) as string
      const activeDirect = projectContext ? getValueByPath(localeCache[lang], item.key) : undefined
      const isMissing = !activeDirect && (inVueTemplate || inJsxUi)
      if (!textToShow && cfg.get<string>('inlinePreviewKeyMode') !== 'hidden') continue
      const hover = new vscode.MarkdownString()
      if (hoverShowsKey) hover.appendMarkdown(`Key: \`${item.key}\``)
      hover.appendMarkdown('\n\n')
      hover.appendMarkdown(`Value (${activePreviewLanguage}): ${value}`)
      const leaf = item.key.split('.').pop() || item.key
      // Key+locale mode should not duplicate the key (code already shows it)
      // Leaf mode shows a compact key prefix; Hidden mode shows only value and hides the code
      const keyLabel = keyMode === 'leaf' ? `[${leaf}] ` : ''
      if (keyMode === 'hidden') {
        // 1) Hide the original text entirely (collapsed width)
        hiddenRanges.push({ range: item.range })
        // 2) Render the value via a separate decoration so opacity does not affect it
        hiddenModeValueDecorations.push({
          range: item.range,
          // Avoid duplicate hover (decoration + provider); provider will handle it
          renderOptions: {
            after: {
              contentText: ` ${isMissing ? 'Locale Key Missing!!' : textToShow} `,
              backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : 'hsl(270, 55%, 43%)') as any,
              color: '#ffffff' as any,
              margin: '0 0 0 0',
              border: '1px solid',
              borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : 'hsl(270, 55%, 43%)') as any,
              textDecoration: 'border-radius: 8px; padding: 0 6px;'
            }
          }
        })
      } else {
        decorations.push({
          range: item.range,
          hoverMessage: hover,
          renderOptions: {
            after: {
              contentText: ` ${keyLabel}${isMissing ? 'Locale Key Missing!!' : textToShow}`,
              backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : 'hsl(270, 55%, 43%)') as any,
              color: '#ffffff' as any,
              margin: '0 0 0 0',
              border: '1px solid',
              borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : 'hsl(270, 55%, 43%)') as any,
              textDecoration: 'border-radius: 8px; padding: 0 6px;'
            }
          }
        })
      }
    }
    // Apply decorations per mode
    if (keyMode === 'hidden') {
      editor.setDecorations(valueBeforeDecorationType, hiddenModeValueDecorations)
      editor.setDecorations(hiddenTextDecorationType, hiddenRanges)
      editor.setDecorations(decorationType, [])
    } else {
      editor.setDecorations(decorationType, decorations)
      editor.setDecorations(hiddenTextDecorationType, [])
      editor.setDecorations(valueBeforeDecorationType, [])
    }
  }

  function refreshActiveEditorDecorations() {
    const ed = vscode.window.activeTextEditor
    if (!ed) return
    decorateEditor(ed)
  }

  // Provide hover in any file type
  const hoverProvider = vscode.languages.registerHoverProvider({ scheme: 'file' }, {
    provideHover(document, position) {
      const ranges = findTTupleRanges(document)
      for (const r of ranges) {
        if (r.range.contains(position)) {
          const value = getTranslation(r.key)
          const md = new vscode.MarkdownString()
          md.appendMarkdown(`Key: \`${r.key}\``)
          if (value) md.appendMarkdown(`\n\nValue (${activePreviewLanguage}): ${value}`)
          return new vscode.Hover(md, r.range)
        }
      }
      return undefined
    }
  })
  context.subscriptions.push(hoverProvider)

  async function getAvailableLocales(): Promise<string[]> {
    if (!projectContext) return []
    try {
      return fs
        .readdirSync(projectContext.localesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  async function choosePreviewLanguage(): Promise<void> {
    if (!projectContext) {
      const ok = await ensureProjectContext(null)
      if (!ok) {
        vscode.window.showErrorMessage(vscode.l10n.t('Stringer CLI config not found. Run the Stringer CLI once in this project.'))
        return
      }
    }
    if (!projectContext) return
    const items = await getAvailableLocales()
    if (items.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('No locale files found in {0}', projectContext.localesDir))
      return
    }
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select preview language',
      title: 'Stringer: Change Preview Language'
    })
    if (!pick) return
    activePreviewLanguage = pick
    const extConfig = vscode.workspace.getConfiguration('stringerHelper')
    if (!extConfig.get('defaultPreviewLanguage')) {
      await extConfig.update('defaultPreviewLanguage', pick, vscode.ConfigurationTarget.Global)
    }
    await preloadLocales()
    langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`
    refreshActiveEditorDecorations()
  }

  const langStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  langStatusItem.text = '$(globe) Lang'
  langStatusItem.tooltip = 'Change Stringer preview language'
  langStatusItem.command = 'stringer.changePreviewLanguage'
  langStatusItem.show()
  context.subscriptions.push(langStatusItem)

  function getPreviewModeLabel(): string {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const enable = cfg.get<boolean>('enableInlinePreview', true)
    if (!enable) return 'Off'
    const keyMode = (cfg.get<string>('inlinePreviewKeyMode') || 'hidden') as 'hidden' | 'full' | 'leaf'
    return keyMode === 'full' ? 'Key+Text' : keyMode === 'leaf' ? 'Leaf+Text' : 'Text'
  }

  const previewStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98)
  previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
  previewStatusItem.tooltip = 'Change Stringer inline preview mode'
  previewStatusItem.command = 'stringer.changePreviewMode'
  previewStatusItem.show()
  context.subscriptions.push(previewStatusItem)

  const changeLangCmd = vscode.commands.registerCommand('stringer.changePreviewLanguage', async () => {
    await choosePreviewLanguage()
  })
  context.subscriptions.push(changeLangCmd)

  const togglePreviewCmd = vscode.commands.registerCommand('stringer.toggleInlinePreview', async () => {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const cur = cfg.get<boolean>('enableInlinePreview', true)
    await cfg.update('enableInlinePreview', !cur, vscode.ConfigurationTarget.Global)
    refreshActiveEditorDecorations()
    previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
  })
  context.subscriptions.push(togglePreviewCmd)

  const changePreviewModeCmd = vscode.commands.registerCommand('stringer.changePreviewMode', async () => {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const enable = cfg.get<boolean>('enableInlinePreview', true)
    const currentMode = (cfg.get<string>('inlinePreviewKeyMode') || 'hidden') as 'hidden' | 'full' | 'leaf'
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'No preview', description: 'Hide all inline translations', value: 'off' },
        { label: 'Key + locale preview', description: 'Show full key and translation', value: 'full' },
        { label: 'Locale only preview', description: 'Show translation only', value: 'hidden' }
      ],
      { title: 'Stringer: Change Preview Mode', placeHolder: 'Select inline preview mode' }
    )
    if (!pick) return
    if (pick.value === 'off') {
      await cfg.update('enableInlinePreview', false, vscode.ConfigurationTarget.Global)
    } else {
      if (!enable) await cfg.update('enableInlinePreview', true, vscode.ConfigurationTarget.Global)
      await cfg.update('inlinePreviewKeyMode', pick.value, vscode.ConfigurationTarget.Global)
    }
    previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
    refreshActiveEditorDecorations()
  })
  context.subscriptions.push(changePreviewModeCmd)

  const reloadLocalesCmd = vscode.commands.registerCommand('stringer.reloadLocales', async () => {
    localeCache = {}
    await ensureProjectContext(vscode.window.activeTextEditor)
    await preloadLocales()
    refreshActiveEditorDecorations()
  })
  context.subscriptions.push(reloadLocalesCmd)

  const openControlPanelCmd = vscode.commands.registerCommand('stringer.openControlPanel', async () => {
    const panel = vscode.window.createWebviewPanel(
      'stringerControlPanel',
      'Stringer',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    )

    const render = async () => {
      const cfg = vscode.workspace.getConfiguration('stringerHelper')
      const enable = cfg.get<boolean>('enableInlinePreview', true)
      const keyMode = (cfg.get<string>('inlinePreviewKeyMode') || 'hidden')
      const langs = await getAvailableLocales()
      const currentLang = activePreviewLanguage || (projectContext?.baseLanguage ?? '')
      const previewLabel = getPreviewModeLabel()
      const langOptions = langs
        .map((l) => `<option value="${l}" ${l === currentLang ? 'selected' : ''}>${l}</option>`) 
        .join('')
      const modeOptions = [
        { v: 'off', l: 'No preview' },
        { v: 'full', l: 'Key + locale preview' },
        { v: 'hidden', l: 'Locale only preview' }
      ].map(({ v, l }) => `<option value="${v}" ${((!enable && v==='off') || (enable && v===keyMode)) ? 'selected' : ''}>${l}</option>`).join('')

      const website = 'https://stringer-cli.com'
      const docs = 'https://docs.stringer-cli.com'
      const billing = 'https://stringer-cli.com/billing'

      panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src ${panel.webview.cspSource};" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 16px; }
    h2 { margin: 0 0 12px; }
    .row { display: flex; gap: 12px; align-items: center; margin: 8px 0; }
    select, button { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; }
    .group { border: 1px solid var(--vscode-panel-border); padding: 12px; border-radius: 6px; margin-bottom: 12px; }
    .links a { margin-right: 12px; }
    .muted { opacity: 0.8; }
  </style>
  <title>Stringer</title>
  </head>
<body>
  <h2>Stringer Control Panel</h2>
  <div class="group">
    <div class="row">
      <label>Preview mode:</label>
      <select id="mode">${modeOptions}</select>
      <span class="muted">Current: ${previewLabel}</span>
    </div>
    <div class="row">
      <label>Preview language:</label>
      <select id="lang">${langOptions}</select>
      <button id="reload">Reload locales</button>
    </div>
  </div>
  <div class="group">
    <div class="row">
      <button id="align">Align Translations</button>
    </div>
  </div>
  <div class="group links">
    <a href="#" data-link="${website}">Website</a>
    <a href="#" data-link="${docs}">Docs</a>
    <a href="#" data-link="${billing}">Billing</a>
  </div>
  <script>
    const vscode = acquireVsCodeApi()
    const mode = document.getElementById('mode')
    const lang = document.getElementById('lang')
    const reload = document.getElementById('reload')
    const align = document.getElementById('align')
    mode.addEventListener('change', () => {
      vscode.postMessage({ type: 'setMode', value: mode.value })
    })
    lang.addEventListener('change', () => {
      vscode.postMessage({ type: 'setLanguage', value: lang.value })
    })
    reload.addEventListener('click', () => {
      vscode.postMessage({ type: 'reloadLocales' })
    })
    align.addEventListener('click', () => {
      vscode.postMessage({ type: 'align' })
    })
    document.querySelectorAll('[data-link]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'open', value: a.getAttribute('data-link') }) })
    })
  </script>
</body>
</html>`
    }

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'setMode') {
        const cfg = vscode.workspace.getConfiguration('stringerHelper')
        if (msg.value === 'off') {
          await cfg.update('enableInlinePreview', false, vscode.ConfigurationTarget.Global)
        } else {
          await cfg.update('enableInlinePreview', true, vscode.ConfigurationTarget.Global)
          await cfg.update('inlinePreviewKeyMode', msg.value, vscode.ConfigurationTarget.Global)
        }
        previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
        refreshActiveEditorDecorations()
      }
      if (msg.type === 'setLanguage') {
        activePreviewLanguage = String(msg.value)
        const extConfig = vscode.workspace.getConfiguration('stringerHelper')
        if (!extConfig.get('defaultPreviewLanguage')) {
          await extConfig.update('defaultPreviewLanguage', activePreviewLanguage, vscode.ConfigurationTarget.Global)
        }
        await preloadLocales()
        langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`
        refreshActiveEditorDecorations()
      }
      if (msg.type === 'reloadLocales') {
        localeCache = {}
        await preloadLocales()
        refreshActiveEditorDecorations()
        await render()
      }
      if (msg.type === 'align') {
        const workspaceFolders = vscode.workspace.workspaceFolders
        const folder = vscode.window.activeTextEditor
          ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
          : (workspaceFolders && workspaceFolders[0])
        if (folder) await runAlignInTerminal(folder.uri.fsPath)
      }
      if (msg.type === 'open') {
        const url = String(msg.value)
        vscode.env.openExternal(vscode.Uri.parse(url))
      }
    })

    await render()
  })
  context.subscriptions.push(openControlPanelCmd)

  vscode.workspace.onDidChangeTextDocument((e) => {
    if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
      refreshActiveEditorDecorations()
    }
  })
  vscode.window.onDidChangeActiveTextEditor(async (ed) => {
    if (!ed) return
    const ok = await ensureProjectContext(ed)
    if (ok) {
      langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`
      previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
      refreshActiveEditorDecorations()
    }
  })

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('stringerHelper')) {
      refreshActiveEditorDecorations()
    }
  })

  // Initialize for current editor if any
  await ensureProjectContext(vscode.window.activeTextEditor)
  langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage ?? '—'}`
  previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
  refreshActiveEditorDecorations()
  const disposable = vscode.commands.registerCommand('stringer.addI18nKey', async () => {
    if (isProcessingCommand) return
    isProcessingCommand = true
    try {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const selection = editor.selection
      if (selection.isEmpty) {
        vscode.window.showInformationMessage(vscode.l10n.t('Select a string to add i18n key via Stringer.'))
        return
      }

      const selectedText = editor.document.getText(selection)
      const selectedString = selectedText.replace(/^['"`]/, '').replace(/['"`]$/, '')

      const workspaceFolders = vscode.workspace.workspaceFolders
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) || (workspaceFolders && workspaceFolders[0])
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'))
        return
      }
      const projectRoot = folder.uri.fsPath

      const config = await loadCliProjectConfig(projectRoot)
      if (!config) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Stringer CLI config not found. Run the Stringer CLI once in this project.')
        )
        return
      }

      const outputDirConfigured: string = config.outputDir || path.join('i18n', 'locales')
      const localesDir = path.resolve(projectRoot, outputDirConfigured)
      ensureDir(localesDir)

      const baseLanguage: string = config.baseLanguage || 'en'
      const baseLangPath = path.join(localesDir, `${baseLanguage}.json`)

      if (!fs.existsSync(baseLangPath)) {
        ensureDir(path.dirname(baseLangPath))
        fs.writeFileSync(baseLangPath, JSON.stringify({}, null, 2))
      }

      let baseJson: Record<string, any> = {}
      try {
        baseJson = JSON.parse(fs.readFileSync(baseLangPath, 'utf-8'))
      } catch (_e) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Base language file has invalid JSON. Please fix it and try again. No changes were made.'
          )
        )
        return
      }

      const filePath = editor.document.uri.fsPath
      const keyPathPrefix = generateKeyPath(filePath, projectRoot)
      if (!keyPathPrefix) {
        vscode.window.showErrorMessage(vscode.l10n.t('Cannot derive key path from file location.'))
        return
      }

      const { updated, fullKeyPath } = addStringToBaseLanguage(baseJson, keyPathPrefix, selectedString)

      fs.writeFileSync(baseLangPath, JSON.stringify(updated, null, 2))

      const docText = editor.document.getText()
      const startOffset = editor.document.offsetAt(selection.start)

      const inVue = isVueFile(filePath)
      const inJsx = isJsxFile(filePath)
      const isTplText = inVue && isVueTemplateTextNode(docText, startOffset)
      const attrCtx = inVue ? getAttributeContext(docText, startOffset) : null
      const jsxAttrCtx = !inVue && inJsx ? getJsxAttributeContext(docText, startOffset) : null

      const expr = `t('${fullKeyPath}')`

      await withEdit(editor, (edit) => {
        if (attrCtx) {
          const { name, isBound, attrStart, valueStart, valueEnd } = attrCtx
          if (isBound) {
            const range = new vscode.Range(
              editor.document.positionAt(valueStart),
              editor.document.positionAt(valueEnd)
            )
            edit.replace(range, expr)
          } else {
            const fullAttrEnd = valueEnd + 1
            const range = new vscode.Range(
              editor.document.positionAt(attrStart),
              editor.document.positionAt(fullAttrEnd)
            )
            edit.replace(range, `:${name}="${expr}"`)
          }
        } else if (jsxAttrCtx) {
          const { valueStartQuote, valueEndQuote } = jsxAttrCtx
          // Replace including surrounding quotes with JSX expression {t('...')}
          const range = new vscode.Range(
            editor.document.positionAt(valueStartQuote),
            editor.document.positionAt(valueEndQuote + 1)
          )
          edit.replace(range, `{${expr}}`)
        } else if (isTplText) {
          edit.replace(selection, `{{ ${expr} }}`)
        } else if (inJsx && isLikelyJsxUiContext(docText, startOffset)) {
          // Wrap UI text with JSX expression
          edit.replace(selection, `{${expr}}`)
        } else {
          const bounds = findEnclosingStringLiteralBounds(docText, startOffset)
          if (bounds) {
            const range = new vscode.Range(
              editor.document.positionAt(bounds.qStart),
              editor.document.positionAt(bounds.qEnd + 1)
            )
            edit.replace(range, expr)
          } else {
            edit.replace(selection, expr)
          }
        }
      })

      if (inVue) {
        await ensureVueTDeclaration(editor)
      } else if (inJsx) {
        // Auto framework selection
        const extCfg = vscode.workspace.getConfiguration('stringerHelper')
        const framework = (extCfg.get<string>('framework', 'auto') || 'auto') as 'auto' | 'vue' | 'react' | 'next'
        const effective: 'react' | 'next' = (() => {
          if (framework !== 'auto') return framework as any
          try {
            const pkgPath = path.join(projectRoot, 'package.json')
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
            if (deps.next) return 'next'
            return 'react'
          } catch { return 'react' }
        })()
        const selOffset = startOffset
        if (effective === 'next') await ensureNextTDeclaration(editor, selOffset)
        else await ensureReactTDeclaration(editor, selOffset)
      }

      const shouldShowAlign = (() => {
        try {
          const files = fs
            .readdirSync(localesDir)
            .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
          const others = files.filter((f) => f !== `${baseLanguage}.json`)
          return others.length > 0
        } catch {
          return false
        }
      })()

      if (shouldShowAlign) {
        const autoAlign = vscode.workspace.getConfiguration('stringerHelper').get<boolean>('autoAlignAfterAdd', false)
        if (autoAlign) {
          await runAlignInTerminal(projectRoot)
        } else {
          const yes = vscode.l10n.t('Yes')
          const no = vscode.l10n.t('No')
          vscode.window
            .showInformationMessage(
              vscode.l10n.t(
                'Your translations are out of alignment. Run "{0}" to add missing translations?',
                'stringer align'
              ),
              yes,
              no
            )
            .then(async (choice) => {
              if (choice === yes) {
                await runAlignInTerminal(projectRoot)
              }
            })
        }
      }
    } finally {
      isProcessingCommand = false
    }
  })

  // Status Bar Button
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.text = '$(globe) Stringer'
  statusBarItem.tooltip = 'Open Stringer menu'
  statusBarItem.command = 'stringer.showMenu'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // Menu command
  const showMenu = vscode.commands.registerCommand('stringer.showMenu', async () => {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Align Translations',
          description:
            'Add any missing translations for target languages based on your base language JSON file'
        },
        { label: 'Change Preview Language', description: 'Switch inline preview locale' },
        { label: 'Change Preview Mode', description: 'Switch inline preview content' },
        { label: 'Open Website', description: 'stringer-cli.com' },
        { label: 'Open Docs', description: 'docs.stringer-cli.com' },
        { label: 'Open Billing', description: 'stringer-cli.com/billing' }
      ],
      {
        title: 'Stringer',
        placeHolder: 'Select an action'
      }
    )

    if (!pick) return

    if (pick.label === 'Align Translations') {
      const workspaceFolders = vscode.workspace.workspaceFolders
      const folder = vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
        : (workspaceFolders && workspaceFolders[0])
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'))
        return
      }
      await runAlignInTerminal(folder.uri.fsPath)
      return
    }

    if (pick.label === 'Change Preview Language') {
      await choosePreviewLanguage()
      return
    }
    if (pick.label === 'Change Preview Mode') {
      await vscode.commands.executeCommand('stringer.changePreviewMode')
      return
    }

    if (pick.label === 'Open Website') {
      vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com'))
      return
    }
    if (pick.label === 'Open Docs') {
      vscode.env.openExternal(vscode.Uri.parse('https://docs.stringer-cli.com'))
      return
    }
    if (pick.label === 'Open Billing') {
      vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com/billing'))
      return
    }
  })
  context.subscriptions.push(disposable, showMenu)
}

export function deactivate() {}
