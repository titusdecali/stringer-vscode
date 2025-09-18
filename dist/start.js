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
// Utilities to mirror CLI behavior
function readAllCliConfigs() {
    const configPath = path.join(os_1.default.homedir(), '.stringer-cli.json');
    try {
        if (!fs.existsSync(configPath))
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
            const selectedString = selectedText.replace(/^['"`]/, '').replace(/['"`]$/, '');
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri) || (workspaceFolders && workspaceFolders[0]);
            if (!folder) {
                vscode.window.showErrorMessage(vscode.l10n.t('No workspace folder found.'));
                return;
            }
            const projectRoot = folder.uri.fsPath;
            const config = await loadCliProjectConfig(projectRoot);
            if (!config) {
                vscode.window.showErrorMessage(vscode.l10n.t('Stringer CLI config not found. Run the Stringer CLI once in this project.'));
                return;
            }
            const outputDirConfigured = config.outputDir || path.join('i18n', 'locales');
            const localesDir = path.resolve(projectRoot, outputDirConfigured);
            ensureDir(localesDir);
            const baseLanguage = config.baseLanguage || 'en';
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
            const isTplText = inVue && isVueTemplateTextNode(docText, startOffset);
            const attrCtx = inVue ? getAttributeContext(docText, startOffset) : null;
            const expr = `t('${fullKeyPath}')`;
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
                else if (isTplText) {
                    edit.replace(selection, `{{ ${expr} }}`);
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
        finally {
            isProcessingCommand = false;
        }
    });
    // Status Bar Button
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(globe) Stringer';
    statusBarItem.tooltip = 'Open Stringer menu';
    statusBarItem.command = 'stringer.showMenu';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // Menu command
    const showMenu = vscode.commands.registerCommand('stringer.showMenu', async () => {
        const pick = await vscode.window.showQuickPick([
            {
                label: 'Align Translations',
                description: 'Add any missing translations for target languages based on your base language JSON file'
            },
            { label: 'Open Website', description: 'stringer-cli.com' },
            { label: 'Open Docs', description: 'docs.stringer-cli.com' },
            { label: 'Open Billing', description: 'stringer-cli.com/billing' }
        ], {
            title: 'Stringer',
            placeHolder: 'Select an action'
        });
        if (!pick)
            return;
        if (pick.label === 'Align Translations') {
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
        if (pick.label === 'Open Website') {
            vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com'));
            return;
        }
        if (pick.label === 'Open Docs') {
            vscode.env.openExternal(vscode.Uri.parse('https://docs.stringer-cli.com'));
            return;
        }
        if (pick.label === 'Open Billing') {
            vscode.env.openExternal(vscode.Uri.parse('https://stringer-cli.com/billing'));
            return;
        }
    });
    context.subscriptions.push(disposable, showMenu);
}
function deactivate() { }
//# sourceMappingURL=start.js.map