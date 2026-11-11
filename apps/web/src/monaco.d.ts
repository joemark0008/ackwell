// monaco-editor's package exports map has no types for deep ESM paths; reuse the public typings.
declare module 'monaco-editor/editor/editor.api' {
  export * from 'monaco-editor';
}
