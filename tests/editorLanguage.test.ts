import { strict as assert } from 'node:assert';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, highlightingFor, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { editorHighlightExtension } from '../src/utils/editorHighlight';
import { editorLanguageExtension, editorLanguageForPath } from '../src/utils/editorLanguage';

const expectedLanguages: Record<string, string> = {
  'main.ts': 'typescript',
  'App.vue': 'vue',
  'worker.py': 'python',
  'Main.java': 'java',
  'lib.rs': 'rust',
  'service.go': 'go',
  'widget.dart': 'dart',
  'native.cpp': 'cpp',
  'config.yaml': 'yaml',
  'settings.toml': 'toml',
  'layout.xml': 'xml',
  'query.sql': 'sql',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
  '.env.example': 'dotenv',
  '.env.production.local': 'dotenv',
  'env.txt': 'plain',
  'output.log': 'plain',
};

for (const [path, language] of Object.entries(expectedLanguages)) {
  assert.equal(editorLanguageForPath(path), language, `${path} 应检测为 ${language}`);
}

for (const dark of [true, false]) {
  const state = EditorState.create({
    doc: 'const value = 42;\n// comment\nconst text = "ok";\n',
    extensions: [editorLanguageExtension('typescript'), editorHighlightExtension(dark)],
  });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const tree = syntaxTree(state).toString();
  assert.match(tree, /LineComment/, 'TypeScript 应解析注释节点');
  assert.ok(highlightingFor(state, [tags.keyword]), 'TypeScript keyword 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.string]), 'TypeScript string 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.comment]), 'TypeScript comment 应产生高亮 token');
}

for (const dark of [true, false]) {
  const state = EditorState.create({
    doc: '# comment\nPOSTGRES_DB=pianlv_platform\nPORT=5432\nDEBUG=true\nEMPTY=\nSECRET="hello world"\nVALUE=${OTHER_VALUE}\nNULL_VALUE=null\n',
    extensions: [editorLanguageExtension('dotenv'), editorHighlightExtension(dark)],
  });
  assert.ok(highlightingFor(state, [tags.comment]), 'dotenv comment 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.variableName]), 'dotenv key/reference 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.operator]), 'dotenv 等号应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.string]), 'dotenv value 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.number]), 'dotenv number 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.bool]), 'dotenv bool 应产生高亮 token');
  assert.ok(highlightingFor(state, [tags.atom]), 'dotenv null 应产生高亮 token');
}

console.log('editor language tests passed');
