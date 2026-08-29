export type EditorLanguage =
  | 'javascript'
  | 'typescript'
  | 'jsx'
  | 'tsx'
  | 'vue'
  | 'json'
  | 'html'
  | 'css'
  | 'markdown'
  | 'plain';

export function editorLanguageForPath(path: string): EditorLanguage {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (name === '.vue') return 'vue';
  if (name.endsWith('.vue')) return 'vue';
  if (/\.(tsx)$/.test(name)) return 'tsx';
  if (/\.(jsx)$/.test(name)) return 'jsx';
  if (/\.(ts|mts|cts)$/.test(name)) return 'typescript';
  if (/\.(js|mjs|cjs)$/.test(name)) return 'javascript';
  if (/\.(json|jsonc)$/.test(name)) return 'json';
  if (/\.(html|htm)$/.test(name)) return 'html';
  if (/\.(css|scss|sass|less)$/.test(name)) return 'css';
  if (/\.(md|markdown)$/.test(name)) return 'markdown';
  return 'plain';
}
