import assert from 'node:assert/strict';
import {
  editorDocumentKey,
  isFilesystemDescendant,
  normalizeComparablePath,
  normalizeWorkspaceRelativePath,
  pathCompareModeForPlatform,
  pathsEqual,
  remapWorkspaceRelativePath,
  shouldAppendLogicalExplorerChild,
} from '../src/utils/workspacePath';

/***********************Editor document key 保留大小写*********************/

assert.equal(editorDocumentKey('Foo.ts'), 'Foo.ts');
assert.equal(editorDocumentKey('foo.ts'), 'foo.ts');
assert.notEqual(editorDocumentKey('Foo.ts'), editorDocumentKey('foo.ts'));
assert.equal(editorDocumentKey('src\\Foo.ts'), 'src/Foo.ts');
assert.throws(() => editorDocumentKey('../secret.ts'), /escapes/);

const keys = new Set([editorDocumentKey('Foo.ts'), editorDocumentKey('foo.ts')]);
assert.equal(keys.size, 2, 'case-sensitive 模式可同时打开 Foo.ts 和 foo.ts，tabs 不互相覆盖');

/***********************Windows 物理路径比较忽略大小写*********************/

assert.equal(pathCompareModeForPlatform('win32'), 'insensitive');
assert.equal(pathCompareModeForPlatform('windows'), 'insensitive');
assert.equal(pathCompareModeForPlatform('linux'), 'sensitive');
assert.equal(pathCompareModeForPlatform('darwin'), 'sensitive');

assert.equal(
  normalizeComparablePath('C:\\Project\\Foo', 'insensitive'),
  normalizeComparablePath('c:/project/foo', 'insensitive'),
);
assert.ok(pathsEqual('C:\\Project\\App', 'c:/project/app', 'insensitive'));
assert.equal(
  pathsEqual('C:\\Project\\Foo.ts', 'C:\\Project\\foo.ts', 'sensitive'),
  false,
);

/***********************nested registered child 去重*********************/

const root = '/repo/root';
const nested = '/repo/root/packages/frontend';
const outside = '/other/frontend';

assert.equal(isFilesystemDescendant(root, nested, 'sensitive'), true);
assert.equal(shouldAppendLogicalExplorerChild(root, nested, 'sensitive'), false, '子树内注册项目不应再追加 logical child');
assert.equal(shouldAppendLogicalExplorerChild(root, outside, 'sensitive'), true, '路径不在父文件系统内时保留 logical child');
assert.equal(shouldAppendLogicalExplorerChild(root, root, 'sensitive'), true);

assert.equal(
  shouldAppendLogicalExplorerChild('C:\\repo\\Root', 'c:\\repo\\root\\packages\\frontend', 'insensitive'),
  false,
);

/***********************rename 路径映射*********************/

assert.equal(remapWorkspaceRelativePath('src/App.vue', 'src/Main.vue', 'src/App.vue'), 'src/Main.vue');
assert.equal(remapWorkspaceRelativePath('src', 'lib', 'src/App.vue'), 'lib/App.vue');
assert.equal(remapWorkspaceRelativePath('src', 'lib', 'src/nested/a.ts'), 'lib/nested/a.ts');
assert.equal(remapWorkspaceRelativePath('src', 'lib', 'README.md'), null);
assert.notEqual(
  remapWorkspaceRelativePath('Foo.ts', 'Bar.ts', 'foo.ts'),
  'Bar.ts',
  '相对路径映射必须区分大小写，不能把 foo.ts 当成 Foo.ts',
);

assert.equal(normalizeWorkspaceRelativePath('a/./b'), 'a/b');

console.log('workspacePath tests passed');
