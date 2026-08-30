import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const editorStore = readFileSync(resolve(root, 'src/stores/workspaceEditor.ts'), 'utf8');
const workspaceEditor = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceEditor.vue'), 'utf8');
const imageView = readFileSync(resolve(root, 'src/components/dashboard/ImageDocumentView.vue'), 'utf8');
const explorerNode = readFileSync(resolve(root, 'src/components/dashboard/ProjectExplorerNode.vue'), 'utf8');
const fileTree = readFileSync(resolve(root, 'src/components/dashboard/FileTreeNode.vue'), 'utf8');
const rustWorkspace = readFileSync(resolve(root, 'src-tauri/src/workspace.rs'), 'utf8');
const utoolsPreload = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');
const ztoolsPreload = readFileSync(resolve(root, 'ztools/preload.js'), 'utf8');

assert(
  /function documentKey[\s\S]{0,120}?editorDocumentKey/.test(editorStore),
  'Editor document key 必须走保留大小写的 editorDocumentKey',
);
assert(
  !/function documentKey[\s\S]{0,80}?toLowerCase\(\)/.test(editorStore),
  'documentKey 不得全局 toLowerCase',
);
assert(
  /reloadImageDocument/.test(editorStore),
  '图片外部变化必须走专门的 reloadImageDocument，不能复用 openImage existing fast-path',
);
assert(
  /if \(document\.kind === 'image'\) await reloadImageDocument/.test(editorStore),
  'checkExternalChanges 必须对 image 走 reloadImageDocument',
);
assert(
  /refreshDocumentDiskVersion/.test(editorStore) && /async function renamePath/.test(editorStore),
  'rename 成功后必须刷新 open document 的 diskVersion',
);
assert(
  /document\.kind === 'image'/.test(editorStore) && /reloadImageDocument/.test(editorStore),
  'checkExternalChanges 必须覆盖已打开的 image',
);

assert(
  /onActivated/.test(workspaceEditor) && /onDeactivated/.test(workspaceEditor),
  'KeepAlive Editor 必须在 activated/deactivated 绑定/解绑 focus',
);
assert(
  !/onMounted\(\(\) => \{\s*bindFocusListener/.test(workspaceEditor),
  'KeepAlive Editor 不得在 onMounted 额外绑定 focus，避免 inactive 实例继续监听',
);
assert(
  /focusBound/.test(workspaceEditor),
  'focus listener 必须防重复绑定',
);

assert(
  /naturalWidth/.test(imageView) && /width\.value \* zoom\.value/.test(imageView),
  '图片 100% 必须按 natural 像素缩放，而不是容器百分比宽度',
);

assert(
  /shouldAppendLogicalExplorerChild/.test(explorerNode),
  'nested registered child 必须用 filesystem subtree 去重，而不是只比直接子目录名',
);
assert(
  /pathsEqual\(project\.path, target\)/.test(fileTree),
  '注册子项目路径匹配必须走 platform-aware pathsEqual',
);

assert(
  /向上找最近存在的祖先/.test(rustWorkspace),
  'workspaceStat 在父目录也被删除时必须向上找 ancestor 并返回 exists=false',
);
assert(
  /original_permissions/.test(rustWorkspace),
  'atomic save 必须保留原文件权限',
);
assert(
  /fs\.chmodSync\(temp, mode\)/.test(utoolsPreload) && /fs\.chmodSync\(temp, mode\)/.test(ztoolsPreload),
  '插件 atomicWrite 必须保留原文件 mode',
);

console.log('workspaceEditorRepair tests passed');
