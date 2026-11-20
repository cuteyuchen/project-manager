import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type TauriWindowStub = {
  __TAURI_INTERNALS__: { metadata: { currentWindow: { label: string } } };
};

(globalThis as typeof globalThis & { window?: TauriWindowStub }).window = {
  __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } },
};

const { api } = await import('../src/api');
api.readDir = async (dirPath: string) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
};
api.workspaceStat = async (root: string, relPath: string) => {
  const full = path.join(root, relPath);
  const st = fs.statSync(full);
  return {
    exists: true,
    isDirectory: st.isDirectory(),
    size: st.size,
    modifiedMs: st.mtimeMs,
  };
};

const {
  findPathsInLine,
  findFilePathAt,
  normalizeRelativePath,
  extractLineNumber,
  getCandidates,
  resolveFilePath,
} = await import('../src/utils/editorFileLinks');

// 1. 测试从不同语法中提取路径
{
  const line = "import LightweightEditor from './LightweightEditor.vue';";
  const matches = findPathsInLine(line, 0);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rawPath, './LightweightEditor.vue');
  assert.equal(matches[0].innerFrom, line.indexOf('./LightweightEditor.vue'));
  assert.equal(matches[0].innerTo, matches[0].innerFrom + './LightweightEditor.vue'.length);

  // findFilePathAt
  const found = findFilePathAt({ lineAt: () => ({ from: 0, to: line.length, text: line }) }, line.indexOf('./LightweightEditor.vue') + 5);
  assert.ok(found);
  assert.equal(found?.rawPath, './LightweightEditor.vue');
}

// 2. 测试多导入、双引号、Markdown、CSS url
{
  const multiLine = "import A from './A'; import B from '@/stores/project';";
  const matches = findPathsInLine(multiLine, 0);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].rawPath, './A');
  assert.equal(matches[1].rawPath, '@/stores/project');

  const mdLine = "Check out [the guide](./docs/guide.md) for info";
  const mdMatches = findPathsInLine(mdLine, 0);
  assert.equal(mdMatches.length, 1);
  assert.equal(mdMatches[0].rawPath, './docs/guide.md');

  const cssLine = "background: url('../assets/logo.png');";
  const cssMatches = findPathsInLine(cssLine, 0);
  assert.equal(cssMatches.length, 1);
  assert.equal(cssMatches[0].rawPath, '../assets/logo.png');

  const rustLine = "mod runner;";
  const rustMatches = findPathsInLine(rustLine, 0);
  assert.equal(rustMatches.length, 1);
  assert.equal(rustMatches[0].rawPath, './runner');
}

// 3. 测试 normalizeRelativePath
{
  assert.equal(normalizeRelativePath('src/components/dashboard', './LightweightEditor.vue'), 'src/components/dashboard/LightweightEditor.vue');
  assert.equal(normalizeRelativePath('src/components/dashboard', '../../api'), 'src/api');
  assert.equal(normalizeRelativePath('src/views', '@/stores/project'), 'src/stores/project');
  assert.equal(normalizeRelativePath('src/views', '~/utils/fileTypes'), 'src/utils/fileTypes');
  assert.equal(normalizeRelativePath('', '/public/favicon.ico'), 'public/favicon.ico');
  assert.equal(normalizeRelativePath('src/components', './sub/../sub/file.ts'), 'src/components/sub/file.ts');
  assert.equal(normalizeRelativePath('src', './foo.ts?worker'), 'src/foo.ts');
}

// 4. 测试 extractLineNumber
{
  assert.equal(extractLineNumber('./foo.ts:42'), 42);
  assert.equal(extractLineNumber('./foo.ts#L108'), 108);
  assert.equal(extractLineNumber('./foo.ts'), undefined);
}

// 5. 测试 getCandidates
{
  const candidates = getCandidates('src/components/dashboard', './LightweightEditor');
  assert.ok(candidates.includes('src/components/dashboard/LightweightEditor.vue'));
  assert.ok(candidates.includes('src/components/dashboard/LightweightEditor.ts'));
  assert.ok(candidates.includes('src/components/dashboard/LightweightEditor/index.ts'));

  const pkgCandidates = getCandidates('src', 'element-plus/dist/index.css');
  assert.ok(pkgCandidates.includes('node_modules/element-plus/dist/index.css'));
}

// 6. 测试真实工程中的路径解析
{
  const root = process.cwd();
  const currentPath = 'src/components/dashboard/WorkspaceEditor.vue';

  // Relative import .vue
  const res1 = await resolveFilePath(root, currentPath, './LightweightEditor.vue');
  assert.ok(res1);
  assert.equal(res1?.type, 'file');
  if (res1?.type === 'file') {
    assert.equal(res1.relativePath, 'src/components/dashboard/LightweightEditor.vue');
  }

  // Relative import directory with index.ts (../../api)
  const res2 = await resolveFilePath(root, currentPath, '../../api');
  assert.ok(res2);
  if (res2?.type === 'file') {
    assert.equal(res2.relativePath, 'src/api/index.ts');
  }

  // Relative import .ts without extension (../../types)
  const res3 = await resolveFilePath(root, currentPath, '../../types');
  assert.ok(res3);
  if (res3?.type === 'file') {
    assert.equal(res3.relativePath, 'src/types.ts');
  }

  // Alias @/utils/fileTypes
  const res4 = await resolveFilePath(root, currentPath, '@/utils/fileTypes');
  assert.ok(res4);
  if (res4?.type === 'file') {
    assert.equal(res4.relativePath, 'src/utils/fileTypes.ts');
  }

  // External URL
  const res5 = await resolveFilePath(root, currentPath, 'https://github.com/cuteyuchen');
  assert.ok(res5);
  assert.equal(res5?.type, 'url');
  if (res5?.type === 'url') {
    assert.equal(res5.url, 'https://github.com/cuteyuchen');
  }

  // Path with line number
  const res6 = await resolveFilePath(root, currentPath, './LightweightEditor.vue:50');
  assert.ok(res6);
  if (res6?.type === 'file') {
    assert.equal(res6.relativePath, 'src/components/dashboard/LightweightEditor.vue');
    assert.equal(res6.line, 50);
  }

  // Non-existent path returns null
  const res7 = await resolveFilePath(root, currentPath, './this_file_definitely_does_not_exist_xyz.vue');
  assert.equal(res7, null);

  // Plain non-file string returns null
  const res8 = await resolveFilePath(root, currentPath, 'Hello world text');
  assert.equal(res8, null);

  console.log('editorFileLinks tests passed');
}
