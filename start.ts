import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import os from 'os'

// Debug output channel for troubleshooting
let debugChannel: vscode.OutputChannel | null = null
function getDebugChannel(): vscode.OutputChannel {
  if (!debugChannel) {
    debugChannel = vscode.window.createOutputChannel('Stringer Helper Debug')
  }
  return debugChannel
}

function debugLog(message: string): void {
  const cfg = vscode.workspace.getConfiguration('stringerHelper')
  if (cfg.get<boolean>('enableDebugLogging', false)) {
    getDebugChannel().appendLine(`[${new Date().toISOString()}] ${message}`)
  }
}

/**
 * Normalize a file path for consistent comparison across platforms.
 * 
 * Platform-specific behavior:
 * - Windows (NTFS): Case-insensitive filesystem → normalize to lowercase
 * - macOS (APFS): Case-insensitive by default, but can be case-sensitive → preserve case
 *   (Preserving case works for both case-sensitive and case-insensitive macOS setups)
 * - Linux (ext4): Case-sensitive filesystem → preserve case
 * - Other Unix-like systems: Preserve case (may be case-sensitive)
 * 
 * Features:
 * - Normalizes path separators (forward/backward slashes)
 * - Resolves relative path components (., ..)
 * - Handles UNC paths on Windows (\\server\share)
 * - Handles drive letters consistently (C: vs c:)
 * - Handles long paths on Windows (\\?\ prefix)
 * 
 * Note: This function is designed for path comparison/caching, not for file system operations.
 * Use the original path for actual file system access.
 */
function normalizePathForComparison(filePath: string): string {
  if (!filePath) return filePath
  
  // Normalize path separators and resolve relative components
  let normalized = path.normalize(filePath)
  
  // Handle platform-specific normalization
  if (process.platform === 'win32') {
    // Windows: case-insensitive filesystem (NTFS)
    // Convert to lowercase for consistent comparison
    
    // Handle Windows long path prefix (\\?\)
    const hasLongPathPrefix = normalized.startsWith('\\\\?\\')
    if (hasLongPathPrefix) {
      normalized = normalized.slice(4)
    }
    
    // Handle UNC paths (\\server\share)
    if (normalized.startsWith('\\\\')) {
      // UNC path: normalize after the server/share part
      const parts = normalized.split('\\')
      if (parts.length >= 3) {
        const serverShare = parts.slice(0, 3).join('\\').toLowerCase()
        const rest = parts.slice(3).join('\\').toLowerCase()
        normalized = serverShare + (rest ? '\\' + rest : '')
      } else {
        normalized = normalized.toLowerCase()
      }
    } else {
      normalized = normalized.toLowerCase()
    }
    
    // Normalize drive letters (C: vs c:)
    if (normalized.length >= 2 && normalized[1] === ':') {
      normalized = normalized[0].toLowerCase() + ':' + normalized.slice(2)
    }
    
    // Restore long path prefix if it was present
    if (hasLongPathPrefix) {
      normalized = '\\\\?\\' + normalized
    }
  } else {
    // Unix-like systems (macOS, Linux, BSD, etc.)
    // Preserve case to support both case-sensitive and case-insensitive filesystems
    // path.normalize() already handles separators correctly
    // Don't use path.resolve() here as it would change relative paths
    
    // Ensure consistent separator normalization (though path.normalize should handle this)
    // This is mainly for documentation/clarity
  }
  
  return normalized
}

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
let syncWatcher: vscode.FileSystemWatcher | null = null
let pendingSyncAlert = false

// ============================================================================
// PER-PROJECT LOCALE CACHE FOR MONOREPO SUPPORT
// Each locales folder has its own cache of loaded translations
// ============================================================================

interface PerProjectContext {
  localesDir: string
  baseLanguage: string
  localeData: Record<string, any> // lang -> translations
  availableLanguages: string[]
}

// Map of locales folder path -> project context
const projectContextCache: Map<string, PerProjectContext> = new Map()

/**
 * Get or create a project context for a specific locales folder
 */
function getOrCreateProjectContext(localesDir: string): PerProjectContext | null {
  // Normalize path for consistent cache lookup across platforms
  const normalizedLocalesDir = normalizePathForComparison(localesDir)
  
  if (projectContextCache.has(normalizedLocalesDir)) {
    return projectContextCache.get(normalizedLocalesDir)!
  }
  
  // Check if folder exists and has locale files (use original path for file system access)
  if (!containsLocaleFiles(localesDir)) {
    return null
  }
  
  // Detect base language and available languages
  let baseLanguage = 'en'
  let availableLanguages: string[] = []
  
  try {
    const files = fs.readdirSync(localesDir).filter(f => isLocaleFileName(f))
    availableLanguages = files.map(f => f.replace(/\.json$/, ''))
    
    if (availableLanguages.includes('en')) {
      baseLanguage = 'en'
    } else if (availableLanguages.length > 0) {
      baseLanguage = availableLanguages[0]
    }
  } catch {
    return null
  }
  
  const ctx: PerProjectContext = {
    localesDir, // Store original path for file system operations
    baseLanguage,
    localeData: {},
    availableLanguages
  }
  
  // Cache using normalized path for consistent lookups
  projectContextCache.set(normalizedLocalesDir, ctx)
  return ctx
}

/**
 * Load a locale file for a specific project context
 */
function loadLocaleForProject(ctx: PerProjectContext, lang: string): Record<string, any> | null {
  if (ctx.localeData[lang]) {
    return ctx.localeData[lang]
  }
  
  const tryVariants = (l: string): string[] => {
    const variants = new Set<string>()
    const low = l.toLowerCase()
    const dash = low.replace(/_/g, '-')
    variants.add(l)
    variants.add(low)
    variants.add(dash)
    if (dash.includes('-')) variants.add(dash.split('-')[0])
    return Array.from(variants)
  }
  
  const variants = tryVariants(lang)
  debugLog(`loadLocaleForProject: loading ${lang} from ${ctx.localesDir}, trying variants: ${variants.join(', ')}`)
  
  for (const variant of variants) {
    const filePath = path.join(ctx.localesDir, `${variant}.json`)
    debugLog(`loadLocaleForProject: trying ${filePath}`)
    try {
      if (fs.existsSync(filePath)) {
        debugLog(`loadLocaleForProject: file exists, reading...`)
        const content = fs.readFileSync(filePath, 'utf-8')
        // Strip BOM for Windows compatibility
        const data = JSON.parse(stripBOM(content))
        ctx.localeData[lang] = data
        debugLog(`loadLocaleForProject: successfully loaded ${filePath}, keys: ${Object.keys(data).slice(0, 5).join(', ')}...`)
        return data
      } else {
        debugLog(`loadLocaleForProject: file does not exist: ${filePath}`)
      }
    } catch (e) {
      debugLog(`loadLocaleForProject: error loading ${filePath}: ${e}`)
      // Continue to next variant
    }
  }
  
  debugLog(`loadLocaleForProject: no locale file found for ${lang}`)
  return null
}

/**
 * Get translation for a key from a specific project context
 */
function getTranslationForProject(ctx: PerProjectContext, keyPath: string, preferredLang?: string): string | null {
  const lang = preferredLang || activePreviewLanguage || ctx.baseLanguage
  
  // Load locale if not already loaded
  loadLocaleForProject(ctx, lang)
  if (lang !== ctx.baseLanguage) {
    loadLocaleForProject(ctx, ctx.baseLanguage)
  }
  
  // Try direct match in preferred language
  const langData = ctx.localeData[lang]
  if (langData) {
    const value = getValueByPathLoose(langData, keyPath)
    if (value) return value
  }
  
  // Fallback to base language
  const baseData = ctx.localeData[ctx.baseLanguage]
  if (baseData) {
    return getValueByPathLoose(baseData, keyPath)
  }
  
  return null
}

/**
 * Get value by path with loose matching (handles numeric leaf keys)
 */
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
    // BUT: only do this fallback if the requested key is NOT itself a 4-digit number
    // (if user explicitly requests a specific 4-digit key that doesn't exist, return undefined)
    const isLast = i === parts.length - 1
    const isRequestingSpecific4Digit = /^\d{4}$/.test(part)
    if (isLast && node && typeof node === 'object' && !isRequestingSpecific4Digit) {
      const leafKeys = Object.keys(node)
      const four = leafKeys.find((k) => /^\d{4}$/.test(k) && typeof node[k] === 'string')
      if (four) return node[four]
    }
    return undefined
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * Clear all project context caches
 */
function clearAllProjectContextCaches(): void {
  projectContextCache.clear()
  localesFolderCache.clear()
}

/**
 * Get the project context for a specific file, using nearest locales folder
 */
function getProjectContextForFile(filePath: string, workspaceRoot?: string): PerProjectContext | null {
  // First, try to find from workspace root directly (most reliable for multi-root workspaces)
  if (workspaceRoot) {
    const wsLocales = findLocalesFolderForWorkspace(workspaceRoot)
    if (wsLocales) {
      return getOrCreateProjectContext(wsLocales)
    }
  }
  
  // Fallback: search from file location up the tree
  const localesDir = findNearestLocalesFolder(filePath, workspaceRoot)
  if (!localesDir) return null
  return getOrCreateProjectContext(localesDir)
}

// ============================================================================
// SYNC TRACKING UTILITIES
// Mirrors the CLI's sync tracking for detecting base language changes
// ============================================================================

const SYNC_FILE_NAME = '.stringer-sync.json'

interface SyncData {
  schemaVersion: number
  baseLanguage: string
  lastSync: string
  keys: Record<string, string>
}

interface SyncStatus {
  inSync: boolean
  modifiedKeys: string[]
  newKeys: string[]
  removedKeys: string[]
}

/**
 * Generate a fast hash using djb2 algorithm (same as CLI)
 */
function generateKeyHash(value: string): string {
  if (typeof value !== 'string') {
    value = JSON.stringify(value)
  }
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i)
  }
  const unsignedHash = hash >>> 0
  return unsignedHash.toString(16).padStart(8, '0')
}

/**
 * Flatten nested object into dot-notated paths with values
 */
function flattenLocale(
  obj: Record<string, any>,
  parentKey = ''
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(obj)) {
    const currentKey = parentKey ? `${parentKey}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...flattenLocale(value, currentKey))
    } else {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
      result.push({ key: currentKey, value: stringValue })
    }
  }
  return result
}

/**
 * Flatten and hash all keys in a locale object
 */
function flattenAndHashLocale(localeObj: Record<string, any>): Record<string, string> {
  const flattened = flattenLocale(localeObj)
  const hashes: Record<string, string> = {}
  for (const { key, value } of flattened) {
    hashes[key] = generateKeyHash(value)
  }
  return hashes
}

/**
 * Load sync file from locales directory
 */
function loadSyncFile(localesDir: string): SyncData | null {
  const syncFilePath = path.join(localesDir, SYNC_FILE_NAME)
  try {
    if (!fs.existsSync(syncFilePath)) {
      return null
    }
    const content = fs.readFileSync(syncFilePath, 'utf-8')
    // Strip BOM for Windows compatibility
    return JSON.parse(stripBOM(content)) as SyncData
  } catch {
    return null
  }
}

/**
 * Detect changes between current and stored hashes
 */
function detectSyncChanges(
  currentHashes: Record<string, string>,
  storedHashes: Record<string, string>
): SyncStatus {
  const modifiedKeys: string[] = []
  const newKeys: string[] = []
  const removedKeys: string[] = []

  const currentKeySet = new Set(Object.keys(currentHashes))
  const storedKeySet = new Set(Object.keys(storedHashes))

  for (const key of currentKeySet) {
    if (storedKeySet.has(key)) {
      if (currentHashes[key] !== storedHashes[key]) {
        modifiedKeys.push(key)
      }
    } else {
      newKeys.push(key)
    }
  }

  for (const key of storedKeySet) {
    if (!currentKeySet.has(key)) {
      removedKeys.push(key)
    }
  }

  const inSync = modifiedKeys.length === 0 && newKeys.length === 0 && removedKeys.length === 0

  return { inSync, modifiedKeys, newKeys, removedKeys }
}

/**
 * Check sync status by comparing base language file with sync file
 */
function checkSyncStatus(localesDir: string, baseLanguage: string): SyncStatus | null {
  try {
    const baseFilePath = path.join(localesDir, `${baseLanguage}.json`)
    if (!fs.existsSync(baseFilePath)) {
      return null
    }

    const baseContent = fs.readFileSync(baseFilePath, 'utf-8')
    // Strip BOM for Windows compatibility
    const baseLocale = JSON.parse(stripBOM(baseContent))
    const currentHashes = flattenAndHashLocale(baseLocale)

    const syncData = loadSyncFile(localesDir)
    if (!syncData) {
      // No sync file = first run, consider in sync
      return { inSync: true, modifiedKeys: [], newKeys: [], removedKeys: [] }
    }

    return detectSyncChanges(currentHashes, syncData.keys)
  } catch {
    return null
  }
}

/**
 * Get a human-readable summary of sync changes
 */
function getSyncChangeSummary(status: SyncStatus): string {
  const parts: string[] = []
  if (status.modifiedKeys.length > 0) {
    parts.push(`${status.modifiedKeys.length} modified`)
  }
  if (status.newKeys.length > 0) {
    parts.push(`${status.newKeys.length} new`)
  }
  if (status.removedKeys.length > 0) {
    parts.push(`${status.removedKeys.length} removed`)
  }
  return parts.join(', ') || 'in sync'
}
const decorationType = vscode.window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 0.25em',
    color: new vscode.ThemeColor('editorCodeLens.foreground') as any
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
})
const hiddenTextDecorationType = vscode.window.createTextEditorDecorationType({
  // Hide original text when rendering locale-only mode but preserve layout width.
  // Use aggressive CSS so it works in all contexts (objects/JSX/Vue templates).
  // VS Code allows injecting extra CSS declarations via textDecoration.
  textDecoration: 'none; opacity: 0 !important; font-size: 0 !important; letter-spacing: -0.5em !important;'
})
// Separate decoration type for rendering values with 'before' so it is not affected by hidden style
const valueBeforeDecorationType = vscode.window.createTextEditorDecorationType({
  before: {
    // Ensure the rendered value participates in layout and is readable on dark/light themes
    color: new vscode.ThemeColor('editor.foreground') as any,
    margin: '0 0 0 0',
  }
})

// Utilities to mirror CLI behavior
function lastPathSegment(expr: string): string {
  const parts = String(expr).split('.')
  return parts[parts.length - 1]
}

function normalizeDynamicPlaceholders(value: string): string {
  let out = value
  // Convert {{name}} to {name}
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, v) => `{${lastPathSegment(v)}}`)
  // Convert ${name} to {name}
  out = out.replace(/\$\{\s*([\w.]+)\s*\}/g, (_m, v) => `{${lastPathSegment(v)}}`)
  return out
}

function stripHtmlTagsPreserveText(value: string): string {
  // Remove tags but keep inner text. Best-effort, non-greedy for tags
  return value.replace(/<[^>]*>/g, ' ')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeSelectedTextForI18n(value: string): string {
  let v = value
  v = normalizeDynamicPlaceholders(v)
  v = stripHtmlTagsPreserveText(v)
  v = normalizeWhitespace(v)
  return v
}

// Truncate preview content safely by Unicode code points (avoid breaking surrogate pairs)
function truncateForPreview(value: string, maxLength: number = 300): string {
  const codepoints = Array.from(String(value))
  if (codepoints.length <= maxLength) return value
  return codepoints.slice(0, maxLength).join('') + '…'
}

// Extract placeholder parameter names from a normalized i18n string, e.g. "Hello {name} ({count})" -> ['name','count']
function extractParamsFromNormalizedText(value: string): string[] {
  const params = new Set<string>()
  const rx = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g
  for (let m = rx.exec(value); m; m = rx.exec(value)) {
    params.add(m[1])
  }
  return Array.from(params)
}

// ============================================================================
// ADVANCED STRING CONVERSION SYSTEM
// Detects and converts dynamic values: template literals, concatenation, 
// numbers, currencies, dates, and method calls
// ============================================================================

interface DynamicValueMatch {
  type: 'interpolation' | 'number' | 'currency' | 'date' | 'method' | 'concat' | 'ternary'
  original: string
  paramName: string
  expression: string
  start: number
  end: number
}

interface AdvancedNormalizationResult {
  normalizedText: string
  params: DynamicValueMatch[]
  originalParams: Map<string, string> // paramName -> original expression
  hasAdvancedPatterns: boolean
}

/** Extract a clean parameter name from an expression */
function extractParamName(expr: string): string {
  const cleaned = expr.trim()
  // Handle method calls like user.getName() -> user
  const methodMatch = cleaned.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/)
  if (methodMatch) {
    const parts = methodMatch[0].split('.')
    // Use the last meaningful identifier before method call
    const lastPart = parts[parts.length - 1]
    // If it looks like a getter (getName, getCount), extract the noun
    const getterMatch = lastPart.match(/^get([A-Z][a-z]+)$/)
    if (getterMatch) {
      return getterMatch[1].toLowerCase()
    }
    return lastPart
  }
  // Fallback: extract first identifier
  const idMatch = cleaned.match(/([A-Za-z_$][A-Za-z0-9_$]*)/)
  return idMatch ? idMatch[1] : 'value'
}

/** Detect if expression involves number formatting */
function isNumberFormatting(expr: string): boolean {
  return /\.toFixed\s*\(/.test(expr) ||
         /\.toLocaleString\s*\(/.test(expr) ||
         /\.toPrecision\s*\(/.test(expr) ||
         /Number\s*\(/.test(expr) ||
         /parseFloat\s*\(/.test(expr) ||
         /parseInt\s*\(/.test(expr)
}

/** Detect if expression involves currency formatting */
function isCurrencyFormatting(expr: string): boolean {
  return /['"]currency['"]/.test(expr) ||
         /style:\s*['"]currency['"]/.test(expr) ||
         /formatCurrency/.test(expr) ||
         /\$\s*\+/.test(expr) ||
         /['"]USD['"]|['"]EUR['"]|['"]GBP['"]/.test(expr)
}

/** Detect if expression involves date formatting */
function isDateFormatting(expr: string): boolean {
  return /\.toLocaleDateString\s*\(/.test(expr) ||
         /\.toLocaleTimeString\s*\(/.test(expr) ||
         /\.toISOString\s*\(/.test(expr) ||
         /\.toDateString\s*\(/.test(expr) ||
         /formatDate/.test(expr) ||
         /new Date\s*\(/.test(expr) ||
         /dayjs|moment|date-fns/.test(expr)
}

/** Parse a template literal and extract interpolations */
function parseTemplateLiteral(text: string): AdvancedNormalizationResult {
  const params: DynamicValueMatch[] = []
  const originalParams = new Map<string, string>()
  let normalizedText = ''
  let lastIndex = 0
  let hasAdvanced = false
  
  // Match ${...} patterns, handling nested braces
  const regex = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
  let match: RegExpExecArray | null
  
  while ((match = regex.exec(text)) !== null) {
    const expr = match[1].trim()
    const paramName = extractParamName(expr)
    
    // Add text before this match
    normalizedText += text.slice(lastIndex, match.index)
    
    // Determine the type of dynamic value
    let type: DynamicValueMatch['type'] = 'interpolation'
    if (isNumberFormatting(expr)) {
      type = 'number'
      hasAdvanced = true
    } else if (isCurrencyFormatting(expr)) {
      type = 'currency'
      hasAdvanced = true
    } else if (isDateFormatting(expr)) {
      type = 'date'
      hasAdvanced = true
    } else if (/\(.*\)/.test(expr)) {
      type = 'method'
      hasAdvanced = true
    }
    
    // Ensure unique param names
    let uniqueName = paramName
    let counter = 1
    while (originalParams.has(uniqueName) && originalParams.get(uniqueName) !== expr) {
      uniqueName = `${paramName}${counter++}`
    }
    
    params.push({
      type,
      original: match[0],
      paramName: uniqueName,
      expression: expr,
      start: match.index,
      end: match.index + match[0].length
    })
    
    originalParams.set(uniqueName, expr)
    normalizedText += `{${uniqueName}}`
    lastIndex = match.index + match[0].length
  }
  
  normalizedText += text.slice(lastIndex)
  
  return {
    normalizedText,
    params,
    originalParams,
    hasAdvancedPatterns: hasAdvanced
  }
}

/** Parse string concatenation: 'Hello ' + name + '!' */
function parseStringConcatenation(text: string): AdvancedNormalizationResult | null {
  // Check if this looks like concatenation
  if (!text.includes('+')) return null
  
  const params: DynamicValueMatch[] = []
  const originalParams = new Map<string, string>()
  let normalizedText = ''
  let hasAdvanced = false
  
  // Split by + but preserve quoted strings
  const parts: string[] = []
  let current = ''
  let inString: string | null = null
  let depth = 0
  
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const prev = i > 0 ? text[i - 1] : ''
    
    if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
      inString = ch
      current += ch
    } else if (inString === ch && prev !== '\\') {
      inString = null
      current += ch
    } else if (!inString && ch === '(') {
      depth++
      current += ch
    } else if (!inString && ch === ')') {
      depth--
      current += ch
    } else if (!inString && depth === 0 && ch === '+') {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) {
    parts.push(current.trim())
  }
  
  // Need at least 2 parts for concatenation
  if (parts.length < 2) return null
  
  // Check if at least one part is a string literal and one is a variable
  let hasStringLiteral = false
  let hasVariable = false
  
  for (const part of parts) {
    if (/^['"`].*['"`]$/.test(part)) {
      hasStringLiteral = true
    } else if (/^[A-Za-z_$]/.test(part)) {
      hasVariable = true
    }
  }
  
  if (!hasStringLiteral || !hasVariable) return null
  
  // Build normalized text
  let paramIndex = 0
  for (const part of parts) {
    const trimmed = part.trim()
    
    if (/^['"`](.*?)['"`]$/.test(trimmed)) {
      // String literal - extract content
      const content = trimmed.slice(1, -1)
      normalizedText += content
    } else if (trimmed) {
      // Variable or expression
      const paramName = extractParamName(trimmed)
      let uniqueName = paramName
      let counter = 1
      while (originalParams.has(uniqueName) && originalParams.get(uniqueName) !== trimmed) {
        uniqueName = `${paramName}${counter++}`
      }
      
      let type: DynamicValueMatch['type'] = 'concat'
      if (isNumberFormatting(trimmed)) {
        type = 'number'
        hasAdvanced = true
      } else if (isCurrencyFormatting(trimmed)) {
        type = 'currency'
        hasAdvanced = true
      } else if (isDateFormatting(trimmed)) {
        type = 'date'
        hasAdvanced = true
      }
      
      params.push({
        type,
        original: trimmed,
        paramName: uniqueName,
        expression: trimmed,
        start: paramIndex,
        end: paramIndex + trimmed.length
      })
      
      originalParams.set(uniqueName, trimmed)
      normalizedText += `{${uniqueName}}`
      paramIndex++
    }
  }
  
  return {
    normalizedText: normalizedText.trim(),
    params,
    originalParams,
    hasAdvancedPatterns: hasAdvanced || params.length > 0
  }
}

/** Detect ternary expressions: condition ? 'yes' : 'no' */
function detectTernaryExpression(text: string): { isTernary: boolean; condition?: string; trueVal?: string; falseVal?: string } {
  const ternaryMatch = text.match(/^([^?]+)\s*\?\s*(['"`]?)([^:'"]+)\2\s*:\s*(['"`]?)([^'"]+)\4$/)
  if (ternaryMatch) {
    return {
      isTernary: true,
      condition: ternaryMatch[1].trim(),
      trueVal: ternaryMatch[3].trim(),
      falseVal: ternaryMatch[5].trim()
    }
  }
  return { isTernary: false }
}

/** Main advanced normalization function */
function advancedNormalizeString(rawText: string, context: 'vue-template' | 'jsx' | 'script'): AdvancedNormalizationResult {
  let text = rawText.trim()
  
  // Remove surrounding quotes if present
  if (/^['"`]/.test(text) && /['"`]$/.test(text)) {
    const quote = text[0]
    if (text[text.length - 1] === quote) {
      text = text.slice(1, -1)
    }
  }
  
  // Check for template literal (backticks)
  if (rawText.trim().startsWith('`') || text.includes('${')) {
    const result = parseTemplateLiteral(text)
    if (result.params.length > 0) {
      // Also apply basic normalization
      result.normalizedText = stripHtmlTagsPreserveText(result.normalizedText)
      result.normalizedText = normalizeWhitespace(result.normalizedText)
      return result
    }
  }
  
  // Check for string concatenation
  const concatResult = parseStringConcatenation(rawText)
  if (concatResult && concatResult.params.length > 0) {
    concatResult.normalizedText = stripHtmlTagsPreserveText(concatResult.normalizedText)
    concatResult.normalizedText = normalizeWhitespace(concatResult.normalizedText)
    return concatResult
  }
  
  // Check for Vue mustache syntax
  if (context === 'vue-template' && /\{\{.*\}\}/.test(text)) {
    const params: DynamicValueMatch[] = []
    const originalParams = new Map<string, string>()
    let normalized = text
    
    const mustacheRegex = /\{\{\s*([^}]+)\s*\}\}/g
    let match: RegExpExecArray | null
    
    while ((match = mustacheRegex.exec(text)) !== null) {
      const expr = match[1].trim()
      const paramName = extractParamName(expr)
      
      let uniqueName = paramName
      let counter = 1
      while (originalParams.has(uniqueName) && originalParams.get(uniqueName) !== expr) {
        uniqueName = `${paramName}${counter++}`
      }
      
      params.push({
        type: 'interpolation',
        original: match[0],
        paramName: uniqueName,
        expression: expr,
        start: match.index,
        end: match.index + match[0].length
      })
      
      originalParams.set(uniqueName, expr)
      normalized = normalized.replace(match[0], `{${uniqueName}}`)
    }
    
    return {
      normalizedText: normalizeWhitespace(stripHtmlTagsPreserveText(normalized)),
      params,
      originalParams,
      hasAdvancedPatterns: params.length > 0
    }
  }
  
  // Fallback to basic normalization
  const basicNormalized = normalizeSelectedTextForI18n(text)
  const basicParams = extractParamsFromNormalizedText(basicNormalized)
  const originalParams = new Map<string, string>()
  
  // Try to map extracted params back to original expressions
  for (const param of basicParams) {
    // Look for the param in the original text
    const paramRegex = new RegExp(`\\$\\{\\s*(${param}[^}]*)\\s*\\}|\\{\\{\\s*(${param}[^}]*)\\s*\\}\\}`, 'g')
    const paramMatch = paramRegex.exec(rawText)
    if (paramMatch) {
      originalParams.set(param, paramMatch[1] || paramMatch[2] || param)
    } else {
      originalParams.set(param, param)
    }
  }
  
  return {
    normalizedText: basicNormalized,
    params: basicParams.map((p, i) => ({
      type: 'interpolation' as const,
      original: p,
      paramName: p,
      expression: originalParams.get(p) || p,
      start: i,
      end: i + 1
    })),
    originalParams,
    hasAdvancedPatterns: false
  }
}

/** Generate the t() call expression with proper parameter object */
function generateTCallExpression(keyPath: string, result: AdvancedNormalizationResult): string {
  if (result.params.length === 0) {
    return `t('${keyPath}')`
  }
  
  // Build parameter object
  const paramEntries: string[] = []
  for (const param of result.params) {
    const expr = result.originalParams.get(param.paramName) || param.expression
    // If the expression is the same as param name, use shorthand
    if (expr === param.paramName) {
      paramEntries.push(param.paramName)
    } else {
      paramEntries.push(`${param.paramName}: ${expr}`)
    }
  }
  
  return `t('${keyPath}', { ${paramEntries.join(', ')} })`
}

// ============================================================================
// END ADVANCED STRING CONVERSION SYSTEM
// ============================================================================

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
    // Strip BOM for Windows compatibility
    const parsed = JSON.parse(stripBOM(content))
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

// Accept locale filenames like en.json, en-US.json, pt_BR.json, zh-Hant.json
function isLocaleFileName(fileName: string): boolean {
  if (!/\.json$/i.test(fileName)) return false
  const name = fileName.replace(/\.json$/i, '')
  // Start with 2-3 letters, optional region/script separated by '-' or '_',
  // and allow one extra segment for variants. Excludes names like 'package'.
  return /^[a-z]{2,3}([_-][a-zA-Z]{2,4})?([_-][A-Za-z0-9]+)?$/.test(name)
}

/**
 * Strip UTF-8 BOM (Byte Order Mark) from string content.
 * Windows apps often save UTF-8 files with BOM which causes JSON.parse to fail.
 */
function stripBOM(content: string): string {
  // UTF-8 BOM is EF BB BF, which appears as \uFEFF in JavaScript strings
  if (content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1)
  }
  return content
}

// ============================================================================
// SMART LOCALES FOLDER DETECTION
// Finds the actual locales folder even if user selects a parent directory
// ============================================================================

// Common folder names that contain locale files
const LOCALE_FOLDER_NAMES = [
  'locales',
  'locale',
  'lang',
  'langs',
  'languages',
  'i18n',
  'translations',
  'messages'
]

// Common nested patterns to check (order matters - more specific first)
const LOCALE_FOLDER_PATTERNS = [
  // Direct folders
  'locales',
  'locale',
  'lang',
  'langs',
  'languages',
  'translations',
  'messages',
  // i18n subfolders
  'i18n/locales',
  'i18n/locale',
  'i18n/lang',
  'i18n/messages',
  // src subfolders
  'src/locales',
  'src/locale',
  'src/i18n',
  'src/i18n/locales',
  'src/lang',
  'src/languages',
  // app subfolders (common in Nuxt, Next, etc.)
  'app/locales',
  'app/i18n',
  'app/i18n/locales',
  'app/lang',
  // public/assets
  'public/locales',
  'public/lang',
  'assets/locales',
  'assets/i18n',
  'assets/lang',
  // Other common patterns
  'resources/lang',
  'resources/locales',
  'config/locales',
  'lib/locales'
]

/**
 * Check if a directory contains locale JSON files
 */
function containsLocaleFiles(dirPath: string): boolean {
  try {
    // Ensure absolute path for consistent checks
    const checkPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath)
    
    if (!fs.existsSync(checkPath)) {
      return false
    }
    if (!fs.statSync(checkPath).isDirectory()) {
      return false
    }
    const files = fs.readdirSync(checkPath)
    const localeFiles = files.filter(f => isLocaleFileName(f))
    if (localeFiles.length > 0) {
      debugLog(`containsLocaleFiles: ${checkPath} has ${localeFiles.length} locale files: ${localeFiles.join(', ')}`)
    }
    return localeFiles.length >= 1 // At least 1 locale file
  } catch (e) {
    return false
  }
}

/**
 * Check known locale patterns at a single directory level (no recursion into children).
 * This is a focused check - only looks at the directory itself and known patterns.
 */
function checkLocalePatterns(dir: string): string | null {
  const searchDir = path.isAbsolute(dir) ? dir : path.resolve(dir)
  
  // 1. Check if this directory itself contains locale files
  if (containsLocaleFiles(searchDir)) {
    debugLog(`checkLocalePatterns: found locale files directly in ${searchDir}`)
    return searchDir
  }

  // 2. Check known patterns as direct children (NO recursive descent)
  for (const pattern of LOCALE_FOLDER_PATTERNS) {
    const candidate = path.join(searchDir, pattern)
    if (containsLocaleFiles(candidate)) {
      debugLog(`checkLocalePatterns: found locale files at pattern ${pattern}: ${candidate}`)
      return candidate
    }
  }

  return null
}

/**
 * Find the locales folder by walking UP from a file toward the workspace root.
 * Only checks known patterns at each level - does NOT recursively search into all subdirectories.
 * 
 * @param filePath - The file being edited
 * @param workspaceRoot - The workspace root (search stops here)
 */
function findLocalesFolderFromFile(filePath: string, workspaceRoot: string): string | null {
  const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)
  const absoluteWorkspaceRoot = path.isAbsolute(workspaceRoot) ? workspaceRoot : path.resolve(workspaceRoot)
  
  debugLog(`findLocalesFolderFromFile: starting from file=${absoluteFilePath}`)
  debugLog(`findLocalesFolderFromFile: workspace root=${absoluteWorkspaceRoot}`)
  
  let currentDir = path.dirname(absoluteFilePath)
  let iterations = 0
  const maxIterations = 20 // Safety limit
  
  // Walk UP from the file's directory toward the workspace root
  while (currentDir && iterations < maxIterations) {
    iterations++
    debugLog(`findLocalesFolderFromFile: checking level ${iterations}: ${currentDir}`)
    
    // Check known locale patterns at this level
    const found = checkLocalePatterns(currentDir)
    if (found) {
      debugLog(`findLocalesFolderFromFile: found locales at ${found}`)
      return found
    }
    
    // Stop if we've reached or passed the workspace root
    const normalizedCurrent = normalizePathForComparison(currentDir)
    const normalizedRoot = normalizePathForComparison(absoluteWorkspaceRoot)
    if (normalizedCurrent === normalizedRoot || 
        !normalizedCurrent.startsWith(normalizedRoot + path.sep) && normalizedCurrent !== normalizedRoot) {
      debugLog(`findLocalesFolderFromFile: reached workspace root, stopping`)
      break
    }
    
    // Move up one directory
    const parent = path.dirname(currentDir)
    if (parent === currentDir) {
      debugLog(`findLocalesFolderFromFile: reached filesystem root, stopping`)
      break
    }
    currentDir = parent
  }
  
  // Final check: check the workspace root itself
  const rootFound = checkLocalePatterns(absoluteWorkspaceRoot)
  if (rootFound) {
    debugLog(`findLocalesFolderFromFile: found locales at workspace root: ${rootFound}`)
    return rootFound
  }
  
  debugLog(`findLocalesFolderFromFile: no locales folder found`)
  return null
}

/**
 * Legacy function for backward compatibility - uses the new focused search.
 */
function findLocalesFolder(startDir: string, _maxDepth: number = 2): string | null {
  // Just check patterns at this directory - no recursive search
  return checkLocalePatterns(startDir)
}

/**
 * Given a selected folder, find the best locales folder.
 * Returns the selected folder if it contains locale files,
 * otherwise searches for a suitable child folder.
 */
function resolveLocalesFolder(selectedFolder: string): string {
  const found = findLocalesFolder(selectedFolder, 3)
  return found || selectedFolder
}

// ============================================================================
// MULTI-PROJECT / MONOREPO SUPPORT
// Finds the nearest locales folder relative to a given file
// ============================================================================

// Cache of discovered locales folders per workspace root
const localesFolderCache: Map<string, string | null> = new Map()

/**
 * Find the nearest locales folder for a given file by walking up the directory tree.
 * Uses a cache keyed by workspace root to avoid repeated file system lookups.
 * IMPORTANT: Only walks UP from the file, never searches into unrelated directories.
 */
function findNearestLocalesFolder(filePath: string, workspaceRoot?: string): string | null {
  debugLog(`findNearestLocalesFolder: filePath=${filePath}, workspaceRoot=${workspaceRoot}`)
  
  // Need workspace root to properly bound the search
  if (!workspaceRoot) {
    debugLog(`findNearestLocalesFolder: no workspace root provided, cannot search`)
    return null
  }
  
  // Normalize workspace root for cache lookup (Windows case-insensitive)
  const normalizedWorkspaceRoot = normalizePathForComparison(workspaceRoot)
  
  // Check cache first
  if (localesFolderCache.has(normalizedWorkspaceRoot)) {
    const cached = localesFolderCache.get(normalizedWorkspaceRoot) || null
    debugLog(`findNearestLocalesFolder: returning cached value: ${cached}`)
    return cached
  }
  
  // Use the focused search that walks UP from file to workspace root
  const found = findLocalesFolderFromFile(filePath, workspaceRoot)
  
  // Cache the result (including null to avoid repeated searches)
  if (found) {
    localesFolderCache.set(normalizedWorkspaceRoot, found)
  }
  
  return found
}

/**
 * Find locales folder specifically for a workspace root.
 * Only checks known patterns at the workspace root - does NOT search into all subdirectories.
 */
function findLocalesFolderForWorkspace(workspaceRoot: string): string | null {
  debugLog(`findLocalesFolderForWorkspace: workspaceRoot=${workspaceRoot}`)
  // Normalize workspace root for cache lookup (Windows case-insensitive)
  const normalizedWorkspaceRoot = normalizePathForComparison(workspaceRoot)
  
  // Check cache first
  const cached = localesFolderCache.get(normalizedWorkspaceRoot)
  if (cached) {
    debugLog(`findLocalesFolderForWorkspace: returning cached value: ${cached}`)
    return cached
  }
  
  // Only check known patterns at workspace root - no recursive descent
  const found = checkLocalePatterns(workspaceRoot)
  
  // Cache positive results
  if (found) {
    localesFolderCache.set(normalizedWorkspaceRoot, found)
    debugLog(`findLocalesFolderForWorkspace: found and cached: ${found}`)
  } else {
    debugLog(`findLocalesFolderForWorkspace: no locales found at workspace root`)
  }
  
  return found
}

/**
 * Clear the locales folder cache (useful when user changes settings)
 */
function clearLocalesFolderCache(): void {
  localesFolderCache.clear()
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

// Run stringer convert in integrated terminal
async function runConvertInTerminal(cwd: string) {
  const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Stringer Convert'), cwd })
  terminal.show()
  terminal.sendText('stringer convert', true)
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

// Return all <script> block ranges inside a Vue SFC
function getScriptRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const rx = /<script(?:\s[^>]*)?>/gi
  for (let m = rx.exec(source); m; m = rx.exec(source)) {
    const openIdx = (m.index as number) + m[0].length
    const closeIdx = source.indexOf('</script>', openIdx)
    if (closeIdx !== -1) {
      ranges.push({ start: openIdx, end: closeIdx })
    }
  }
  return ranges
}

function isInsideVueScript(source: string, offset: number): boolean {
  const ranges = getScriptRanges(source)
  for (const r of ranges) {
    if (offset >= r.start && offset <= r.end) return true
  }
  return false
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
    debugLog(`ensureProjectContext: CWD=${process.cwd()}`)
    debugLog(`ensureProjectContext: workspaceFolders=${workspaceFolders?.map(f => f.uri.fsPath).join(', ') || 'none'}`)
    const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri) || (workspaceFolders && workspaceFolders[0])
    if (!folder) {
      debugLog(`ensureProjectContext: no workspace folder found`)
      return false
    }
    const projectRoot = folder.uri.fsPath
    debugLog(`ensureProjectContext: projectRoot=${projectRoot}`)
    const config = await loadCliProjectConfig(projectRoot)

    // Always rely on a user-selected locales folder (persisted per workspace)
    let localesDir: string | null = null
    let baseLanguage: string = config?.baseLanguage || 'en'

    const stateKey = `stringer.localesDir.${projectRoot}`
    try {
      const saved = context.workspaceState.get<string | undefined>(stateKey)
      if (typeof saved === 'string' && saved && fs.existsSync(saved)) localesDir = saved
    } catch {}

      if (!localesDir) {
        // Try auto-detection: search UP from active file toward workspace root
        debugLog(`ensureProjectContext: auto-detecting locales folder from file ${ed.document.uri.fsPath}`)
        const autoDetected = findLocalesFolderFromFile(ed.document.uri.fsPath, projectRoot)
        if (autoDetected) {
          localesDir = autoDetected
          debugLog(`ensureProjectContext: auto-detected locales folder: ${localesDir}`)
          try { await context.workspaceState.update(stateKey, localesDir) } catch {}
        } else {
          // No locales folder found - user can manually select via the 🌐Stringer menu
          debugLog(`ensureProjectContext: no locales folder found, returning false`)
          return false
        }
      }

    // Infer base language from files if possible
    try {
      const files = fs.readdirSync(localesDir).filter((f) => isLocaleFileName(f))
      debugLog(`ensureProjectContext: locale files in ${localesDir}: ${files.join(', ')}`)
      if (files.includes('en.json')) baseLanguage = 'en'
      else if (files.length > 0) baseLanguage = files[0].replace(/\.json$/, '')
      debugLog(`ensureProjectContext: detected baseLanguage: ${baseLanguage}`)
    } catch (e) {
      debugLog(`ensureProjectContext: error reading locale files: ${e}`)
    }

    projectContext = { projectRoot, localesDir: localesDir!, baseLanguage }
    debugLog(`ensureProjectContext: set projectContext = { projectRoot: ${projectRoot}, localesDir: ${localesDir}, baseLanguage: ${baseLanguage} }`)

    // Initialize preview language from settings or base language
    const extConfig = vscode.workspace.getConfiguration('stringerHelper')
    const preferred = extConfig.get<string>('defaultPreviewLanguage')
    // Derive available languages from actual filenames in localesDir
    let available: string[] = []
    try {
      available = fs
        .readdirSync(localesDir)
        .filter((f) => isLocaleFileName(f))
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
        // Also clear per-project caches for monorepo support
        clearAllProjectContextCaches()
        await preloadLocales()
        refreshActiveEditorDecorations()
      }
      localeWatcher.onDidChange(reload)
      localeWatcher.onDidCreate(reload)
      localeWatcher.onDidDelete(reload)
      context.subscriptions.push(localeWatcher)
    } catch {}

    // Setup sync watcher to detect base language changes
    if (syncWatcher) {
      syncWatcher.dispose()
      syncWatcher = null
    }
    try {
      const baseLangPattern = new vscode.RelativePattern(localesDir, `${baseLanguage}.json`)
      syncWatcher = vscode.workspace.createFileSystemWatcher(baseLangPattern)
      
      const checkAndNotifySync = async () => {
        if (!projectContext) return
        const status = checkSyncStatus(projectContext.localesDir, projectContext.baseLanguage)
        if (status && !status.inSync && !pendingSyncAlert) {
          pendingSyncAlert = true
          const summary = getSyncChangeSummary(status)
          const alignNow = vscode.l10n.t('Align Now')
          const remindLater = vscode.l10n.t('Remind Later')
          
          const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Stringer: Your base language file has changed ({0}). Run Align to update translations.',
              summary
            ),
            alignNow,
            remindLater
          )
          
          if (choice === alignNow) {
            const workspaceFolders = vscode.workspace.workspaceFolders
            const folder = vscode.window.activeTextEditor
              ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
              : (workspaceFolders && workspaceFolders[0])
            if (folder) {
              await runAlignInTerminal(folder.uri.fsPath)
            }
          }
          
          // Reset pending alert after user responds or after a delay
          setTimeout(() => {
            pendingSyncAlert = false
          }, 60000) // Don't re-alert for 1 minute
        }
      }
      
      syncWatcher.onDidChange(checkAndNotifySync)
      context.subscriptions.push(syncWatcher)
    } catch {}

    await preloadLocales()
    return true
  }

  async function promptOpenWorkspaceFolder(): Promise<void> {
    const pick = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: vscode.l10n.t('Open a folder to use Stringer Helper')
    })
    if (pick && pick[0]) {
      await vscode.commands.executeCommand('vscode.openFolder', pick[0], false)
    }
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
      // BUT: only do this fallback if the requested key is NOT itself a 4-digit number
      // (if user explicitly requests a specific 4-digit key that doesn't exist, return undefined)
      const isLast = i === parts.length - 1
      const isRequestingSpecific4Digit = /^\d{4}$/.test(part)
      if (isLast && node && typeof node === 'object' && !isRequestingSpecific4Digit) {
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
          // Strip BOM for Windows compatibility
          const json = JSON.parse(stripBOM(txt))
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
  // Best-effort regex for t('...') calls; support optional second arg like t('key', {...})
  const rx = /\bt\(\s*(['"`])([^'"`]+?)\1(?:\s*,[^)]*)?\s*\)/g
    for (let m: RegExpExecArray | null = rx.exec(text); m; m = rx.exec(text)) {
      const key = m[2]
      const start = m.index
      const end = m.index + m[0].length
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end))
      results.push({ range, key })
    }
    return results
  }

  // Detect <i18n-t keypath="..."> usages inside Vue templates
  function findI18nKeypathRanges(
    doc: vscode.TextDocument
  ): Array<{ range: vscode.Range; key: string; isAttribute?: boolean }> {
    const text = doc.getText()
    const results: Array<{ range: vscode.Range; key: string; isAttribute?: boolean }> = []
    const rx = /<i18n-t[^>]*\bkeypath\s*=\s*(['"])([^'"\n]+?)\1/gi
    for (let m: RegExpExecArray | null = rx.exec(text); m; m = rx.exec(text)) {
      const key = m[2]
      const full = m[0]
      const rel = full.indexOf(key)
      const start = m.index + (rel >= 0 ? rel : 0)
      const end = start + key.length
      const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end))
      results.push({ range, key, isAttribute: true })
    }
    return results
  }

  function getTTupleAtPosition(doc: vscode.TextDocument, position: vscode.Position): { range: vscode.Range; key: string } | null {
    const ranges = findTTupleRanges(doc)
    for (const r of ranges) {
      if (r.range.contains(position)) return r
    }
    return null
  }

  // Fallback: find first t('...') or <i18n-t keypath="..."> occurring on the given line
  function getTTupleOnLine(doc: vscode.TextDocument, line: number): { range: vscode.Range; key: string } | null {
    const tuples = findTTupleRanges(doc)
    for (const t of tuples) {
      if (t.range.start.line <= line && line <= t.range.end.line) return t
    }
    const attrs = findI18nKeypathRanges(doc)
    for (const a of attrs) {
      if (a.range.start.line <= line && line <= a.range.end.line) return { range: a.range, key: a.key }
    }
    return null
  }

  function escapeHtmlAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  }

  function escapeJsString(value: string, quote: '"' | "'" = '"'): string {
    const q = quote === '"' ? '"' : "'"
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), `\\${q}`)
  }

  function findEnclosingMustache(source: string, offset: number): { start: number; end: number } | null {
    const openIdx = source.lastIndexOf('{{', offset)
    if (openIdx === -1) return null
    const closeIdx = source.indexOf('}}', openIdx + 2)
    if (closeIdx === -1) return null
    if (offset < openIdx || offset > closeIdx) return null
    return { start: openIdx, end: closeIdx + 2 }
  }

  function decorateEditor(editor: vscode.TextEditor) {
    const cfg = vscode.workspace.getConfiguration('stringerHelper')
    const enable = cfg.get<boolean>('enableInlinePreview', true)
    const keyMode = (cfg.get<string>('inlinePreviewKeyMode') || 'hidden') as 'hidden' | 'full' | 'leaf'
    const hoverShowsKey = cfg.get<boolean>('hoverShowsKey', true)
    const previewBg = (cfg.get<string>('previewBackgroundColor') || 'hsl(270, 55%, 43%)') as any
    if (!enable) {
      // Ensure all decoration layers are cleared when preview is disabled
      editor.setDecorations(decorationType, [])
      editor.setDecorations(hiddenTextDecorationType, [])
      editor.setDecorations(valueBeforeDecorationType, [])
      return
    }
    const found = [
      ...findTTupleRanges(editor.document),
      ...findI18nKeypathRanges(editor.document)
    ]
    const decorations: vscode.DecorationOptions[] = []
    const hiddenRanges: vscode.DecorationOptions[] = []
    const hiddenModeValueDecorations: vscode.DecorationOptions[] = []
    const docText = editor.document.getText()
    const filePath = editor.document.uri.fsPath
    const isVue = isVueFile(filePath)
    const isJsx = isJsxFile(filePath)
    
    // Get workspace folder for this file
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
    const workspaceRoot = workspaceFolder?.uri.fsPath
    
    debugLog(`decorateEditor: file=${filePath}`)
    debugLog(`decorateEditor: workspaceRoot=${workspaceRoot}`)
    debugLog(`decorateEditor: projectContext=${projectContext ? `localesDir=${projectContext.localesDir}, baseLanguage=${projectContext.baseLanguage}` : 'null'}`)
    
    // Try to get per-file project context (monorepo support)
    const fileCtx = getProjectContextForFile(filePath, workspaceRoot)
    debugLog(`decorateEditor: fileCtx=${fileCtx ? `localesDir=${fileCtx.localesDir}, baseLanguage=${fileCtx.baseLanguage}` : 'null'}`)
    
    // Only fall back to global projectContext if:
    // 1. Per-file detection failed, AND
    // 2. The file is in the same workspace as the global context
    // This prevents showing wrong translations in multi-root workspaces
    let effectiveCtx = fileCtx
    if (!effectiveCtx && projectContext) {
      const globalRoot = projectContext.projectRoot
      // Normalize paths for cross-platform comparison (Windows case-insensitive)
      const normalizedWorkspaceRoot = workspaceRoot ? normalizePathForComparison(workspaceRoot) : undefined
      const normalizedGlobalRoot = normalizePathForComparison(globalRoot)
      const normalizedFilePath = normalizePathForComparison(filePath)
      
      // Ensure paths don't have trailing separators for consistent comparison
      const trimSep = (p: string) => p.replace(/[/\\]+$/, '')
      const trimmedGlobalRoot = trimSep(normalizedGlobalRoot)
      const trimmedFilePath = trimSep(normalizedFilePath)
      const trimmedWorkspaceRoot = normalizedWorkspaceRoot ? trimSep(normalizedWorkspaceRoot) : undefined
      
      // Check if file is in the same project:
      // 1. Workspace roots match exactly, OR
      // 2. File path starts with the project root + separator (file is inside project)
      // 3. File path equals project root (edge case)
      const isInSameProject = 
        (trimmedWorkspaceRoot && trimmedWorkspaceRoot === trimmedGlobalRoot) || 
        (trimmedGlobalRoot && (
          trimmedFilePath === trimmedGlobalRoot ||
          trimmedFilePath.startsWith(trimmedGlobalRoot + path.sep) ||
          trimmedFilePath.startsWith(trimmedGlobalRoot + '/')  // Handle mixed separators
        ))
      debugLog(`decorateEditor: isInSameProject check: trimmedWorkspaceRoot=${trimmedWorkspaceRoot}, trimmedGlobalRoot=${trimmedGlobalRoot}, trimmedFilePath=${trimmedFilePath}`)
      if (isInSameProject) {
        debugLog(`decorateEditor: using global projectContext as effectiveCtx`)
        effectiveCtx = {
          localesDir: projectContext.localesDir,
          baseLanguage: projectContext.baseLanguage,
          localeData: localeCache,
          availableLanguages: []
        }
      } else {
        debugLog(`decorateEditor: file not in same project, effectiveCtx remains ${effectiveCtx ? 'set' : 'null'}`)
      }
    }
    
    debugLog(`decorateEditor: effectiveCtx=${effectiveCtx ? `localesDir=${effectiveCtx.localesDir}` : 'null'}, found ${found.length} t() calls`)
    
    for (const item of found) {
      // Use per-file context for translation lookup
      const value = effectiveCtx 
        ? getTranslationForProject(effectiveCtx, item.key)
        : getTranslation(item.key)
      debugLog(`decorateEditor: key=${item.key}, value=${value ?? 'NOT FOUND'}`)
      const textToShow = value ?? ''
      const startOffset = editor.document.offsetAt(item.range.start)
      const inVueTemplate = isVue && isVueTemplateTextNode(docText, startOffset)
      const inJsxUi = isJsx && isLikelyJsxUiContext(docText, startOffset)
      const inVueAttr = isVue && !!getAttributeContext(docText, startOffset)
      const inJsxAttr = isJsx && !!getJsxAttributeContext(docText, startOffset)
      const inVueScript = isVue && isInsideVueScript(docText, startOffset)
      // Generic script contexts: non-Vue non-JSX files, or JSX outside UI/attr
      const inGenericScript = (!isVue && !isJsx) || (isJsx && !inJsxUi && !inJsxAttr)
      // Missing is determined against the ACTIVE locale file only (no fallback),
      // so removing a key from the active file turns it red immediately.
      const lang = (activePreviewLanguage || effectiveCtx?.baseLanguage || projectContext?.baseLanguage) as string
      // Ensure locale is loaded before checking activeDirect
      let activeDirect: any = undefined
      if (effectiveCtx) {
        // Explicitly load the locale file if not already loaded
        loadLocaleForProject(effectiveCtx, lang)
        if (effectiveCtx.localeData[lang]) {
          activeDirect = getValueByPathLoose(effectiveCtx.localeData[lang], item.key)
        }
      } else if (projectContext) {
        // Use both strict and loose matching for consistency
        activeDirect = getValueByPath(localeCache[lang], item.key) || getValueByPathLoose(localeCache[lang], item.key)
      }
      const isMissing = !activeDirect && (inVueTemplate || inJsxUi || inVueAttr || inJsxAttr || inVueScript || inGenericScript)
      // If there is no value to show (and not a missing-key case) and we're not in hidden mode, skip rendering
      if (!textToShow && !isMissing && keyMode !== 'hidden') continue
      // In hidden mode we want to show only the locale value and hide the original code everywhere
      const displayLang = activePreviewLanguage || effectiveCtx?.baseLanguage || ''
      const hover = new vscode.MarkdownString()
      if (hoverShowsKey) hover.appendMarkdown(vscode.l10n.t('Key: {0}', `\`${item.key}\``))
      hover.appendMarkdown('\n\n')
      hover.appendMarkdown(vscode.l10n.t('Value ({0}): {1}', displayLang, String(value ?? '')))
      const leaf = item.key.split('.').pop() || item.key
      // Key+locale mode should not duplicate the key (code already shows it)
      // Leaf mode shows a compact key prefix; Hidden mode shows only value and hides the code
      const keyLabel = keyMode === 'leaf' ? `[${leaf}] ` : ''
      // Expand preview/hidden range to include surrounding template/JSX braces when applicable
      let previewRange = item.range
      if (inVueTemplate) {
        const must = findEnclosingMustache(docText, startOffset)
        if (must) {
          previewRange = new vscode.Range(
            editor.document.positionAt(must.start),
            editor.document.positionAt(must.end)
          )
        }
      } else if (!isVue && isJsx && inJsxUi) {
        let left = editor.document.offsetAt(item.range.start) - 1
        while (left >= 0 && /\s/.test(docText[left])) left--
        let right = editor.document.offsetAt(item.range.end)
        while (right < docText.length && /\s/.test(docText[right])) right++
        if (docText[left] === '{' && docText[right] === '}') {
          previewRange = new vscode.Range(
            editor.document.positionAt(left),
            editor.document.positionAt(right + 1)
          )
        }
      }

      if (keyMode === 'hidden') {
        // 1) Hide the original text entirely (collapsed width)
        hiddenRanges.push({ range: previewRange })
        // 2) Render the value via a separate decoration so opacity does not affect it
        hiddenModeValueDecorations.push({
          range: previewRange,
          // Avoid duplicate hover (decoration + provider); provider will handle it
          renderOptions: {
            // Use `before` to ensure visibility even when the original range is fully hidden
            before: {
              contentText: `${truncateForPreview(isMissing ? vscode.l10n.t('Locale Key Missing!!') : textToShow)}`,
              backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg) as any,
              color: '#ffffff' as any,
              margin: '0 0 0 0.15em',
              border: '1px solid',
              borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg) as any,
              textDecoration: 'border-radius: 6px; padding: 0 4px;'
            }
          }
        })
      } else {
        decorations.push({
          range: item.range,
          hoverMessage: hover,
          renderOptions: {
            after: {
              contentText: `${keyLabel}${truncateForPreview(isMissing ? vscode.l10n.t('Locale Key Missing!!') : textToShow)}`,
              backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg) as any,
              color: '#ffffff' as any,
              margin: '0 0 0 0.15em',
              border: '1px solid',
              borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg) as any,
              textDecoration: 'border-radius: 6px; padding: 0 4px;'
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
      const filePath = document.uri.fsPath
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
      const workspaceRoot = workspaceFolder?.uri.fsPath
      
      // Get per-file context for monorepo support
      const fileCtx = getProjectContextForFile(filePath, workspaceRoot)
      
      const ranges = findTTupleRanges(document)
      for (const r of ranges) {
        if (r.range.contains(position)) {
          // Use per-file context if available, otherwise fall back to global
          const value = fileCtx 
            ? getTranslationForProject(fileCtx, r.key)
            : getTranslation(r.key)
          const displayLang = activePreviewLanguage || fileCtx?.baseLanguage || ''
          const md = new vscode.MarkdownString()
          md.appendMarkdown(`Key: \`${r.key}\``)
          if (value) md.appendMarkdown(`\n\nValue (${displayLang}): ${value}`)
          return new vscode.Hover(md, r.range)
        }
      }
      return undefined
    }
  })
  context.subscriptions.push(hoverProvider)

  async function getAvailableLocales(): Promise<string[]> {
    // Try to get locales from active editor's project first (monorepo support)
    const editor = vscode.window.activeTextEditor
    if (editor) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
      const fileCtx = getProjectContextForFile(editor.document.uri.fsPath, workspaceFolder?.uri.fsPath)
      if (fileCtx) {
        return fileCtx.availableLanguages
      }
    }
    // Fall back to global context
    if (!projectContext) return []
    try {
      return fs
        .readdirSync(projectContext.localesDir)
        .filter((f) => isLocaleFileName(f))
        .map((f) => f.replace(/\.json$/, ''))
    } catch {
      return []
    }
  }

  async function choosePreviewLanguage(): Promise<void> {
    // Try per-file context first (monorepo support)
    let localesDir = projectContext?.localesDir
    const editor = vscode.window.activeTextEditor
    if (editor) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
      const fileCtx = getProjectContextForFile(editor.document.uri.fsPath, workspaceFolder?.uri.fsPath)
      if (fileCtx) {
        localesDir = fileCtx.localesDir
      }
    }
    
    if (!localesDir) {
      const ok = await ensureProjectContext(null)
      if (!ok) {
        await promptOpenWorkspaceFolder()
        return
      }
      localesDir = projectContext?.localesDir
    }
    if (!localesDir) return
    const items = await getAvailableLocales()
    if (items.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('No locale files found in {0}', localesDir))
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
  context.subscriptions.push(previewStatusItem)

  const changeLangCmd = vscode.commands.registerCommand('stringer.changePreviewLanguage', async () => {
    await choosePreviewLanguage()
  })
  context.subscriptions.push(changeLangCmd)

  const changeLocalesDirCmd = vscode.commands.registerCommand('stringer.changeLocalesFolder', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders
    const folder = vscode.window.activeTextEditor
      ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
      : (workspaceFolders && workspaceFolders[0])
    if (!folder) return
    const projectRoot = folder.uri.fsPath
    const stateKey = `stringer.localesDir.${projectRoot}`
    const pick = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      title: vscode.l10n.t('Select your locales folder (contains *.json locale files)'),
      defaultUri: folder.uri
    })
    if (!pick || pick.length === 0) return
    
    // Smart folder resolution: find actual locales folder even if user selects parent
    const selectedPath = pick[0].fsPath
    const localesDir = resolveLocalesFolder(selectedPath)
    
    // Notify user if we found a better folder
    if (localesDir !== selectedPath) {
      vscode.window.showInformationMessage(
        vscode.l10n.t('Stringer detected locales folder at: {0}', localesDir)
      )
    }
    
    try { await context.workspaceState.update(stateKey, localesDir) } catch {}
    
    // Clear the folder cache when user manually selects a folder
    clearLocalesFolderCache()
    
    // Reinitialize context and refresh
    await ensureProjectContext(vscode.window.activeTextEditor)
    langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage ?? '—'}`
    previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`
    refreshActiveEditorDecorations()
  })
  context.subscriptions.push(changeLocalesDirCmd)

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
        { label: vscode.l10n.t('No preview'), description: vscode.l10n.t('Hide all inline translations'), value: 'off' },
        { label: vscode.l10n.t('Key + locale preview'), description: vscode.l10n.t('Show full key and translation'), value: 'full' },
        { label: vscode.l10n.t('Locale only preview'), description: vscode.l10n.t('Show translation only'), value: 'hidden' }
      ],
      { title: vscode.l10n.t('Stringer: Change Preview Mode'), placeHolder: vscode.l10n.t('Select inline preview mode') }
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
    // Clear all per-project caches for monorepo support
    clearAllProjectContextCaches()
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
        { v: 'off', l: vscode.l10n.t('No preview') },
        { v: 'full', l: vscode.l10n.t('Key + locale preview') },
        { v: 'hidden', l: vscode.l10n.t('Locale only preview') }
      ].map(({ v, l }) => `<option value="${v}" ${((!enable && v==='off') || (enable && v===keyMode)) ? 'selected' : ''}>${l}</option>`).join('')
      const lblPreviewMode = vscode.l10n.t('Preview mode:')
      const lblPreviewLanguage = vscode.l10n.t('Preview language:')
      const lblReload = vscode.l10n.t('Reload locales')
      const lblAlign = vscode.l10n.t('Align Translations')
      const lblCurrent = vscode.l10n.t('Current: {0}', previewLabel)
      const lblWebsite = vscode.l10n.t('Website')
      const lblDocs = vscode.l10n.t('Docs')
      const lblBilling = vscode.l10n.t('Billing')

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
  <h2>${vscode.l10n.t('Stringer Control Panel')}</h2>
  <div class="group">
    <div class="row">
      <label>${lblPreviewMode}</label>
      <select id="mode">${modeOptions}</select>
      <span class="muted">${lblCurrent}</span>
    </div>
    <div class="row">
      <label>${lblPreviewLanguage}</label>
      <select id="lang">${langOptions}</select>
      <button id="reload">${lblReload}</button>
    </div>
  </div>
  <div class="group">
    <div class="row">
      <button id="align">${lblAlign}</button>
    </div>
  </div>
  <div class="group links">
    <a href="#" data-link="${website}">${lblWebsite}</a>
    <a href="#" data-link="${docs}">${lblDocs}</a>
    <a href="#" data-link="${billing}">${lblBilling}</a>
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

  async function updateHasKeyContext(editor?: vscode.TextEditor | null) {
    const ed = editor ?? vscode.window.activeTextEditor
    if (!ed) {
      await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyAtCursor', false)
      await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyOnLine', false)
      return
    }
    const pos = ed.selection.active
    const hit = getTTupleAtPosition(ed.document, pos)
    await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyAtCursor', !!hit)
    const lineHit = getTTupleOnLine(ed.document, pos.line)
    await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyOnLine', !!lineHit)
  }

  vscode.window.onDidChangeTextEditorSelection(async () => {
    await updateHasKeyContext()
  })
  vscode.window.onDidChangeActiveTextEditor(async () => {
    await updateHasKeyContext()
  })
  vscode.workspace.onDidChangeTextDocument(async (e) => {
    if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
      await updateHasKeyContext(vscode.window.activeTextEditor)
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
      const filePath = editor.document.uri.fsPath
      const docText = editor.document.getText()
      const startOffset = editor.document.offsetAt(selection.start)
      
      const inVue = isVueFile(filePath)
      const inJsx = isJsxFile(filePath)
      const isTplText = inVue && isVueTemplateTextNode(docText, startOffset)
      
      // Determine context for advanced normalization
      const normContext: 'vue-template' | 'jsx' | 'script' = 
        isTplText ? 'vue-template' : 
        inJsx ? 'jsx' : 
        'script'
      
      // Use advanced normalization to detect dynamic values
      const advancedResult = advancedNormalizeString(selectedText, normContext)
      const selectedString = advancedResult.normalizedText
      const params = advancedResult.params

      const workspaceFolders = vscode.workspace.workspaceFolders
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) || (workspaceFolders && workspaceFolders[0])
      if (!folder) {
        await promptOpenWorkspaceFolder()
        return
      }
      const projectRoot = folder.uri.fsPath

      const config = await loadCliProjectConfig(projectRoot)
      if (!config) {
        const ok = await ensureProjectContext(editor)
        if (!ok || !projectContext) {
          await promptOpenWorkspaceFolder()
          return
        }
      }

      const outputDirConfigured: string = (config && config.outputDir) || projectContext?.localesDir || path.join('i18n', 'locales')
      const localesDir = projectContext?.localesDir || path.resolve(projectRoot, outputDirConfigured)
      ensureDir(localesDir)

      const baseLanguage: string = (config && config.baseLanguage) || (projectContext?.baseLanguage || 'en')
      const baseLangPath = path.join(localesDir, `${baseLanguage}.json`)

      if (!fs.existsSync(baseLangPath)) {
        ensureDir(path.dirname(baseLangPath))
        fs.writeFileSync(baseLangPath, JSON.stringify({}, null, 2))
      }

      let baseJson: Record<string, any> = {}
      try {
        // Strip BOM for Windows compatibility
        baseJson = JSON.parse(stripBOM(fs.readFileSync(baseLangPath, 'utf-8')))
      } catch (_e) {
        vscode.window.showErrorMessage(
          vscode.l10n.t(
            'Base language file has invalid JSON. Please fix it and try again. No changes were made.'
          )
        )
        return
      }

      const keyPathPrefix = generateKeyPath(filePath, projectRoot)
      if (!keyPathPrefix) {
        vscode.window.showErrorMessage(vscode.l10n.t('Cannot derive key path from file location.'))
        return
      }

      const { updated, fullKeyPath } = addStringToBaseLanguage(baseJson, keyPathPrefix, selectedString)

      fs.writeFileSync(baseLangPath, JSON.stringify(updated, null, 2))

      const attrCtx = inVue ? getAttributeContext(docText, startOffset) : null
      const jsxAttrCtx = !inVue && inJsx ? getJsxAttributeContext(docText, startOffset) : null

      // Generate the t() call expression using advanced result
      const expr = generateTCallExpression(fullKeyPath, advancedResult)

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
          const must = findEnclosingMustache(docText, startOffset)
          if (must) {
            const strBounds = findEnclosingStringLiteralBounds(docText, startOffset)
            if (strBounds) {
              const range = new vscode.Range(
                editor.document.positionAt(strBounds.qStart),
                editor.document.positionAt(strBounds.qEnd + 1)
              )
              edit.replace(range, expr)
            } else {
              edit.replace(selection, expr)
            }
          } else {
            edit.replace(selection, `{{ ${expr} }}`)
          }
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

  // (Restore and delete key) feature removed

  // Revert only the current t('key') usage to original base-language value (no locale deletion)
  const revertToOriginalCmd = vscode.commands.registerCommand('stringer.revertToOriginalText', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const pos = editor.selection.active
    const hit = getTTupleAtPosition(doc, pos) || getTTupleOnLine(doc, pos.line)
    if (!hit) {
      vscode.window.showInformationMessage(vscode.l10n.t("Place the cursor inside or on the same line as a t('key') call."))
      return
    }
    if (!projectContext) {
      const ok = await ensureProjectContext(editor)
      if (!ok || !projectContext) return
    }
    await preloadLocales()
    const baseJson = localeCache[projectContext!.baseLanguage]
    const baseValue = getValueByPath(baseJson, hit.key) || getValueByPathLoose(baseJson, hit.key)
    if (typeof baseValue !== 'string') {
      vscode.window.showErrorMessage(vscode.l10n.t('Base language value not found for {0}', hit.key))
      return
    }
    const docText = doc.getText()
    const startOffset = doc.offsetAt(hit.range.start)
    const filePath = doc.uri.fsPath
    const inVue = isVueFile(filePath)
    const inJsx = isJsxFile(filePath)
    const inVueTpl = inVue && isVueTemplateTextNode(docText, startOffset)
    let replaceStart = hit.range.start
    let replaceEnd = hit.range.end
    let replacement = ''
    if (inVue && inVueTpl) {
      const must = findEnclosingMustache(docText, startOffset)
      if (must) {
        replaceStart = doc.positionAt(must.start)
        replaceEnd = doc.positionAt(must.end)
        replacement = baseValue
      } else {
        replacement = baseValue
      }
    } else if (inVue) {
      const attrCtx = getAttributeContext(docText, startOffset)
      if (attrCtx) {
        const { name, isBound, attrStart, valueStart, valueEnd } = attrCtx
        if (isBound) {
          replaceStart = doc.positionAt(attrStart)
          replaceEnd = doc.positionAt(valueEnd + 1)
          replacement = `${name}="${escapeHtmlAttr(baseValue)}"`
        } else {
          replaceStart = doc.positionAt(valueStart)
          replaceEnd = doc.positionAt(valueEnd)
          replacement = escapeHtmlAttr(baseValue)
        }
      } else {
        replacement = `"${escapeJsString(baseValue, '"')}"`
      }
    } else if (inJsx) {
      let left = startOffset - 1
      while (left >= 0 && /\s/.test(docText[left])) left--
      let right = doc.offsetAt(hit.range.end)
      while (right < docText.length && /\s/.test(docText[right])) right++
      const hasBraces = docText[left] === '{' && docText[right] === '}'
      const lastLt = docText.lastIndexOf('<', left)
      const lastGt = docText.lastIndexOf('>', left)
      const eq = docText.lastIndexOf('=', left)
      const inAttribute = eq > lastLt && eq > lastGt
      if (hasBraces && inAttribute) {
        replaceStart = doc.positionAt(left)
        replaceEnd = doc.positionAt(right + 1)
        replacement = `"${escapeJsString(baseValue, '"')}"`
      } else if (hasBraces && !inAttribute) {
        replaceStart = doc.positionAt(left)
        replaceEnd = doc.positionAt(right + 1)
        replacement = baseValue
      } else if (inAttribute) {
        replacement = `"${escapeJsString(baseValue, '"')}"`
      } else {
        replacement = `'${escapeJsString(baseValue, "'")}'`
      }
    } else {
      replacement = `'${escapeJsString(baseValue, "'")}'`
    }
    await withEdit(editor, (edit) => {
      edit.replace(new vscode.Range(replaceStart, replaceEnd), replacement)
    })
    refreshActiveEditorDecorations()
    await updateHasKeyContext(editor)
  })
  context.subscriptions.push(revertToOriginalCmd)

  // Ignore this line: inserts language-appropriate comment with @stringer-ignore-next-line
  const ignoreLineCmd = vscode.commands.registerCommand('stringer.ignoreLine', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const pos = editor.selection.active
    const langId = doc.languageId

    const getLineComment = (languageId: string): string => {
      // Default to //, HTML/Vue template to <!-- -->, but we insert as single-line style where possible
      if (languageId === 'html') return '<!-- @stringer-ignore-next-line -->'
      if (languageId === 'vue') {
        // Insert as JS comment above the script/template line; prefer //
        return '// @stringer-ignore-next-line'
      }
      if (languageId === 'javascript' || languageId === 'typescript' || languageId === 'javascriptreact' || languageId === 'typescriptreact') {
        return '// @stringer-ignore-next-line'
      }
      if (languageId === 'markdown') return '<!-- @stringer-ignore-next-line -->'
      return '// @stringer-ignore-next-line'
    }

    const line = doc.lineAt(pos.line)
    const insertPos = new vscode.Position(line.lineNumber, 0)
    const prefix = getLineComment(doc.languageId)
    await withEdit(editor, (edit) => {
      edit.insert(insertPos, `${prefix}\n`)
    })
  })
  context.subscriptions.push(ignoreLineCmd)

  // Ignore this file: insert a top-of-file marker @stringer-ignore
  const ignoreFileCmd = vscode.commands.registerCommand('stringer.ignoreFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) return
    const doc = editor.document
    const firstLine = doc.lineAt(0)
    const langId = doc.languageId

    const getFileHeaderComment = (languageId: string): string => {
      // Use HTML-style comments for markup-centric languages and SFCs
      if (
        languageId === 'html' ||
        languageId === 'markdown' ||
        languageId === 'mdx' ||
        languageId === 'svelte' ||
        languageId === 'vue'
      ) {
        return '<!-- @stringer-ignore -->\n'
      }
      // Default JS/TS style
      return '// @stringer-ignore\n'
    }

    const header = getFileHeaderComment(langId)
    // If already present, skip
    const text = doc.getText()
    if (text.includes('@stringer-ignore')) return
    await withEdit(editor, (edit) => {
      edit.insert(new vscode.Position(0, 0), header)
    })
  })
  context.subscriptions.push(ignoreFileCmd)

  // Status Bar Button
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBarItem.text = '$(globe) Stringer'
  statusBarItem.tooltip = 'Open Stringer menu'
  statusBarItem.command = 'stringer.showMenu'
  statusBarItem.show()
  context.subscriptions.push(statusBarItem)

  // Menu command
  const showMenu = vscode.commands.registerCommand('stringer.showMenu', async () => {
    const items: Array<vscode.QuickPickItem & { id: string }> = [
      {
        id: 'align',
        label: vscode.l10n.t('Align Translations'),
        description: vscode.l10n.t('Add any missing translations for target languages based on your base language JSON file')
      },
      {
        id: 'convert',
        label: vscode.l10n.t('Convert Strings to i18n Keys'),
        description: vscode.l10n.t('Run \"stringer convert\" in the integrated terminal for this project')
      },
      {
        id: 'select_locales',
        label: vscode.l10n.t('Select Locales folder'),
        description: vscode.l10n.t('Pick the folder that contains your locale *.json files')
      },
      { id: 'change_lang', label: vscode.l10n.t('Change Preview Language'), description: vscode.l10n.t('Switch inline preview locale') },
      { id: 'change_mode', label: vscode.l10n.t('Change Preview Mode'), description: vscode.l10n.t('Switch inline preview content') },
      { id: 'change_color', label: vscode.l10n.t('Change Preview Color'), description: vscode.l10n.t('Set the background color of inline previews (HSL, RGB, or color name)') },
      { id: 'open_website', label: vscode.l10n.t('Open Website'), description: 'stringer-cli.com' },
      { id: 'open_docs', label: vscode.l10n.t('Open Docs'), description: 'docs.stringer-cli.com' },
      { id: 'open_billing', label: vscode.l10n.t('Open Billing'), description: 'stringer-cli.com/billing' }
    ]
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Stringer',
      placeHolder: vscode.l10n.t('Select an action')
    })

    if (!pick) return

    if (pick.id === 'change_color') {
      const cfg = vscode.workspace.getConfiguration('stringerHelper')
      const current = cfg.get<string>('previewBackgroundColor') || 'hsl(270, 55%, 43%)'
      const val = await vscode.window.showInputBox({
        title: 'Stringer: Change Preview Color',
        placeHolder: '#aabbcc or any CSS color',
        value: String(current)
      })
      if (val) {
        await cfg.update('previewBackgroundColor', val, vscode.ConfigurationTarget.Global)
        refreshActiveEditorDecorations()
      }
      return
    }

    if (pick.id === 'align') {
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

    if (pick.id === 'convert') {
      const workspaceFolders = vscode.workspace.workspaceFolders
      const folder = vscode.window.activeTextEditor
        ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
        : (workspaceFolders && workspaceFolders[0])
      if (!folder) {
        vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'))
        return
      }
      await runConvertInTerminal(folder.uri.fsPath)
      return
    }

    if (pick.id === 'select_locales') {
      await vscode.commands.executeCommand('stringer.changeLocalesFolder')
      return
    }

    if (pick.id === 'change_lang') {
      await choosePreviewLanguage()
      return
    }
    if (pick.id === 'change_mode') {
      await vscode.commands.executeCommand('stringer.changePreviewMode')
      return
    }

    if (pick.id === 'open_website') {
      vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com'))
      return
    }
    if (pick.id === 'open_docs') {
      vscode.env.openExternal(vscode.Uri.parse('https://docs.stringer-cli.com'))
      return
    }
    if (pick.id === 'open_billing') {
      vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com/billing'))
      return
    }
  })
  context.subscriptions.push(disposable, showMenu)
}

export function deactivate() {}
