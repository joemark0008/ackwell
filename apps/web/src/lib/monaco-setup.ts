// Monaco is bundled locally (no CDN): the app runs on a LAN. Only the editor core, the JSON language
// service and the few contributions we use are imported, to keep the lazy chunk small.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};

export const HL7_LANG = 'hl7';
export const THEME_LIGHT = 'ackwell-light';
export const THEME_DARK = 'ackwell-dark';

monaco.languages.register({ id: HL7_LANG });
monaco.languages.setMonarchTokensProvider(HL7_LANG, {
  tokenizer: {
    root: [
      [/^MSH(?=\|)/, 'type.msh'],
      [/^[A-Z][A-Z0-9]{2}(?=\|)/, 'keyword.segment'],
      [/\\[A-Za-z.]{1,3}[^\\\r\n|]*\\/, 'string.escape'],
      [/\|/, 'delimiter.field'],
      [/\^/, 'delimiter.component'],
      [/~/, 'delimiter.repeat'],
      [/&/, 'delimiter.subcomponent'],
      [/\\/, 'delimiter.escape'],
      [/[^|^~\\&\r\n]+/, 'string.value'],
    ],
  },
});

const base = { inherit: true } as const;
monaco.editor.defineTheme(THEME_LIGHT, {
  ...base,
  base: 'vs',
  rules: [
    { token: 'type.msh', foreground: 'b45309', fontStyle: 'bold' },
    { token: 'keyword.segment', foreground: '1d4ed8', fontStyle: 'bold' },
    { token: 'delimiter.field', foreground: 'dc2626' },
    { token: 'delimiter.component', foreground: '7c3aed' },
    { token: 'delimiter.repeat', foreground: '0891b2' },
    { token: 'delimiter.subcomponent', foreground: 'c026d3' },
    { token: 'delimiter.escape', foreground: '71717a' },
    { token: 'string.escape', foreground: '71717a' },
  ],
  colors: { 'editor.background': '#ffffff', 'editorGutter.background': '#ffffff', 'editor.lineHighlightBackground': '#f4f4f5' },
});
monaco.editor.defineTheme(THEME_DARK, {
  ...base,
  base: 'vs-dark',
  rules: [
    { token: 'type.msh', foreground: 'fbbf24', fontStyle: 'bold' },
    { token: 'keyword.segment', foreground: '60a5fa', fontStyle: 'bold' },
    { token: 'delimiter.field', foreground: 'f87171' },
    { token: 'delimiter.component', foreground: 'a78bfa' },
    { token: 'delimiter.repeat', foreground: '22d3ee' },
    { token: 'delimiter.subcomponent', foreground: 'e879f9' },
    { token: 'delimiter.escape', foreground: 'a1a1aa' },
    { token: 'string.escape', foreground: 'a1a1aa' },
  ],
  colors: { 'editor.background': '#09090b', 'editorGutter.background': '#09090b', 'editor.lineHighlightBackground': '#18181b' },
});

loader.config({ monaco });
