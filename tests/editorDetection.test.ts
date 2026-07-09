import assert from 'node:assert/strict';
import {
  mergeDetectedEditors,
  normalizeEditorPath,
  type DetectedEditor,
} from '../src/utils/editorDetection';
import type { EditorConfig } from '../src/types';

console.log('=== editorDetection ===');

const existing: EditorConfig[] = [
  { id: 'code-old', name: 'Visual Studio Code', path: 'D:\\Microsoft VS Code\\bin\\code' },
  { id: 'custom', name: 'Custom Editor', path: 'D:\\Tools\\custom.exe' },
];

const detected: DetectedEditor[] = [
  { name: 'Visual Studio Code', path: 'd:/Microsoft VS Code/bin/code.cmd' },
  { name: 'Trae CN', path: 'D:\\Trae\\bin\\trae.cmd' },
  { name: '', path: '' },
];

assert.equal(
  normalizeEditorPath('D:/Microsoft VS Code/bin/code.cmd'),
  'd:\\microsoft vs code\\bin\\code',
  '路径归一化应忽略分隔符、大小写和命令包装后缀',
);

const merged = mergeDetectedEditors(existing, detected);

assert.equal(merged.length, 3, '应保留已有编辑器并只追加未存在的扫描结果');
assert.equal(merged[0].id, 'code-old', '重复扫描结果不应替换用户已有配置');
assert.equal(merged[1].id, 'custom', '自定义编辑器应保留');
assert.equal(merged[2].name, 'Trae CN', '应追加新扫描到的编辑器');
assert.equal(merged[2].path, 'D:\\Trae\\bin\\trae.cmd', '应保留扫描返回的真实路径');

console.log('editorDetection tests passed');
