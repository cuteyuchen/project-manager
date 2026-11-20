import assert from 'node:assert/strict';
import { fileKind, fileExtension, isImageFile, isTextFile, mimeForFile, getFileIconClass } from '../src/utils/fileTypes';
import { joinWorkspacePath, normalizeWorkspaceRelativePath } from '../src/utils/workspacePath';

assert.equal(fileExtension('src\\App.vue'), 'vue');
assert.equal(fileKind('assets/photo.PNG'), 'image');
assert.equal(fileKind('.env.local'), 'text');
assert.equal(fileKind('archive.bin'), 'binary');
assert.equal(isImageFile('icon.ico'), true);
assert.equal(isTextFile('.gitignore'), true);
assert.equal(mimeForFile('photo.jpg'), 'image/jpeg');

for (const name of [
  'LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENCE', 'COPYING', 'COPYING.LESSER',
  'NOTICE', 'NOTICE-THIRD-PARTY', 'Makefile', 'Dockerfile', 'Jenkinsfile',
  '.gitattributes', '.gitmodules', '.dockerignore', '.prettierignore',
  '.eslintignore', '.stylelintignore', '.env.local',
]) {
  assert.equal(fileKind(`project/${name}`), 'text', `${name} should be text`);
}

for (const name of ['app.exe', 'library.dll', 'archive.zip', 'database.sqlite', 'document.pdf', 'module.wasm']) {
  assert.equal(fileKind(name), 'binary', `${name} should remain binary`);
}

assert.equal(joinWorkspacePath('src', '.', 'App.vue'), 'src/App.vue');
assert.throws(() => normalizeWorkspaceRelativePath('../outside'), /escapes/);
assert.throws(() => normalizeWorkspaceRelativePath('C:/outside'), /Invalid/);

// File icons verification
assert.equal(getFileIconClass('folder', true), 'i-mdi-folder-outline text-amber-500');
assert.equal(getFileIconClass('folder', true, { folderStyle: 'solid' }), 'i-mdi-folder text-amber-500');
assert.equal(getFileIconClass('data.json'), 'i-mdi-code-json text-amber-500');
assert.equal(getFileIconClass('config.json5'), 'i-mdi-code-json text-amber-500');
assert.equal(getFileIconClass('document.doc'), 'i-mdi-file-word-box text-blue-600');
assert.equal(getFileIconClass('document.docx'), 'i-mdi-file-word-box text-blue-600');
assert.equal(getFileIconClass('sheet.xlsx'), 'i-mdi-file-excel-box text-emerald-600');
assert.equal(getFileIconClass('sheet.xls'), 'i-mdi-file-excel-box text-emerald-600');
assert.equal(getFileIconClass('data.csv'), 'i-mdi-file-excel-box text-emerald-600');
assert.equal(getFileIconClass('archive.zip'), 'i-mdi-folder-zip text-purple-500');
assert.equal(getFileIconClass('archive.rar'), 'i-mdi-folder-zip text-purple-500');
assert.equal(getFileIconClass('archive.7z'), 'i-mdi-folder-zip text-purple-500');
assert.equal(getFileIconClass('archive.tar.gz'), 'i-mdi-folder-zip text-purple-500');
assert.equal(getFileIconClass('slides.ppt'), 'i-mdi-file-powerpoint-box text-orange-500');
assert.equal(getFileIconClass('slides.pptx'), 'i-mdi-file-powerpoint-box text-orange-500');
assert.equal(getFileIconClass('paper.pdf'), 'i-mdi-file-pdf-box text-red-500');
assert.equal(getFileIconClass('package.json'), 'i-mdi-npm text-red-500');
assert.equal(getFileIconClass('tsconfig.json'), 'i-mdi-language-typescript text-blue-500');
assert.equal(getFileIconClass('Dockerfile'), 'i-mdi-docker text-blue-500');
assert.equal(getFileIconClass('.gitignore'), 'i-mdi-git text-orange-500');
assert.equal(getFileIconClass('.env'), 'i-mdi-key-variant text-amber-500');
assert.equal(getFileIconClass('main.py'), 'i-mdi-language-python text-blue-400');
assert.equal(getFileIconClass('main.rs'), 'i-mdi-language-rust text-amber-600');
assert.equal(getFileIconClass('main.go'), 'i-mdi-language-go text-cyan-500');
assert.equal(getFileIconClass('App.vue'), 'i-mdi-vuejs text-green-500');
assert.equal(getFileIconClass('index.ts'), 'i-mdi-language-typescript text-blue-500');
assert.equal(getFileIconClass('index.tsx'), 'i-mdi-react text-cyan-400');
assert.equal(getFileIconClass('photo.png'), 'i-mdi-file-image-outline text-pink-500');
assert.equal(getFileIconClass('query.sql'), 'i-mdi-database text-cyan-500');
assert.equal(getFileIconClass('script.sh'), 'i-mdi-console text-emerald-400');

console.log('fileTypes tests passed');
