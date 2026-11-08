// Guesses whether pasted text is source code, and which language.

const LANG_RULES = [
  ['json', (t) => { const s = t.trim(); if (!/^[[{]/.test(s)) return 0; try { JSON.parse(s); return 10; } catch { return 0; } }],
  ['html', (t) => (/^\s*<(!doctype|html|head|body|div|span|section|template|ul|table|form|script|style)\b/i.test(t) ? 8 : 0)],
  ['xml', (t) => (/^\s*<\?xml/.test(t) ? 9 : 0)],
  ['csharp', (t) => score(t, [/\busing\s+(System|UnityEngine)[\w.]*;/, /\bnamespace\s+\w/, /\b(public|private|protected|internal)\s+(static\s+)?(class|void|int|string|bool|float|async|override|readonly)\b/, /\bMonoBehaviour\b/, /\b(Console\.Write|Debug\.Log)\b/, /\bvar\s+\w+\s*=\s*new\b/, /\[SerializeField\]/, /\bget;\s*set;/])],
  ['java', (t) => score(t, [/\bpublic\s+static\s+void\s+main\b/, /\bSystem\.out\.print/, /^\s*import\s+java\./m, /^\s*package\s+[\w.]+;/m, /@Override/])],
  ['typescript', (t) => score(t, [/\binterface\s+\w+\s*\{/, /:\s*(string|number|boolean|any|void)\b/, /\btype\s+\w+\s*=/, /\bimport\s+.*\s+from\s+['"]/, /<\w+>\(/, /\bas\s+const\b/]) - (/\bdef\s+\w+\(/.test(t) ? 3 : 0)],
  ['javascript', (t) => score(t, [/\b(const|let|var)\s+\w+\s*=/, /\bfunction\s*\w*\s*\(/, /=>\s*[{(]?/, /\bconsole\.\w+\(/, /\brequire\(['"]/, /\bexport\s+(default|const|function)\b/, /\bdocument\.|\bwindow\./, /\bawait\s+\w/])],
  ['python', (t) => score(t, [/^\s*def\s+\w+\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$/m, /^\s*(from\s+\w[\w.]*\s+)?import\s+\w/m, /^\s*class\s+\w+(\(.*\))?:\s*$/m, /\bself\.\w/, /\bprint\(/, /^\s*(if|elif|for|while|with|try|except)\b.*:\s*$/m, /\bNone\b|\bTrue\b|\bFalse\b/]) - (/[;{]\s*$/m.test(t) ? 2 : 0)],
  ['gdscript', (t) => score(t, [/^\s*extends\s+\w+/m, /^\s*func\s+\w+\(.*\)\s*(->\s*\w+)?\s*:\s*$/m, /@(export|onready)\b/, /\bvar\s+\w+\s*:=/, /\$\w+/, /\bsignal\s+\w+/]) * 1.2],
  ['cpp', (t) => score(t, [/^\s*#include\s*[<"]/m, /\bstd::/, /\bint\s+main\s*\(/, /\b(cout|cin|printf)\b/, /->\w+/, /\btemplate\s*</])],
  ['rust', (t) => score(t, [/\bfn\s+\w+\s*\(/, /\blet\s+mut\b/, /\bimpl\b/, /println!\(/, /::new\(/, /\bpub\s+(fn|struct)\b/])],
  ['go', (t) => score(t, [/^\s*package\s+\w+\s*$/m, /\bfunc\s+(\(\w+ \*?\w+\)\s*)?\w+\(/, /:=/, /\bfmt\.\w+\(/])],
  ['sql', (t) => score(t, [/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+TABLE|WITH)\b/im, /\bFROM\s+\w+/i, /\bWHERE\b/i, /\bJOIN\b/i, /\bGROUP BY\b|\bORDER BY\b/i]) * 1.2],
  ['powershell', (t) => score(t, [/\b(Get|Set|New|Remove|Write|Invoke|Start|Stop)-[A-Z]\w+/, /\$env:\w+/, /\$\w+\s*=/, /\|\s*(Where|Select|ForEach)-Object/])],
  ['bash', (t) => score(t, [/^\s*(\$\s+)?(sudo|npm|npx|yarn|pnpm|git|cd|ls|echo|export|apt|apt-get|pip|python|dotnet|curl|wget|chmod|mkdir|docker|kubectl)\b/m, /^#!\/bin\/(ba)?sh/m, /\s&&\s/, /\$\{?\w+\}?/])],
  ['css', (t) => score(t, [/^\s*[.#]?[\w-]+(\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{/m, /^\s*[\w-]+\s*:\s*[^;]+;\s*$/m, /@media\b/])],
  ['yaml', (t) => (/^(\s*[\w-]+:\s*(\S.*)?\n){3,}/m.test(t) && !/[;{}]/.test(t) ? 3 : 0)],
  ['lua', (t) => score(t, [/\blocal\s+\w+\s*=/, /\bfunction\s+\w+[.:]?\w*\(/, /\bend\b\s*$/m, /\bthen\b/])],
  ['php', (t) => (/<\?php/.test(t) ? 10 : 0)],
];

function score(t, res) {
  let s = 0;
  for (const re of res) if (re.test(t)) s += 2;
  return s;
}

/** Returns {lang} when the text looks like code, otherwise null. */
export function detectCode(text) {
  const t = text.replace(/\r\n?/g, '\n');
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  if (t.length > 400_000) return null;

  // Strong language signals first.
  let best = null;
  for (const [lang, fn] of LANG_RULES) {
    const s = fn(t);
    if (s > 0 && (!best || s > best.s)) best = { lang, s };
  }

  // Generic "codeness": symbols, indentation, line endings.
  const symbolRatio = (t.match(/[{}()[\];=<>|&$#@*/\\]/g) || []).length / Math.max(1, t.replace(/\s/g, '').length);
  const endsCode = lines.filter((l) => /[;{}),:]\s*$/.test(l)).length / lines.length;
  const indented = lines.filter((l) => /^(\t| {2,})\S/.test(l)).length / lines.length;
  const prose = lines.filter((l) => /^[A-ZÁÉÍÓÚÑ¿¡][^{};=<>]{30,}[.?!:]$/.test(l.trim())).length / lines.length;
  const bullets = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+\w/.test(l)).length / lines.length;

  let generic = symbolRatio * 20 + endsCode * 4 + indented * 3 - prose * 6 - bullets * 4;
  const total = (best ? best.s : 0) + generic;

  if (best && best.s >= 6 && prose < 0.5) return { lang: best.lang };
  if (total >= 6 && prose < 0.4 && bullets < 0.5) return { lang: best && best.s >= 2 ? best.lang : '' };
  return null;
}

const VSCODE_MODES = {
  csharp: 'csharp', javascript: 'javascript', typescript: 'typescript', javascriptreact: 'jsx', typescriptreact: 'tsx',
  python: 'python', json: 'json', jsonc: 'json', html: 'html', css: 'css', scss: 'scss', cpp: 'cpp', c: 'c',
  java: 'java', go: 'go', rust: 'rust', sql: 'sql', powershell: 'powershell', shellscript: 'bash', yaml: 'yaml',
  xml: 'xml', php: 'php', lua: 'lua', ruby: 'ruby', gdscript: 'gdscript', shaderlab: 'shaderlab', hlsl: 'hlsl',
  dockerfile: 'dockerfile', bat: 'bat', ini: 'ini', toml: 'toml', kotlin: 'kotlin', swift: 'swift', dart: 'dart',
};

/** Language information that editors put on the clipboard (VS Code, web pages). */
export function clipboardLanguage(dt) {
  const vs = dt.getData('vscode-editor-data');
  if (vs) {
    try {
      const mode = JSON.parse(vs).mode;
      if (mode && mode !== 'plaintext' && mode !== 'markdown') return { lang: VSCODE_MODES[mode] || mode, sure: true };
      if (mode === 'plaintext' || mode === 'markdown') return { lang: null, sure: true, plain: true };
    } catch { /* ignore */ }
  }
  const html = dt.getData('text/html');
  if (html && (html.match(/<pre[\s>]/gi) || []).length === 1) {
    // Only when the copied fragment is one code block and nothing else.
    const start = html.search(/<pre[\s>]/i);
    const end = html.search(/<\/pre>/i);
    const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (end > start && !strip(html.slice(0, start)) && !strip(html.slice(end + 6))) {
      const m = /class="[^"]*(?:language|lang)-([\w#+-]+)/i.exec(html);
      return { lang: m ? m[1] : '', sure: true };
    }
  }
  return null;
}
