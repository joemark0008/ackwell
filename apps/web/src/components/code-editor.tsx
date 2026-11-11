import Editor from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import '@/lib/monaco-setup';
import { HL7_LANG, THEME_DARK, THEME_LIGHT } from '@/lib/monaco-setup';

/** Read-only Monaco viewer. Default export so it can be lazy-loaded (keeps Monaco out of the main bundle). */
export default function CodeEditor({ value, language }: { value: string; language: 'hl7' | 'json' }) {
  const { resolvedTheme } = useTheme();
  return (
    <Editor
      value={value}
      language={language === 'hl7' ? HL7_LANG : 'json'}
      theme={resolvedTheme === 'dark' ? THEME_DARK : THEME_LIGHT}
      loading={null}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        folding: language === 'json',
        wordWrap: 'off',
        fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
        fontSize: 12,
        lineNumbers: 'on',
        renderLineHighlight: 'none',
        automaticLayout: true,
        padding: { top: 8, bottom: 8 },
      }}
    />
  );
}
