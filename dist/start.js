"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os_1 = __importDefault(require("os"));
let isProcessingCommand = false;
let activePreviewLanguage = null;
let projectContext = null;
let localeCache = {};
let localeWatcher = null;
let cliConfigWatcher = null;
const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 0.25em',
        color: new vscode.ThemeColor('editorCodeLens.foreground')
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
});
const hiddenTextDecorationType = vscode.window.createTextEditorDecorationType({
    // Hide original text when rendering locale-only mode but preserve layout width.
    // Use aggressive CSS so it works in all contexts (objects/JSX/Vue templates).
    // VS Code allows injecting extra CSS declarations via textDecoration.
    textDecoration: 'none; opacity: 0 !important; font-size: 0 !important; letter-spacing: -0.5em !important;'
});
// Separate decoration type for rendering values with 'before' so it is not affected by hidden style
const valueBeforeDecorationType = vscode.window.createTextEditorDecorationType({
    before: {
        // Ensure the rendered value participates in layout and is readable on dark/light themes
        color: new vscode.ThemeColor('editor.foreground'),
        margin: '0 0 0 0',
    }
});
// Utilities to mirror CLI behavior
function lastPathSegment(expr) {
    const parts = String(expr).split('.');
    return parts[parts.length - 1];
}
function normalizeDynamicPlaceholders(value) {
    let out = value;
    // Convert {{name}} to {name}
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, v) => `{${lastPathSegment(v)}}`);
    // Convert ${name} to {name}
    out = out.replace(/\$\{\s*([\w.]+)\s*\}/g, (_m, v) => `{${lastPathSegment(v)}}`);
    return out;
}
function stripHtmlTagsPreserveText(value) {
    // Remove tags but keep inner text. Best-effort, non-greedy for tags
    return value.replace(/<[^>]*>/g, ' ');
}
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}
function normalizeSelectedTextForI18n(value) {
    let v = value;
    v = normalizeDynamicPlaceholders(v);
    v = stripHtmlTagsPreserveText(v);
    v = normalizeWhitespace(v);
    return v;
}
// Truncate preview content safely by Unicode code points (avoid breaking surrogate pairs)
function truncateForPreview(value, maxLength = 300) {
    const codepoints = Array.from(String(value));
    if (codepoints.length <= maxLength)
        return value;
    return codepoints.slice(0, maxLength).join('') + '…';
}
// Extract placeholder parameter names from a normalized i18n string, e.g. "Hello {name} ({count})" -> ['name','count']
function extractParamsFromNormalizedText(value) {
    const params = new Set();
    const rx = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
    for (let m = rx.exec(value); m; m = rx.exec(value)) {
        params.add(m[1]);
    }
    return Array.from(params);
}
function isWsl() {
    try {
        if (process.platform !== 'linux')
            return false;
        const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf-8');
        return /microsoft/i.test(release);
    }
    catch {
        return false;
    }
}
function findCliConfigPath() {
    const candidates = [];
    // 1) Primary: same location as CLI uses
    const home = os_1.default.homedir();
    candidates.push(path.join(home, '.stringer-cli.json'));
    // 2) Windows explicit USERPROFILE (sometimes differs from homedir in edge setups)
    if (process.platform === 'win32') {
        const userProfile = process.env.USERPROFILE;
        if (userProfile && userProfile !== home) {
            candidates.push(path.join(userProfile, '.stringer-cli.json'));
        }
        // Common OneDrive profile redirect (rarely needed, harmless to check)
        const oneDrive = process.env.OneDrive || process.env.ONEDRIVE;
        if (oneDrive)
            candidates.push(path.join(oneDrive, '..', '.stringer-cli.json'));
    }
    // 3) WSL: look for Windows home mirror under /mnt/c/Users/*
    if (isWsl()) {
        const base = '/mnt/c/Users';
        try {
            const users = fs.readdirSync(base);
            for (const u of users) {
                candidates.push(path.join(base, u, '.stringer-cli.json'));
            }
        }
        catch { }
    }
    // 4) Optional override via setting (user can provide an absolute path)
    try {
        const cfg = vscode.workspace.getConfiguration('stringerHelper');
        const override = cfg.get('cliConfigPath');
        if (override && path.isAbsolute(override))
            candidates.unshift(override);
    }
    catch { }
    for (const p of candidates) {
        try {
            if (p && fs.existsSync(p))
                return p;
        }
        catch { }
    }
    return null;
}
function readAllCliConfigs() {
    const configPath = findCliConfigPath();
    try {
        if (!configPath)
            return null;
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [parsed];
    }
    catch (_e) {
        return null;
    }
}
function getProjectName(projectRoot) {
    try {
        const pkgPath = path.join(projectRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return pkg.name || projectRoot;
        }
    }
    catch (_e) { }
    return projectRoot;
}
function normalizePath(p) {
    if (!p)
        return null;
    try {
        return path.resolve(p).replace(/\\/g, '/');
    }
    catch {
        return p;
    }
}
// Accept locale filenames like en.json, en-US.json, pt_BR.json, zh-Hant.json
function isLocaleFileName(fileName) {
    if (!/\.json$/i.test(fileName))
        return false;
    const name = fileName.replace(/\.json$/i, '');
    // Start with 2-3 letters, optional region/script separated by '-' or '_',
    // and allow one extra segment for variants. Excludes names like 'package'.
    return /^[a-z]{2,3}([_-][a-zA-Z]{2,4})?([_-][A-Za-z0-9]+)?$/.test(name);
}
async function loadCliProjectConfig(projectRoot) {
    const all = readAllCliConfigs();
    if (!all)
        return null;
    const projectName = getProjectName(projectRoot);
    let match = all.find((c) => c.projectName === projectName);
    if (match)
        return match;
    // Fallback: match by projectPath
    const rootNorm = normalizePath(projectRoot);
    match = all.find((c) => normalizePath(c.projectPath) === rootNorm);
    if (match)
        return match;
    // Fallback 2: match configs whose projectPath contains the current root (handles nested workspaces)
    match = all.find((c) => {
        const cp = normalizePath(c.projectPath);
        return !!cp && !!rootNorm && (rootNorm.startsWith(cp) || cp.startsWith(rootNorm));
    });
    return match || null;
}
function generateKeyPath(filePath, basePath) {
    const relativePath = path.relative(basePath, filePath);
    if (!relativePath.includes(path.sep))
        return null;
    return relativePath
        .replace(/\\/g, '/')
        .replace(/\.[^/.]+$/, '')
        .split('/')
        .join('.');
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
// ---- Global unique 4-digit key generation ----
function collectAllNumericLeafKeys(obj, used = new Set()) {
    for (const [k, v] of Object.entries(obj)) {
        if (/^\d{4}$/.test(k) && typeof v !== 'object') {
            used.add(k);
        }
        if (v && typeof v === 'object') {
            collectAllNumericLeafKeys(v, used);
        }
    }
    return used;
}
function nextGlobalLeafKey(used) {
    // Prefer random selection for better distribution
    for (let tries = 0; tries < 500; tries++) {
        const k = Math.floor(Math.random() * 10000)
            .toString()
            .padStart(4, '0');
        if (!used.has(k))
            return k;
    }
    // Fallback: deterministic scan if too many collisions
    for (let i = 0; i < 10000; i++) {
        const k = i.toString().padStart(4, '0');
        if (!used.has(k))
            return k;
    }
    // Extremely unlikely: generate until unique
    let k = (Math.floor(Math.random() * 10000)).toString().padStart(4, '0');
    while (used.has(k)) {
        k = (Math.floor(Math.random() * 10000)).toString().padStart(4, '0');
    }
    return k;
}
function addStringToBaseLanguage(baseLangJson, keyPathPrefix, text) {
    const parts = keyPathPrefix.split('.').filter(Boolean);
    const used = collectAllNumericLeafKeys(baseLangJson);
    // Ensure intermediate containers are objects and lift strings when needed
    let container = baseLangJson;
    for (const part of parts) {
        if (typeof container[part] === 'string') {
            const prev = container[part];
            container[part] = {};
            const prevKey = nextGlobalLeafKey(used);
            used.add(prevKey);
            container[part][prevKey] = prev;
        }
        else if (container[part] === undefined) {
            container[part] = {};
        }
        container = container[part];
    }
    const leafKey = nextGlobalLeafKey(used);
    // Merge rather than overwrite whole file
    setDeepValue(baseLangJson, parts, leafKey, text);
    return { updated: baseLangJson, fullKeyPath: `${keyPathPrefix}.${leafKey}` };
}
function setDeepValue(obj, pathParts, leafKey, value) {
    let node = obj;
    for (let i = 0; i < pathParts.length; i++) {
        const part = pathParts[i];
        const isLast = i === pathParts.length - 1;
        if (!isLast) {
            if (node[part] === undefined)
                node[part] = {};
            else if (typeof node[part] === 'string')
                node[part] = { '0000': node[part] };
            node = node[part];
        }
        else {
            if (node[part] === undefined)
                node[part] = {};
            else if (typeof node[part] === 'string')
                node[part] = { '0000': node[part] };
            node[part][leafKey] = value;
        }
    }
}
async function withEdit(editor, replacer) {
    await editor.edit((edit) => replacer(edit), { undoStopAfter: true, undoStopBefore: true });
}
async function runAlignInTerminal(cwd) {
    const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Stringer Align'), cwd });
    terminal.show();
    terminal.sendText('stringer align', true);
}
// Run stringer convert in integrated terminal
async function runConvertInTerminal(cwd) {
    const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Stringer Convert'), cwd });
    terminal.show();
    terminal.sendText('stringer convert', true);
}
// ---------- Simple Vue SFC context detection ----------
function isVueFile(filePath) {
    return /\.vue$/i.test(filePath);
}
function getTemplateRange(source) {
    const open = source.match(/<template(?:\s[^>]*)?>/i);
    if (!open || typeof open.index !== 'number')
        return null;
    const start = open.index + open[0].length;
    const closeIdx = source.indexOf('</template>', start);
    if (closeIdx === -1)
        return null;
    return { start, end: closeIdx };
}
// Return all <script> block ranges inside a Vue SFC
function getScriptRanges(source) {
    const ranges = [];
    const rx = /<script(?:\s[^>]*)?>/gi;
    for (let m = rx.exec(source); m; m = rx.exec(source)) {
        const openIdx = m.index + m[0].length;
        const closeIdx = source.indexOf('</script>', openIdx);
        if (closeIdx !== -1) {
            ranges.push({ start: openIdx, end: closeIdx });
        }
    }
    return ranges;
}
function isInsideVueScript(source, offset) {
    const ranges = getScriptRanges(source);
    for (const r of ranges) {
        if (offset >= r.start && offset <= r.end)
            return true;
    }
    return false;
}
function isInsideOpeningOrClosingTag(source, offset) {
    const lastLt = source.lastIndexOf('<', offset);
    const lastGt = source.lastIndexOf('>', offset);
    return lastLt > lastGt;
}
function isVueTemplateTextNode(source, offset) {
    const tpl = getTemplateRange(source);
    if (!tpl)
        return false;
    if (offset < tpl.start || offset > tpl.end)
        return false;
    if (isInsideOpeningOrClosingTag(source, offset))
        return false;
    return true;
}
function getAttributeContext(source, offset) {
    const tpl = getTemplateRange(source);
    if (!tpl)
        return null;
    if (offset < tpl.start || offset > tpl.end)
        return null;
    if (!isInsideOpeningOrClosingTag(source, offset))
        return null;
    const tagStart = source.lastIndexOf('<', offset);
    const tagEnd = source.indexOf('>', tagStart + 1);
    if (tagStart === -1 || tagEnd === -1 || tagEnd < offset)
        return null;
    const slice = source.slice(tagStart + 1, tagEnd);
    const rel = offset - (tagStart + 1);
    const eqRel = slice.lastIndexOf('=', rel);
    if (eqRel === -1)
        return null;
    const eqAbs = tagStart + 1 + eqRel;
    let qIdx = eqAbs + 1;
    while (qIdx < tagEnd && /\s/.test(source[qIdx]))
        qIdx++;
    const quote = source[qIdx];
    if (quote !== '"' && quote !== "'")
        return null;
    const valueStart = qIdx + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd === -1 || offset < valueStart || offset > valueEnd)
        return null;
    let nEnd = eqAbs - 1;
    while (nEnd > tagStart && /\s/.test(source[nEnd]))
        nEnd--;
    let nStart = nEnd;
    while (nStart > tagStart && /[A-Za-z0-9_:\-]/.test(source[nStart - 1]))
        nStart--;
    let rawName = source.slice(nStart, nEnd + 1);
    const isBound = rawName.startsWith(':') || rawName.startsWith('v-bind:');
    const name = rawName.replace(/^:/, '').replace(/^v-bind:/, '');
    return {
        name,
        isBound,
        attrStart: nStart,
        valueStart,
        valueEnd
    };
}
// ---------- Simple React/Next JSX helpers ----------
function isJsxFile(filePath) {
    return /\.(jsx|tsx)$/i.test(filePath);
}
function isLikelyJsxUiContext(source, offset) {
    // Heuristic: inside a JSX element's content or attribute
    const lastLt = source.lastIndexOf('<', offset);
    const lastGt = source.lastIndexOf('>', offset);
    const nextLt = source.indexOf('<', offset);
    const nextGt = source.indexOf('>', offset);
    if (lastLt === -1 || (nextGt === -1 && nextLt === -1))
        return false;
    // Inside opening tag attributes
    if (lastLt > lastGt)
        return true;
    // Between tags = text content
    if (lastGt > lastLt && nextLt !== -1 && lastGt <= offset && offset <= nextLt)
        return true;
    return false;
}
function getJsxAttributeContext(source, offset) {
    const tagStart = source.lastIndexOf('<', offset);
    const tagEnd = source.indexOf('>', tagStart + 1);
    if (tagStart === -1 || tagEnd === -1 || tagEnd < offset)
        return null;
    const slice = source.slice(tagStart + 1, tagEnd);
    const rel = offset - (tagStart + 1);
    const eqRel = slice.lastIndexOf('=', rel);
    if (eqRel === -1)
        return null;
    const eqAbs = tagStart + 1 + eqRel;
    // Find attribute name
    let nEnd = eqAbs - 1;
    while (nEnd > tagStart && /\s/.test(source[nEnd]))
        nEnd--;
    let nStart = nEnd;
    while (nStart > tagStart && /[A-Za-z0-9_:\-]/.test(source[nStart - 1]))
        nStart--;
    const rawName = source.slice(nStart, nEnd + 1);
    // Find quoted value following '='
    let qIdx = eqAbs + 1;
    while (qIdx < tagEnd && /\s/.test(source[qIdx]))
        qIdx++;
    const quote = source[qIdx];
    if (quote !== '"' && quote !== "'")
        return null;
    const valueStartQuote = qIdx;
    const valueEndQuote = source.indexOf(quote, valueStartQuote + 1);
    if (valueEndQuote === -1 || offset < valueStartQuote || offset > valueEndQuote)
        return null;
    return { name: rawName, nameStart: nStart, valueStartQuote, valueEndQuote };
}
// ---------- Ensure Vue t() availability ----------
function hasUseI18nTDeclaration(block) {
    return /const\s*\{\s*t\s*\}\s*=\s*useI18n\s*\(\s*\)/.test(block);
}
async function ensureVueTDeclaration(editor) {
    const doc = editor.document;
    const filePath = doc.uri.fsPath;
    if (!isVueFile(filePath))
        return;
    const text = doc.getText();
    if (hasUseI18nTDeclaration(text))
        return;
    // Find existing script block
    const scriptOpen = text.match(/<script(?:\s[^>]*)?>/i);
    if (scriptOpen && typeof scriptOpen.index === 'number') {
        const openIdx = scriptOpen.index;
        const insertPos = openIdx + scriptOpen[0].length;
        const closeIdx = text.indexOf('</script>', insertPos);
        const scriptBlock = closeIdx !== -1 ? text.slice(insertPos, closeIdx) : '';
        if (hasUseI18nTDeclaration(scriptBlock))
            return;
        const updated = text.slice(0, insertPos) + '\nconst { t } = useI18n()\n' + text.slice(insertPos);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
        await withEdit(editor, (edit) => edit.replace(fullRange, updated));
        return;
    }
    // No script block -> create one before <template>
    const tplIdx = text.search(/<template(?:\s[^>]*)?>/i);
    const scriptTag = '<script setup lang="ts">\nconst { t } = useI18n()\n</script>\n\n';
    let updated;
    if (tplIdx !== -1) {
        updated = text.slice(0, tplIdx) + scriptTag + text.slice(tplIdx);
    }
    else {
        updated = scriptTag + text;
    }
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
    await withEdit(editor, (edit) => edit.replace(fullRange, updated));
}
// ---------- Ensure React/Next t() availability ----------
function ensureImported(text, importLine) {
    if (new RegExp('^\\s*' + importLine.replace(/[.*+?^${}()|\\[\\]\\\\]/g, '\\$&'), 'm').test(text)) {
        return { updated: text, changed: false };
    }
    // Insert after last import (or at top)
    const rx = /^\s*import\b.*$/gm;
    let lastMatch = null;
    for (let m = rx.exec(text); m; m = rx.exec(text))
        lastMatch = m;
    if (lastMatch) {
        const idx = (lastMatch.index || 0) + lastMatch[0].length;
        return { updated: text.slice(0, idx) + '\n' + importLine + text.slice(idx), changed: true };
    }
    return { updated: importLine + '\n' + text, changed: true };
}
async function ensureReactTDeclaration(editor, selectionOffset) {
    const cfg = vscode.workspace.getConfiguration('stringerHelper');
    const style = cfg.get('reactInjection', 'react-i18next');
    if (style !== 'react-i18next')
        return;
    const doc = editor.document;
    const text = doc.getText();
    // 1) Ensure import
    const { updated: withImport, changed } = ensureImported(text, "import { useTranslation } from 'react-i18next'");
    let working = withImport;
    // 2) Ensure const { t } = useTranslation() inside nearest function before selection
    const fnIdx = (() => {
        // Find nearest "function" or "=>" block start before selection
        const before = working.slice(0, selectionOffset);
        const lastFunc = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=>'));
        if (lastFunc === -1)
            return -1;
        const brace = working.indexOf('{', lastFunc);
        return brace !== -1 ? brace + 1 : -1;
    })();
    if (fnIdx !== -1) {
        // Check if already declared in function block following fnIdx (first 300 chars)
        const lookahead = working.slice(fnIdx, fnIdx + 300);
        if (!/\bconst\s*\{\s*t\s*\}\s*=\s*useTranslation\s*\(\s*\)/.test(lookahead)) {
            working = working.slice(0, fnIdx) + "\nconst { t } = useTranslation()\n" + working.slice(fnIdx);
        }
    }
    if (changed || working !== text) {
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
        await withEdit(editor, (edit) => edit.replace(fullRange, working));
    }
}
async function ensureNextTDeclaration(editor, selectionOffset) {
    const cfg = vscode.workspace.getConfiguration('stringerHelper');
    const style = cfg.get('nextInjection', 'next-intl');
    if (style !== 'next-intl')
        return;
    const doc = editor.document;
    const text = doc.getText();
    // 1) Ensure import
    const { updated: withImport, changed } = ensureImported(text, "import { useTranslations } from 'next-intl'");
    let working = withImport;
    // 2) Ensure const t = useTranslations() inside nearest function before selection
    const fnIdx = (() => {
        const before = working.slice(0, selectionOffset);
        const lastFunc = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=>'));
        if (lastFunc === -1)
            return -1;
        const brace = working.indexOf('{', lastFunc);
        return brace !== -1 ? brace + 1 : -1;
    })();
    if (fnIdx !== -1) {
        const lookahead = working.slice(fnIdx, fnIdx + 300);
        if (!/\bconst\s*t\s*=\s*useTranslations\s*\(\s*\)/.test(lookahead)) {
            working = working.slice(0, fnIdx) + "\nconst t = useTranslations()\n" + working.slice(fnIdx);
        }
    }
    if (changed || working !== text) {
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(text.length));
        await withEdit(editor, (edit) => edit.replace(fullRange, working));
    }
}
function isEscaped(source, index) {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && source[i] === '\\'; i--)
        backslashes++;
    return backslashes % 2 === 1;
}
function findEnclosingStringLiteralBounds(source, offset) {
    // Search backward for an opening quote that is not escaped
    let qStart = -1;
    let quote = null;
    for (let i = offset; i >= 0; i--) {
        const ch = source[i];
        if ((ch === '"' || ch === "'" || ch === '`') && !isEscaped(source, i)) {
            qStart = i;
            quote = ch;
            break;
        }
        // Stop if we hit a newline and haven't found a quote (heuristic)
        if (ch === '\n')
            break;
    }
    if (qStart < 0 || !quote)
        return null;
    // Ensure offset is after the opening quote (inside the literal)
    if (offset <= qStart)
        return null;
    // Search forward for the closing quote of the same type
    for (let j = qStart + 1; j < source.length; j++) {
        const ch = source[j];
        if (ch === quote && !isEscaped(source, j)) {
            return { quote, qStart, qEnd: j };
        }
        // For template literals, skip simple ${ ... } blocks (best-effort)
        if (quote === '`' && ch === '$' && source[j + 1] === '{') {
            // Jump to matching '}'
            let depth = 1;
            j += 2;
            while (j < source.length && depth > 0) {
                if (source[j] === '{')
                    depth++;
                else if (source[j] === '}')
                    depth--;
                // Handle string-like chars inside expression naively by skipping escapes
                if (source[j] === '\\')
                    j++;
                j++;
            }
            j--;
        }
    }
    return null;
}
async function activate(context) {
    async function ensureProjectContext(editor) {
        const ed = editor ?? vscode.window.activeTextEditor;
        if (!ed)
            return false;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri) || (workspaceFolders && workspaceFolders[0]);
        if (!folder)
            return false;
        const projectRoot = folder.uri.fsPath;
        const config = await loadCliProjectConfig(projectRoot);
        // Always rely on a user-selected locales folder (persisted per workspace)
        let localesDir = null;
        let baseLanguage = config?.baseLanguage || 'en';
        const stateKey = `stringer.localesDir.${projectRoot}`;
        try {
            const saved = context.workspaceState.get(stateKey);
            if (typeof saved === 'string' && saved && fs.existsSync(saved))
                localesDir = saved;
        }
        catch { }
        if (!localesDir) {
            // Optional convenience: propose a default folder if it exists
            let defaultUri = folder.uri;
            try {
                const candidate = path.resolve(projectRoot, config?.outputDir || path.join('i18n', 'locales'));
                if (fs.existsSync(candidate))
                    defaultUri = vscode.Uri.file(candidate);
            }
            catch { }
            const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Select your i18n locales folder. You can select it later in the 🌐Stringer menu at the bottom right corner of your IDE'), 'Select Folder', 'Later');
            if (choice !== 'Select Folder')
                return false;
            const pick = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: vscode.l10n.t('Select your locales folder (contains *.json locale files)'),
                defaultUri
            });
            if (!pick || pick.length === 0)
                return false;
            localesDir = pick[0].fsPath;
            try {
                await context.workspaceState.update(stateKey, localesDir);
            }
            catch { }
        }
        // Infer base language from files if possible
        try {
            const files = fs.readdirSync(localesDir).filter((f) => isLocaleFileName(f));
            if (files.includes('en.json'))
                baseLanguage = 'en';
            else if (files.length > 0)
                baseLanguage = files[0].replace(/\.json$/, '');
        }
        catch { }
        projectContext = { projectRoot, localesDir: localesDir, baseLanguage };
        // Initialize preview language from settings or base language
        const extConfig = vscode.workspace.getConfiguration('stringerHelper');
        const preferred = extConfig.get('defaultPreviewLanguage');
        // Derive available languages from actual filenames in localesDir
        let available = [];
        try {
            available = fs
                .readdirSync(localesDir)
                .filter((f) => isLocaleFileName(f))
                .map((f) => f.replace(/\.json$/, ''));
        }
        catch { }
        // Choose active language strictly from available filenames
        if (preferred && available.includes(preferred))
            activePreviewLanguage = preferred;
        else if (available.includes(baseLanguage))
            activePreviewLanguage = baseLanguage;
        else
            activePreviewLanguage = available[0] || baseLanguage;
        // Setup locale watcher
        if (localeWatcher) {
            localeWatcher.dispose();
            localeWatcher = null;
        }
        try {
            const pattern = new vscode.RelativePattern(localesDir, '*.json');
            localeWatcher = vscode.workspace.createFileSystemWatcher(pattern);
            const reload = async () => {
                localeCache = {};
                await preloadLocales();
                refreshActiveEditorDecorations();
            };
            localeWatcher.onDidChange(reload);
            localeWatcher.onDidCreate(reload);
            localeWatcher.onDidDelete(reload);
            context.subscriptions.push(localeWatcher);
        }
        catch { }
        await preloadLocales();
        return true;
    }
    async function promptOpenWorkspaceFolder() {
        const pick = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: vscode.l10n.t('Open a folder to use Stringer Helper')
        });
        if (pick && pick[0]) {
            await vscode.commands.executeCommand('vscode.openFolder', pick[0], false);
        }
    }
    function getValueByPath(obj, keyPath) {
        if (!obj)
            return undefined;
        const parts = keyPath.split('.').filter(Boolean);
        let node = obj;
        for (const part of parts) {
            if (node && typeof node === 'object' && part in node)
                node = node[part];
            else
                return undefined;
        }
        return typeof node === 'string' ? node : undefined;
    }
    // Support numeric-leaf patterns where the key may be the leaf id (e.g., 4-digit code)
    function getValueByPathLoose(obj, keyPath) {
        if (!obj)
            return undefined;
        const parts = keyPath.split('.').filter(Boolean);
        let node = obj;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (node && typeof node === 'object' && part in node) {
                node = node[part];
                continue;
            }
            // If this is the last part and the parent is an object with a single 4-digit key, return that
            const isLast = i === parts.length - 1;
            if (isLast && node && typeof node === 'object') {
                const leafKeys = Object.keys(node);
                const four = leafKeys.find((k) => /^\d{4}$/.test(k) && typeof node[k] === 'string');
                if (four)
                    return node[four];
            }
            return undefined;
        }
        return typeof node === 'string' ? node : undefined;
    }
    async function loadLocale(lang) {
        if (!projectContext)
            return null;
        if (localeCache[lang])
            return localeCache[lang];
        const tryPaths = (() => {
            const variants = new Set();
            const L = (lang || '').trim();
            const low = L.toLowerCase();
            const dash = low.replace(/_/g, '-');
            variants.add(L);
            variants.add(low);
            variants.add(dash);
            if (dash.includes('-'))
                variants.add(dash.split('-')[0]);
            return Array.from(variants).map((v) => path.join(projectContext.localesDir, `${v}.json`));
        })();
        try {
            for (const fp of tryPaths) {
                try {
                    const txt = await fs.promises.readFile(fp, 'utf-8');
                    const json = JSON.parse(txt);
                    localeCache[lang] = json;
                    return json;
                }
                catch { }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    async function preloadLocales() {
        if (!projectContext)
            return;
        await loadLocale(projectContext.baseLanguage);
        if (activePreviewLanguage && activePreviewLanguage !== projectContext.baseLanguage) {
            await loadLocale(activePreviewLanguage);
        }
    }
    function getTranslation(keyPath) {
        if (!projectContext)
            return null;
        const lang = activePreviewLanguage || projectContext.baseLanguage;
        // Try direct match
        const primary = getValueByPath(localeCache[lang], keyPath);
        if (primary)
            return primary;
        // Try loose match (handles numeric leaf keys)
        const loose = getValueByPathLoose(localeCache[lang], keyPath);
        if (loose)
            return loose;
        // Fallback to base language
        const fallbackBase = getValueByPath(localeCache[projectContext.baseLanguage], keyPath);
        if (fallbackBase)
            return fallbackBase;
        const fallbackLoose = getValueByPathLoose(localeCache[projectContext.baseLanguage], keyPath);
        if (fallbackLoose)
            return fallbackLoose;
        // Last-resort: try any loaded locale (helps if baseLanguage file is missing)
        for (const k of Object.keys(localeCache)) {
            const v = getValueByPath(localeCache[k], keyPath) || getValueByPathLoose(localeCache[k], keyPath);
            if (typeof v === 'string')
                return v;
        }
        return null;
    }
    function findTTupleRanges(doc) {
        const text = doc.getText();
        const results = [];
        // Best-effort regex for t('...') calls; support optional second arg like t('key', {...})
        const rx = /\bt\(\s*(['"`])([^'"`]+?)\1(?:\s*,[^)]*)?\s*\)/g;
        for (let m = rx.exec(text); m; m = rx.exec(text)) {
            const key = m[2];
            const start = m.index;
            const end = m.index + m[0].length;
            const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
            results.push({ range, key });
        }
        return results;
    }
    // Detect <i18n-t keypath="..."> usages inside Vue templates
    function findI18nKeypathRanges(doc) {
        const text = doc.getText();
        const results = [];
        const rx = /<i18n-t[^>]*\bkeypath\s*=\s*(['"])([^'"\n]+?)\1/gi;
        for (let m = rx.exec(text); m; m = rx.exec(text)) {
            const key = m[2];
            const full = m[0];
            const rel = full.indexOf(key);
            const start = m.index + (rel >= 0 ? rel : 0);
            const end = start + key.length;
            const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
            results.push({ range, key, isAttribute: true });
        }
        return results;
    }
    function getTTupleAtPosition(doc, position) {
        const ranges = findTTupleRanges(doc);
        for (const r of ranges) {
            if (r.range.contains(position))
                return r;
        }
        return null;
    }
    // Fallback: find first t('...') or <i18n-t keypath="..."> occurring on the given line
    function getTTupleOnLine(doc, line) {
        const tuples = findTTupleRanges(doc);
        for (const t of tuples) {
            if (t.range.start.line <= line && line <= t.range.end.line)
                return t;
        }
        const attrs = findI18nKeypathRanges(doc);
        for (const a of attrs) {
            if (a.range.start.line <= line && line <= a.range.end.line)
                return { range: a.range, key: a.key };
        }
        return null;
    }
    function escapeHtmlAttr(value) {
        return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }
    function escapeJsString(value, quote = '"') {
        const q = quote === '"' ? '"' : "'";
        return value
            .replace(/\\/g, '\\\\')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), `\\${q}`);
    }
    function findEnclosingMustache(source, offset) {
        const openIdx = source.lastIndexOf('{{', offset);
        if (openIdx === -1)
            return null;
        const closeIdx = source.indexOf('}}', openIdx + 2);
        if (closeIdx === -1)
            return null;
        if (offset < openIdx || offset > closeIdx)
            return null;
        return { start: openIdx, end: closeIdx + 2 };
    }
    function decorateEditor(editor) {
        const cfg = vscode.workspace.getConfiguration('stringerHelper');
        const enable = cfg.get('enableInlinePreview', true);
        const keyMode = (cfg.get('inlinePreviewKeyMode') || 'hidden');
        const hoverShowsKey = cfg.get('hoverShowsKey', true);
        const previewBg = (cfg.get('previewBackgroundColor') || 'hsl(270, 55%, 43%)');
        if (!enable) {
            // Ensure all decoration layers are cleared when preview is disabled
            editor.setDecorations(decorationType, []);
            editor.setDecorations(hiddenTextDecorationType, []);
            editor.setDecorations(valueBeforeDecorationType, []);
            return;
        }
        const found = [
            ...findTTupleRanges(editor.document),
            ...findI18nKeypathRanges(editor.document)
        ];
        const decorations = [];
        const hiddenRanges = [];
        const hiddenModeValueDecorations = [];
        const docText = editor.document.getText();
        const filePath = editor.document.uri.fsPath;
        const isVue = isVueFile(filePath);
        const isJsx = isJsxFile(filePath);
        for (const item of found) {
            const value = getTranslation(item.key);
            const textToShow = value ?? '';
            const startOffset = editor.document.offsetAt(item.range.start);
            const inVueTemplate = isVue && isVueTemplateTextNode(docText, startOffset);
            const inJsxUi = isJsx && isLikelyJsxUiContext(docText, startOffset);
            const inVueAttr = isVue && !!getAttributeContext(docText, startOffset);
            const inJsxAttr = isJsx && !!getJsxAttributeContext(docText, startOffset);
            const inVueScript = isVue && isInsideVueScript(docText, startOffset);
            // Generic script contexts: non-Vue non-JSX files, or JSX outside UI/attr
            const inGenericScript = (!isVue && !isJsx) || (isJsx && !inJsxUi && !inJsxAttr);
            // Missing is determined against the ACTIVE locale file only (no fallback),
            // so removing a key from the active file turns it red immediately.
            const lang = (activePreviewLanguage || projectContext?.baseLanguage);
            const activeDirect = projectContext ? getValueByPath(localeCache[lang], item.key) : undefined;
            const isMissing = !activeDirect && (inVueTemplate || inJsxUi || inVueAttr || inJsxAttr || inVueScript || inGenericScript);
            // If there is no value to show (and not a missing-key case) and we're not in hidden mode, skip rendering
            if (!textToShow && !isMissing && keyMode !== 'hidden')
                continue;
            // In hidden mode we want to show only the locale value and hide the original code everywhere
            const hover = new vscode.MarkdownString();
            if (hoverShowsKey)
                hover.appendMarkdown(vscode.l10n.t('Key: {0}', `\`${item.key}\``));
            hover.appendMarkdown('\n\n');
            hover.appendMarkdown(vscode.l10n.t('Value ({0}): {1}', activePreviewLanguage ?? '', String(value ?? '')));
            const leaf = item.key.split('.').pop() || item.key;
            // Key+locale mode should not duplicate the key (code already shows it)
            // Leaf mode shows a compact key prefix; Hidden mode shows only value and hides the code
            const keyLabel = keyMode === 'leaf' ? `[${leaf}] ` : '';
            // Expand preview/hidden range to include surrounding template/JSX braces when applicable
            let previewRange = item.range;
            if (inVueTemplate) {
                const must = findEnclosingMustache(docText, startOffset);
                if (must) {
                    previewRange = new vscode.Range(editor.document.positionAt(must.start), editor.document.positionAt(must.end));
                }
            }
            else if (!isVue && isJsx && inJsxUi) {
                let left = editor.document.offsetAt(item.range.start) - 1;
                while (left >= 0 && /\s/.test(docText[left]))
                    left--;
                let right = editor.document.offsetAt(item.range.end);
                while (right < docText.length && /\s/.test(docText[right]))
                    right++;
                if (docText[left] === '{' && docText[right] === '}') {
                    previewRange = new vscode.Range(editor.document.positionAt(left), editor.document.positionAt(right + 1));
                }
            }
            if (keyMode === 'hidden') {
                // 1) Hide the original text entirely (collapsed width)
                hiddenRanges.push({ range: previewRange });
                // 2) Render the value via a separate decoration so opacity does not affect it
                hiddenModeValueDecorations.push({
                    range: previewRange,
                    // Avoid duplicate hover (decoration + provider); provider will handle it
                    renderOptions: {
                        // Use `before` to ensure visibility even when the original range is fully hidden
                        before: {
                            contentText: `${truncateForPreview(isMissing ? vscode.l10n.t('Locale Key Missing!!') : textToShow)}`,
                            backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg),
                            color: '#ffffff',
                            margin: '0 0 0 0.15em',
                            border: '1px solid',
                            borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg),
                            textDecoration: 'border-radius: 6px; padding: 0 4px;'
                        }
                    }
                });
            }
            else {
                decorations.push({
                    range: item.range,
                    hoverMessage: hover,
                    renderOptions: {
                        after: {
                            contentText: `${keyLabel}${truncateForPreview(isMissing ? vscode.l10n.t('Locale Key Missing!!') : textToShow)}`,
                            backgroundColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg),
                            color: '#ffffff',
                            margin: '0 0 0 0.15em',
                            border: '1px solid',
                            borderColor: (isMissing ? 'hsl(0, 70%, 50%)' : previewBg),
                            textDecoration: 'border-radius: 6px; padding: 0 4px;'
                        }
                    }
                });
            }
        }
        // Apply decorations per mode
        if (keyMode === 'hidden') {
            editor.setDecorations(valueBeforeDecorationType, hiddenModeValueDecorations);
            editor.setDecorations(hiddenTextDecorationType, hiddenRanges);
            editor.setDecorations(decorationType, []);
        }
        else {
            editor.setDecorations(decorationType, decorations);
            editor.setDecorations(hiddenTextDecorationType, []);
            editor.setDecorations(valueBeforeDecorationType, []);
        }
    }
    function refreshActiveEditorDecorations() {
        const ed = vscode.window.activeTextEditor;
        if (!ed)
            return;
        decorateEditor(ed);
    }
    // Provide hover in any file type
    const hoverProvider = vscode.languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover(document, position) {
            const ranges = findTTupleRanges(document);
            for (const r of ranges) {
                if (r.range.contains(position)) {
                    const value = getTranslation(r.key);
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`Key: \`${r.key}\``);
                    if (value)
                        md.appendMarkdown(`\n\nValue (${activePreviewLanguage}): ${value}`);
                    return new vscode.Hover(md, r.range);
                }
            }
            return undefined;
        }
    });
    context.subscriptions.push(hoverProvider);
    async function getAvailableLocales() {
        if (!projectContext)
            return [];
        try {
            return fs
                .readdirSync(projectContext.localesDir)
                .filter((f) => isLocaleFileName(f))
                .map((f) => f.replace(/\.json$/, ''));
        }
        catch {
            return [];
        }
    }
    async function choosePreviewLanguage() {
        if (!projectContext) {
            const ok = await ensureProjectContext(null);
            if (!ok) {
                await promptOpenWorkspaceFolder();
                return;
            }
        }
        if (!projectContext)
            return;
        const items = await getAvailableLocales();
        if (items.length === 0) {
            vscode.window.showInformationMessage(vscode.l10n.t('No locale files found in {0}', projectContext.localesDir));
            return;
        }
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select preview language',
            title: 'Stringer: Change Preview Language'
        });
        if (!pick)
            return;
        activePreviewLanguage = pick;
        const extConfig = vscode.workspace.getConfiguration('stringerHelper');
        if (!extConfig.get('defaultPreviewLanguage')) {
            await extConfig.update('defaultPreviewLanguage', pick, vscode.ConfigurationTarget.Global);
        }
        await preloadLocales();
        langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`;
        refreshActiveEditorDecorations();
    }
    const langStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    langStatusItem.text = '$(globe) Lang';
    langStatusItem.tooltip = 'Change Stringer preview language';
    langStatusItem.command = 'stringer.changePreviewLanguage';
    context.subscriptions.push(langStatusItem);
    function getPreviewModeLabel() {
        const cfg = vscode.workspace.getConfiguration('stringerHelper');
        const enable = cfg.get('enableInlinePreview', true);
        if (!enable)
            return 'Off';
        const keyMode = (cfg.get('inlinePreviewKeyMode') || 'hidden');
        return keyMode === 'full' ? 'Key+Text' : keyMode === 'leaf' ? 'Leaf+Text' : 'Text';
    }
    const previewStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
    previewStatusItem.tooltip = 'Change Stringer inline preview mode';
    previewStatusItem.command = 'stringer.changePreviewMode';
    context.subscriptions.push(previewStatusItem);
    const changeLangCmd = vscode.commands.registerCommand('stringer.changePreviewLanguage', async () => {
        await choosePreviewLanguage();
    });
    context.subscriptions.push(changeLangCmd);
    const changeLocalesDirCmd = vscode.commands.registerCommand('stringer.changeLocalesFolder', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const folder = vscode.window.activeTextEditor
            ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
            : (workspaceFolders && workspaceFolders[0]);
        if (!folder)
            return;
        const projectRoot = folder.uri.fsPath;
        const stateKey = `stringer.localesDir.${projectRoot}`;
        const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Select your i18n locales folder. You can select it later in the 🌐Stringer menu at the bottom right corner of your IDE'), 'Select Folder', 'Later');
        if (choice !== 'Select Folder')
            return;
        const pick = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            title: vscode.l10n.t('Select your locales folder (contains *.json locale files)'),
            defaultUri: folder.uri
        });
        if (!pick || pick.length === 0)
            return;
        const localesDir = pick[0].fsPath;
        try {
            await context.workspaceState.update(stateKey, localesDir);
        }
        catch { }
        // Reinitialize context and refresh
        await ensureProjectContext(vscode.window.activeTextEditor);
        langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage ?? '—'}`;
        previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
        refreshActiveEditorDecorations();
    });
    context.subscriptions.push(changeLocalesDirCmd);
    const togglePreviewCmd = vscode.commands.registerCommand('stringer.toggleInlinePreview', async () => {
        const cfg = vscode.workspace.getConfiguration('stringerHelper');
        const cur = cfg.get('enableInlinePreview', true);
        await cfg.update('enableInlinePreview', !cur, vscode.ConfigurationTarget.Global);
        refreshActiveEditorDecorations();
        previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
    });
    context.subscriptions.push(togglePreviewCmd);
    const changePreviewModeCmd = vscode.commands.registerCommand('stringer.changePreviewMode', async () => {
        const cfg = vscode.workspace.getConfiguration('stringerHelper');
        const enable = cfg.get('enableInlinePreview', true);
        const currentMode = (cfg.get('inlinePreviewKeyMode') || 'hidden');
        const pick = await vscode.window.showQuickPick([
            { label: vscode.l10n.t('No preview'), description: vscode.l10n.t('Hide all inline translations'), value: 'off' },
            { label: vscode.l10n.t('Key + locale preview'), description: vscode.l10n.t('Show full key and translation'), value: 'full' },
            { label: vscode.l10n.t('Locale only preview'), description: vscode.l10n.t('Show translation only'), value: 'hidden' }
        ], { title: vscode.l10n.t('Stringer: Change Preview Mode'), placeHolder: vscode.l10n.t('Select inline preview mode') });
        if (!pick)
            return;
        if (pick.value === 'off') {
            await cfg.update('enableInlinePreview', false, vscode.ConfigurationTarget.Global);
        }
        else {
            if (!enable)
                await cfg.update('enableInlinePreview', true, vscode.ConfigurationTarget.Global);
            await cfg.update('inlinePreviewKeyMode', pick.value, vscode.ConfigurationTarget.Global);
        }
        previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
        refreshActiveEditorDecorations();
    });
    context.subscriptions.push(changePreviewModeCmd);
    const reloadLocalesCmd = vscode.commands.registerCommand('stringer.reloadLocales', async () => {
        localeCache = {};
        await ensureProjectContext(vscode.window.activeTextEditor);
        await preloadLocales();
        refreshActiveEditorDecorations();
    });
    context.subscriptions.push(reloadLocalesCmd);
    const openControlPanelCmd = vscode.commands.registerCommand('stringer.openControlPanel', async () => {
        const panel = vscode.window.createWebviewPanel('stringerControlPanel', 'Stringer', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        const render = async () => {
            const cfg = vscode.workspace.getConfiguration('stringerHelper');
            const enable = cfg.get('enableInlinePreview', true);
            const keyMode = (cfg.get('inlinePreviewKeyMode') || 'hidden');
            const langs = await getAvailableLocales();
            const currentLang = activePreviewLanguage || (projectContext?.baseLanguage ?? '');
            const previewLabel = getPreviewModeLabel();
            const langOptions = langs
                .map((l) => `<option value="${l}" ${l === currentLang ? 'selected' : ''}>${l}</option>`)
                .join('');
            const modeOptions = [
                { v: 'off', l: vscode.l10n.t('No preview') },
                { v: 'full', l: vscode.l10n.t('Key + locale preview') },
                { v: 'hidden', l: vscode.l10n.t('Locale only preview') }
            ].map(({ v, l }) => `<option value="${v}" ${((!enable && v === 'off') || (enable && v === keyMode)) ? 'selected' : ''}>${l}</option>`).join('');
            const lblPreviewMode = vscode.l10n.t('Preview mode:');
            const lblPreviewLanguage = vscode.l10n.t('Preview language:');
            const lblReload = vscode.l10n.t('Reload locales');
            const lblAlign = vscode.l10n.t('Align Translations');
            const lblCurrent = vscode.l10n.t('Current: {0}', previewLabel);
            const lblWebsite = vscode.l10n.t('Website');
            const lblDocs = vscode.l10n.t('Docs');
            const lblBilling = vscode.l10n.t('Billing');
            const website = 'https://stringer-cli.com';
            const docs = 'https://docs.stringer-cli.com';
            const billing = 'https://stringer-cli.com/billing';
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
</html>`;
        };
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'setMode') {
                const cfg = vscode.workspace.getConfiguration('stringerHelper');
                if (msg.value === 'off') {
                    await cfg.update('enableInlinePreview', false, vscode.ConfigurationTarget.Global);
                }
                else {
                    await cfg.update('enableInlinePreview', true, vscode.ConfigurationTarget.Global);
                    await cfg.update('inlinePreviewKeyMode', msg.value, vscode.ConfigurationTarget.Global);
                }
                previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
                refreshActiveEditorDecorations();
            }
            if (msg.type === 'setLanguage') {
                activePreviewLanguage = String(msg.value);
                const extConfig = vscode.workspace.getConfiguration('stringerHelper');
                if (!extConfig.get('defaultPreviewLanguage')) {
                    await extConfig.update('defaultPreviewLanguage', activePreviewLanguage, vscode.ConfigurationTarget.Global);
                }
                await preloadLocales();
                langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`;
                refreshActiveEditorDecorations();
            }
            if (msg.type === 'reloadLocales') {
                localeCache = {};
                await preloadLocales();
                refreshActiveEditorDecorations();
                await render();
            }
            if (msg.type === 'align') {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                const folder = vscode.window.activeTextEditor
                    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
                    : (workspaceFolders && workspaceFolders[0]);
                if (folder)
                    await runAlignInTerminal(folder.uri.fsPath);
            }
            if (msg.type === 'open') {
                const url = String(msg.value);
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        });
        await render();
    });
    context.subscriptions.push(openControlPanelCmd);
    vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            refreshActiveEditorDecorations();
        }
    });
    vscode.window.onDidChangeActiveTextEditor(async (ed) => {
        if (!ed)
            return;
        const ok = await ensureProjectContext(ed);
        if (ok) {
            langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage}`;
            previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
            refreshActiveEditorDecorations();
        }
    });
    async function updateHasKeyContext(editor) {
        const ed = editor ?? vscode.window.activeTextEditor;
        if (!ed) {
            await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyAtCursor', false);
            await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyOnLine', false);
            return;
        }
        const pos = ed.selection.active;
        const hit = getTTupleAtPosition(ed.document, pos);
        await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyAtCursor', !!hit);
        const lineHit = getTTupleOnLine(ed.document, pos.line);
        await vscode.commands.executeCommand('setContext', 'stringer.hasI18nKeyOnLine', !!lineHit);
    }
    vscode.window.onDidChangeTextEditorSelection(async () => {
        await updateHasKeyContext();
    });
    vscode.window.onDidChangeActiveTextEditor(async () => {
        await updateHasKeyContext();
    });
    vscode.workspace.onDidChangeTextDocument(async (e) => {
        if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
            await updateHasKeyContext(vscode.window.activeTextEditor);
        }
    });
    vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('stringerHelper')) {
            refreshActiveEditorDecorations();
        }
    });
    // Initialize for current editor if any
    await ensureProjectContext(vscode.window.activeTextEditor);
    langStatusItem.text = `$(globe) Lang: ${activePreviewLanguage ?? '—'}`;
    previewStatusItem.text = `$(eye) Preview: ${getPreviewModeLabel()}`;
    refreshActiveEditorDecorations();
    const disposable = vscode.commands.registerCommand('stringer.addI18nKey', async () => {
        if (isProcessingCommand)
            return;
        isProcessingCommand = true;
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor)
                return;
            const selection = editor.selection;
            if (selection.isEmpty) {
                vscode.window.showInformationMessage(vscode.l10n.t('Select a string to add i18n key via Stringer.'));
                return;
            }
            const selectedText = editor.document.getText(selection);
            const selectedString = normalizeSelectedTextForI18n(selectedText.replace(/^['"`]/, '').replace(/['"`]$/, '').trim());
            const params = extractParamsFromNormalizedText(selectedString);
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) || (workspaceFolders && workspaceFolders[0]);
            if (!folder) {
                await promptOpenWorkspaceFolder();
                return;
            }
            const projectRoot = folder.uri.fsPath;
            const config = await loadCliProjectConfig(projectRoot);
            if (!config) {
                const ok = await ensureProjectContext(editor);
                if (!ok || !projectContext) {
                    await promptOpenWorkspaceFolder();
                    return;
                }
            }
            const outputDirConfigured = (config && config.outputDir) || projectContext?.localesDir || path.join('i18n', 'locales');
            const localesDir = projectContext?.localesDir || path.resolve(projectRoot, outputDirConfigured);
            ensureDir(localesDir);
            const baseLanguage = (config && config.baseLanguage) || (projectContext?.baseLanguage || 'en');
            const baseLangPath = path.join(localesDir, `${baseLanguage}.json`);
            if (!fs.existsSync(baseLangPath)) {
                ensureDir(path.dirname(baseLangPath));
                fs.writeFileSync(baseLangPath, JSON.stringify({}, null, 2));
            }
            let baseJson = {};
            try {
                baseJson = JSON.parse(fs.readFileSync(baseLangPath, 'utf-8'));
            }
            catch (_e) {
                vscode.window.showErrorMessage(vscode.l10n.t('Base language file has invalid JSON. Please fix it and try again. No changes were made.'));
                return;
            }
            const filePath = editor.document.uri.fsPath;
            const keyPathPrefix = generateKeyPath(filePath, projectRoot);
            if (!keyPathPrefix) {
                vscode.window.showErrorMessage(vscode.l10n.t('Cannot derive key path from file location.'));
                return;
            }
            const { updated, fullKeyPath } = addStringToBaseLanguage(baseJson, keyPathPrefix, selectedString);
            fs.writeFileSync(baseLangPath, JSON.stringify(updated, null, 2));
            const docText = editor.document.getText();
            const startOffset = editor.document.offsetAt(selection.start);
            const inVue = isVueFile(filePath);
            const inJsx = isJsxFile(filePath);
            const isTplText = inVue && isVueTemplateTextNode(docText, startOffset);
            const attrCtx = inVue ? getAttributeContext(docText, startOffset) : null;
            const jsxAttrCtx = !inVue && inJsx ? getJsxAttributeContext(docText, startOffset) : null;
            const paramsObj = params.length > 0 ? `{ ${params.join(', ')} }` : '';
            const expr = paramsObj ? `t('${fullKeyPath}', ${paramsObj})` : `t('${fullKeyPath}')`;
            await withEdit(editor, (edit) => {
                if (attrCtx) {
                    const { name, isBound, attrStart, valueStart, valueEnd } = attrCtx;
                    if (isBound) {
                        const range = new vscode.Range(editor.document.positionAt(valueStart), editor.document.positionAt(valueEnd));
                        edit.replace(range, expr);
                    }
                    else {
                        const fullAttrEnd = valueEnd + 1;
                        const range = new vscode.Range(editor.document.positionAt(attrStart), editor.document.positionAt(fullAttrEnd));
                        edit.replace(range, `:${name}="${expr}"`);
                    }
                }
                else if (jsxAttrCtx) {
                    const { valueStartQuote, valueEndQuote } = jsxAttrCtx;
                    // Replace including surrounding quotes with JSX expression {t('...')}
                    const range = new vscode.Range(editor.document.positionAt(valueStartQuote), editor.document.positionAt(valueEndQuote + 1));
                    edit.replace(range, `{${expr}}`);
                }
                else if (isTplText) {
                    const must = findEnclosingMustache(docText, startOffset);
                    if (must) {
                        const strBounds = findEnclosingStringLiteralBounds(docText, startOffset);
                        if (strBounds) {
                            const range = new vscode.Range(editor.document.positionAt(strBounds.qStart), editor.document.positionAt(strBounds.qEnd + 1));
                            edit.replace(range, expr);
                        }
                        else {
                            edit.replace(selection, expr);
                        }
                    }
                    else {
                        edit.replace(selection, `{{ ${expr} }}`);
                    }
                }
                else if (inJsx && isLikelyJsxUiContext(docText, startOffset)) {
                    // Wrap UI text with JSX expression
                    edit.replace(selection, `{${expr}}`);
                }
                else {
                    const bounds = findEnclosingStringLiteralBounds(docText, startOffset);
                    if (bounds) {
                        const range = new vscode.Range(editor.document.positionAt(bounds.qStart), editor.document.positionAt(bounds.qEnd + 1));
                        edit.replace(range, expr);
                    }
                    else {
                        edit.replace(selection, expr);
                    }
                }
            });
            if (inVue) {
                await ensureVueTDeclaration(editor);
            }
            else if (inJsx) {
                // Auto framework selection
                const extCfg = vscode.workspace.getConfiguration('stringerHelper');
                const framework = (extCfg.get('framework', 'auto') || 'auto');
                const effective = (() => {
                    if (framework !== 'auto')
                        return framework;
                    try {
                        const pkgPath = path.join(projectRoot, 'package.json');
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                        if (deps.next)
                            return 'next';
                        return 'react';
                    }
                    catch {
                        return 'react';
                    }
                })();
                const selOffset = startOffset;
                if (effective === 'next')
                    await ensureNextTDeclaration(editor, selOffset);
                else
                    await ensureReactTDeclaration(editor, selOffset);
            }
            const shouldShowAlign = (() => {
                try {
                    const files = fs
                        .readdirSync(localesDir)
                        .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
                    const others = files.filter((f) => f !== `${baseLanguage}.json`);
                    return others.length > 0;
                }
                catch {
                    return false;
                }
            })();
            if (shouldShowAlign) {
                const autoAlign = vscode.workspace.getConfiguration('stringerHelper').get('autoAlignAfterAdd', false);
                if (autoAlign) {
                    await runAlignInTerminal(projectRoot);
                }
                else {
                    const yes = vscode.l10n.t('Yes');
                    const no = vscode.l10n.t('No');
                    vscode.window
                        .showInformationMessage(vscode.l10n.t('Your translations are out of alignment. Run "{0}" to add missing translations?', 'stringer align'), yes, no)
                        .then(async (choice) => {
                        if (choice === yes) {
                            await runAlignInTerminal(projectRoot);
                        }
                    });
                }
            }
        }
        finally {
            isProcessingCommand = false;
        }
    });
    // (Restore and delete key) feature removed
    // Revert only the current t('key') usage to original base-language value (no locale deletion)
    const revertToOriginalCmd = vscode.commands.registerCommand('stringer.revertToOriginalText', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const doc = editor.document;
        const pos = editor.selection.active;
        const hit = getTTupleAtPosition(doc, pos) || getTTupleOnLine(doc, pos.line);
        if (!hit) {
            vscode.window.showInformationMessage(vscode.l10n.t("Place the cursor inside or on the same line as a t('key') call."));
            return;
        }
        if (!projectContext) {
            const ok = await ensureProjectContext(editor);
            if (!ok || !projectContext)
                return;
        }
        await preloadLocales();
        const baseJson = localeCache[projectContext.baseLanguage];
        const baseValue = getValueByPath(baseJson, hit.key) || getValueByPathLoose(baseJson, hit.key);
        if (typeof baseValue !== 'string') {
            vscode.window.showErrorMessage(vscode.l10n.t('Base language value not found for {0}', hit.key));
            return;
        }
        const docText = doc.getText();
        const startOffset = doc.offsetAt(hit.range.start);
        const filePath = doc.uri.fsPath;
        const inVue = isVueFile(filePath);
        const inJsx = isJsxFile(filePath);
        const inVueTpl = inVue && isVueTemplateTextNode(docText, startOffset);
        let replaceStart = hit.range.start;
        let replaceEnd = hit.range.end;
        let replacement = '';
        if (inVue && inVueTpl) {
            const must = findEnclosingMustache(docText, startOffset);
            if (must) {
                replaceStart = doc.positionAt(must.start);
                replaceEnd = doc.positionAt(must.end);
                replacement = baseValue;
            }
            else {
                replacement = baseValue;
            }
        }
        else if (inVue) {
            const attrCtx = getAttributeContext(docText, startOffset);
            if (attrCtx) {
                const { name, isBound, attrStart, valueStart, valueEnd } = attrCtx;
                if (isBound) {
                    replaceStart = doc.positionAt(attrStart);
                    replaceEnd = doc.positionAt(valueEnd + 1);
                    replacement = `${name}="${escapeHtmlAttr(baseValue)}"`;
                }
                else {
                    replaceStart = doc.positionAt(valueStart);
                    replaceEnd = doc.positionAt(valueEnd);
                    replacement = escapeHtmlAttr(baseValue);
                }
            }
            else {
                replacement = `"${escapeJsString(baseValue, '"')}"`;
            }
        }
        else if (inJsx) {
            let left = startOffset - 1;
            while (left >= 0 && /\s/.test(docText[left]))
                left--;
            let right = doc.offsetAt(hit.range.end);
            while (right < docText.length && /\s/.test(docText[right]))
                right++;
            const hasBraces = docText[left] === '{' && docText[right] === '}';
            const lastLt = docText.lastIndexOf('<', left);
            const lastGt = docText.lastIndexOf('>', left);
            const eq = docText.lastIndexOf('=', left);
            const inAttribute = eq > lastLt && eq > lastGt;
            if (hasBraces && inAttribute) {
                replaceStart = doc.positionAt(left);
                replaceEnd = doc.positionAt(right + 1);
                replacement = `"${escapeJsString(baseValue, '"')}"`;
            }
            else if (hasBraces && !inAttribute) {
                replaceStart = doc.positionAt(left);
                replaceEnd = doc.positionAt(right + 1);
                replacement = baseValue;
            }
            else if (inAttribute) {
                replacement = `"${escapeJsString(baseValue, '"')}"`;
            }
            else {
                replacement = `'${escapeJsString(baseValue, "'")}'`;
            }
        }
        else {
            replacement = `'${escapeJsString(baseValue, "'")}'`;
        }
        await withEdit(editor, (edit) => {
            edit.replace(new vscode.Range(replaceStart, replaceEnd), replacement);
        });
        refreshActiveEditorDecorations();
        await updateHasKeyContext(editor);
    });
    context.subscriptions.push(revertToOriginalCmd);
    // Ignore this line: inserts language-appropriate comment with @stringer-ignore-next-line
    const ignoreLineCmd = vscode.commands.registerCommand('stringer.ignoreLine', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const doc = editor.document;
        const pos = editor.selection.active;
        const langId = doc.languageId;
        const getLineComment = (languageId) => {
            // Default to //, HTML/Vue template to <!-- -->, but we insert as single-line style where possible
            if (languageId === 'html')
                return '<!-- @stringer-ignore-next-line -->';
            if (languageId === 'vue') {
                // Insert as JS comment above the script/template line; prefer //
                return '// @stringer-ignore-next-line';
            }
            if (languageId === 'javascript' || languageId === 'typescript' || languageId === 'javascriptreact' || languageId === 'typescriptreact') {
                return '// @stringer-ignore-next-line';
            }
            if (languageId === 'markdown')
                return '<!-- @stringer-ignore-next-line -->';
            return '// @stringer-ignore-next-line';
        };
        const line = doc.lineAt(pos.line);
        const insertPos = new vscode.Position(line.lineNumber, 0);
        const prefix = getLineComment(doc.languageId);
        await withEdit(editor, (edit) => {
            edit.insert(insertPos, `${prefix}\n`);
        });
    });
    context.subscriptions.push(ignoreLineCmd);
    // Ignore this file: insert a top-of-file marker @stringer-ignore
    const ignoreFileCmd = vscode.commands.registerCommand('stringer.ignoreFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const doc = editor.document;
        const firstLine = doc.lineAt(0);
        const langId = doc.languageId;
        const getFileHeaderComment = (languageId) => {
            // Use HTML-style comments for markup-centric languages and SFCs
            if (languageId === 'html' ||
                languageId === 'markdown' ||
                languageId === 'mdx' ||
                languageId === 'svelte' ||
                languageId === 'vue') {
                return '<!-- @stringer-ignore -->\n';
            }
            // Default JS/TS style
            return '// @stringer-ignore\n';
        };
        const header = getFileHeaderComment(langId);
        // If already present, skip
        const text = doc.getText();
        if (text.includes('@stringer-ignore'))
            return;
        await withEdit(editor, (edit) => {
            edit.insert(new vscode.Position(0, 0), header);
        });
    });
    context.subscriptions.push(ignoreFileCmd);
    // Status Bar Button
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(globe) Stringer';
    statusBarItem.tooltip = 'Open Stringer menu';
    statusBarItem.command = 'stringer.showMenu';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Menu command
    const showMenu = vscode.commands.registerCommand('stringer.showMenu', async () => {
        const items = [
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
        ];
        const pick = await vscode.window.showQuickPick(items, {
            title: 'Stringer',
            placeHolder: vscode.l10n.t('Select an action')
        });
        if (!pick)
            return;
        if (pick.id === 'change_color') {
            const cfg = vscode.workspace.getConfiguration('stringerHelper');
            const current = cfg.get('previewBackgroundColor') || 'hsl(270, 55%, 43%)';
            const val = await vscode.window.showInputBox({
                title: 'Stringer: Change Preview Color',
                placeHolder: '#aabbcc or any CSS color',
                value: String(current)
            });
            if (val) {
                await cfg.update('previewBackgroundColor', val, vscode.ConfigurationTarget.Global);
                refreshActiveEditorDecorations();
            }
            return;
        }
        if (pick.id === 'align') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const folder = vscode.window.activeTextEditor
                ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
                : (workspaceFolders && workspaceFolders[0]);
            if (!folder) {
                vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'));
                return;
            }
            await runAlignInTerminal(folder.uri.fsPath);
            return;
        }
        if (pick.id === 'convert') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const folder = vscode.window.activeTextEditor
                ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
                : (workspaceFolders && workspaceFolders[0]);
            if (!folder) {
                vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'));
                return;
            }
            await runConvertInTerminal(folder.uri.fsPath);
            return;
        }
        if (pick.id === 'select_locales') {
            await vscode.commands.executeCommand('stringer.changeLocalesFolder');
            return;
        }
        if (pick.id === 'change_lang') {
            await choosePreviewLanguage();
            return;
        }
        if (pick.id === 'change_mode') {
            await vscode.commands.executeCommand('stringer.changePreviewMode');
            return;
        }
        if (pick.id === 'open_website') {
            vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com'));
            return;
        }
        if (pick.id === 'open_docs') {
            vscode.env.openExternal(vscode.Uri.parse('https://docs.stringer-cli.com'));
            return;
        }
        if (pick.id === 'open_billing') {
            vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com/billing'));
            return;
        }
    });
    context.subscriptions.push(disposable, showMenu);
}
function deactivate() { }
//# sourceMappingURL=start.js.map