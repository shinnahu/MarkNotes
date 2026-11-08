import { HighlightStyle, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t, highlightCode } from '@lezer/highlight';

/** Colours come from theme CSS variables, so every theme restyles code instantly. */
export const appHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--syn-type)' },
  { tag: [t.variableName, t.self], color: 'var(--syn-variable)' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syn-property)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.derefOperator], color: 'var(--syn-operator)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: 'var(--text-muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
  // Markdown
  { tag: t.heading1, fontWeight: '700', color: 'var(--text-strong)' },
  { tag: [t.heading2, t.heading3], fontWeight: '700', color: 'var(--text-strong)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650', color: 'var(--text-strong)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--text-strong)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--link)' },
  { tag: t.url, color: 'var(--link)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.contentSeparator, color: 'var(--text-muted)' },
]);

const aliases = {
  js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx', py: 'python', cs: 'c#', csharp: 'c#',
  'c++': 'c++', cpp: 'c++', sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', ps: 'powershell', ps1: 'powershell',
  pwsh: 'powershell', yml: 'yaml', md: 'markdown', html: 'html', xml: 'xml', json: 'json', sql: 'sql', rb: 'ruby',
  rs: 'rust', go: 'go', golang: 'go', kt: 'kotlin', gd: 'python', gdscript: 'python', hlsl: 'c++', glsl: 'c++',
  shader: 'c++', shaderlab: 'c++', vb: 'vb.net', dockerfile: 'dockerfile', ini: 'properties files', toml: 'toml',
  lua: 'lua', php: 'php', java: 'java', swift: 'swift', dart: 'dart', r: 'r', css: 'css', scss: 'sass', less: 'less',
};

export function findLanguage(info) {
  const name = (info || '').trim().split(/[\s{]/)[0].toLowerCase();
  if (!name) return null;
  const mapped = aliases[name] || name;
  return LanguageDescription.matchLanguageName(languages, mapped, true);
}

const loaded = new Map();

/** Loads (once) the parser for a fenced block's language. */
export function loadParser(info) {
  const desc = findLanguage(info);
  if (!desc) return Promise.resolve(null);
  if (loaded.has(desc.name)) return loaded.get(desc.name);
  const p = desc.load().then((support) => support.language.parser).catch(() => null);
  loaded.set(desc.name, p);
  return p;
}

export function languageLabel(info) {
  const raw = (info || '').trim().split(/[\s{]/)[0];
  if (!raw) return 'text';
  const desc = findLanguage(raw);
  return desc ? desc.name : raw;
}

/** Fills `target` with highlighted lines (one element per line). */
export function renderHighlighted(target, code, parser) {
  const frag = document.createDocumentFragment();
  let line = document.createElement('span');
  line.className = 'cc-line';
  const pushLine = () => {
    if (!line.firstChild) line.appendChild(document.createTextNode('​'));
    frag.appendChild(line);
    line = document.createElement('span');
    line.className = 'cc-line';
  };
  if (parser) {
    const tree = parser.parse(code);
    highlightCode(code, tree, appHighlight, (text, classes) => {
      if (classes) {
        const s = document.createElement('span');
        s.className = classes;
        s.textContent = text;
        line.appendChild(s);
      } else line.appendChild(document.createTextNode(text));
    }, pushLine);
  } else {
    const lines = code.split('\n');
    lines.forEach((l, i) => {
      if (l) line.appendChild(document.createTextNode(l));
      if (i < lines.length - 1) pushLine();
    });
  }
  pushLine();
  target.replaceChildren(frag);
}
