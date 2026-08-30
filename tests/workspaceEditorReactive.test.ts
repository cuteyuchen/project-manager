import { strict as assert } from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
import type { EditorFileSnapshot, WorkspaceStat } from '../src/api/types';

type TauriWindowStub = {
  __TAURI_INTERNALS__: { metadata: { currentWindow: { label: string } } };
};

(globalThis as typeof globalThis & { window?: TauriWindowStub }).window = {
  __TAURI_INTERNALS__: { metadata: { currentWindow: { label: 'main' } } },
};

const { api } = await import('../src/api');
const { useWorkspaceEditorStore } = await import('../src/stores/workspaceEditor');

const project = {
  id: 'reactive-project',
  name: 'Reactive Project',
  path: 'C:\\workspace\\reactive-project',
  type: 'other' as const,
};
const stat: WorkspaceStat = {
  exists: true,
  isDirectory: false,
  size: 34,
  diskVersion: 'disk-v1',
  readOnly: false,
};
const snapshot: EditorFileSnapshot = {
  content: 'const loaded = true;\n',
  size: 22,
  diskVersion: 'disk-v1',
  encoding: 'utf-8',
  eol: 'lf',
  readOnly: false,
};

const originalStat = api.workspaceStat;
const originalRead = api.workspaceReadEditorFile;
const originalBinary = api.workspaceReadBinaryFileBase64;

try {
  setActivePinia(createPinia());
  const store = useWorkspaceEditorStore();
  let resolveSnapshot!: (value: EditorFileSnapshot) => void;
  let readStartedResolve!: () => void;
  const readStarted = new Promise<void>(resolve => { readStartedResolve = resolve; });

  api.workspaceStat = async () => stat;
  api.workspaceReadEditorFile = async () => {
    readStartedResolve();
    return new Promise(resolve => { resolveSnapshot = resolve; });
  };

  const opening = store.openText(project, 'src/main.ts');
  const placeholder = store.getDocument(project.id, 'src/main.ts');
  assert.ok(placeholder, 'openText 应同步创建占位文档');
  assert.equal(placeholder.loading, true, '异步读取期间文档必须保持 loading');

  await readStarted;
  resolveSnapshot(snapshot);
  await opening;

  const loaded = store.getDocument(project.id, 'src/main.ts');
  assert.ok(loaded, '读取完成后文档仍应存在');
  assert.equal(loaded.content, snapshot.content, '读取结果必须写回 store 正在使用的响应式文档');
  assert.equal(loaded.loading, false, '读取完成后 loading 必须关闭');
  assert.equal(loaded.diskVersion, snapshot.diskVersion, '磁盘版本必须同步');

  api.workspaceReadBinaryFileBase64 = async () => 'aW1hZ2U=';
  const imageOpening = store.openImage(project, 'assets/logo.png');
  const imagePlaceholder = store.getDocument(project.id, 'assets/logo.png');
  assert.ok(imagePlaceholder, 'openImage 应同步创建占位文档');
  assert.equal(imagePlaceholder.loading, true, '图片读取期间文档必须保持 loading');
  await imageOpening;
  const image = store.getDocument(project.id, 'assets/logo.png');
  assert.ok(image?.imageData?.startsWith('data:image/png;base64,'), '图片结果必须写回响应式文档');
  assert.equal(image?.loading, false, '图片读取完成后 loading 必须关闭');
} finally {
  api.workspaceStat = originalStat;
  api.workspaceReadEditorFile = originalRead;
  api.workspaceReadBinaryFileBase64 = originalBinary;
}

console.log('workspace editor reactive tests passed');
