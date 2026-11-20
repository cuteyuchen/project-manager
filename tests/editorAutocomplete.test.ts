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
  getLanguageCompletions,
  extractDocumentWords,
  getPathCompletions,
  createEditorAutocompleteSource,
} = await import('../src/utils/editorAutocomplete');

// 1. 测试各语言预置词典与 Snippets
{
  const vueCompletions = getLanguageCompletions('vue');
  assert.ok(vueCompletions.length > 30);
  assert.ok(vueCompletions.some(c => c.label === 'ref'));
  assert.ok(vueCompletions.some(c => c.label === 'computed'));
  assert.ok(vueCompletions.some(c => c.label === 'clg'));
  assert.ok(vueCompletions.some(c => c.label === 'vref'));

  const pyCompletions = getLanguageCompletions('python');
  assert.ok(pyCompletions.some(c => c.label === 'def'));
  assert.ok(pyCompletions.some(c => c.label === 'main'));

  const rustCompletions = getLanguageCompletions('rust');
  assert.ok(rustCompletions.some(c => c.label === 'pub'));
  assert.ok(rustCompletions.some(c => c.label === 'Option'));

  const cssCompletions = getLanguageCompletions('css');
  assert.ok(cssCompletions.some(c => c.label === 'display'));
  assert.ok(cssCompletions.some(c => c.label === 'fcenter'));

  const sqlCompletions = getLanguageCompletions('sql');
  assert.ok(sqlCompletions.some(c => c.label === 'SELECT'));
}

// 2. 测试从当前文档中提取标识符
{
  const doc = `
    const userProfileResponse = await fetchUserProfile(userId);
    function handleUserProfileUpdate() {
      console.log(userProfileResponse);
    }
  `;
  const words = extractDocumentWords(doc, 'user');
  assert.ok(words.some(w => w.label === 'userProfileResponse'));
  assert.ok(words.some(w => w.label === 'fetchUserProfile'));
  assert.ok(words.some(w => w.label === 'handleUserProfileUpdate'));
  // 当前正在输入的单字 'user' 不应在候选列表中重复自身
  assert.ok(!words.some(w => w.label.toLowerCase() === 'user'));
}

// 3. 测试路径联想
{
  const root = process.cwd();
  const currentPath = 'src/components/dashboard/WorkspaceEditor.vue';

  // 联想同级目录 ./
  const sameDirCompletions = await getPathCompletions(root, currentPath, './');
  assert.ok(sameDirCompletions);
  assert.ok(sameDirCompletions!.length > 0);
  assert.ok(sameDirCompletions!.some(c => c.label === 'LightweightEditor.vue'));

  // 联想别名 @/utils/
  const aliasCompletions = await getPathCompletions(root, currentPath, '@/utils/');
  assert.ok(aliasCompletions);
  assert.ok(aliasCompletions!.some(c => c.label === 'editorAutocomplete.ts'));
}

// 4. 测试 CompletionSource 整体集成
{
  const source = createEditorAutocompleteSource({
    getLanguage: () => 'typescript',
    getProjectPath: () => process.cwd(),
    getCurrentPath: () => 'src/test.ts',
  });

  // 模拟光标在输入 'con' 的状态
  const mockContext = {
    pos: 3,
    explicit: false,
    state: {
      doc: {
        toString: () => 'const connectionPool = createPool();\ncon',
      },
    },
    matchBefore: (regex: RegExp) => {
      const line = 'con';
      const m = line.match(regex);
      return m ? { from: 0, to: 3, text: 'con' } : null;
    },
  } as any;

  const result = await source(mockContext);
  assert.ok(result);
  assert.equal(result!.from, 0);
  assert.ok(result!.options.length > 0);
  // 应包含语言关键字 const
  assert.ok(result!.options.some(o => o.label === 'const'));
  // 应包含文档中已有变量 connectionPool
  assert.ok(result!.options.some(o => o.label === 'connectionPool'));
}

console.log('editorAutocomplete tests passed');
