import assert from 'node:assert/strict';
import { fileKind, fileExtension, isImageFile, isTextFile, mimeForFile } from '../src/utils/fileTypes';
import { joinWorkspacePath, normalizeWorkspaceRelativePath } from '../src/utils/workspacePath';

assert.equal(fileExtension('src\\App.vue'), 'vue');
assert.equal(fileKind('assets/photo.PNG'), 'image');
assert.equal(fileKind('.env.local'), 'text');
assert.equal(fileKind('archive.bin'), 'binary');
assert.equal(isImageFile('icon.ico'), true);
assert.equal(isTextFile('.gitignore'), true);
assert.equal(mimeForFile('photo.jpg'), 'image/jpeg');
assert.equal(joinWorkspacePath('src', '.', 'App.vue'), 'src/App.vue');
assert.throws(() => normalizeWorkspaceRelativePath('../outside'), /escapes/);
assert.throws(() => normalizeWorkspaceRelativePath('C:/outside'), /Invalid/);

console.log('fileTypes tests passed');
