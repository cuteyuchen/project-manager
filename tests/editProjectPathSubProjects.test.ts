import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import type { Project } from '../src/types.ts';

// TauriAdapter reads the current window during construction; provide minimal host shape.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: () => Promise.resolve(),
    },
  },
});

const { useProjectStore } = await import('../src/stores/project.ts');

const root = process.cwd();
const addProjectModalSource = readFileSync(resolve(root, 'src/components/AddProjectModal.vue'), 'utf8');
const subProjectScanModalSource = readFileSync(resolve(root, 'src/components/SubProjectScanModal.vue'), 'utf8');

/*********************** 静态检查：AddProjectModal 和 SubProjectScanModal *********************/

assert(
  addProjectModalSource.includes(':parent-project="currentEditProject"'),
  'AddProjectModal 中的 SubProjectScanModal 必须传入反映表单最新路径的 currentEditProject，而不是未修改的 editProject',
);

assert(
  !addProjectModalSource.includes(':parent-project="editProject"'),
  'AddProjectModal 不应再将未修改的 editProject 直接传给 SubProjectScanModal',
);

assert(
  addProjectModalSource.includes('currentEditProject = computed'),
  'AddProjectModal 应提供 currentEditProject computed 属性包含表单中的最新路径',
);

assert(
  subProjectScanModalSource.includes('watch(') && subProjectScanModalSource.includes('props.parentProject.path'),
  'SubProjectScanModal 应监听 parentProject.path 的变化并在打开时重新扫描',
);

/*********************** 运行时测试：projectStore.updateProject 路径更新及后代重定向 *********************/

setActivePinia(createPinia());
const store = useProjectStore();

// 创建一个父项目及两个子孙项目
const parentProject: Project = {
  id: 'p-parent',
  name: 'Parent Project',
  path: 'C:/repos/old-path',
  type: 'node',
  projectFiles: [
    { id: 'f-1', name: 'readme.md', path: 'C:/repos/old-path/readme.md', isDirectory: false },
    { id: 'f-2', name: 'external.txt', path: 'D:/external.txt', isDirectory: false },
  ],
};

const childProject: Project = {
  id: 'p-child',
  parentId: 'p-parent',
  name: 'Child Module',
  path: 'C:/repos/old-path/packages/child',
  type: 'node',
  projectFiles: [
    { id: 'f-3', name: 'package.json', path: 'C:/repos/old-path/packages/child/package.json', isDirectory: false },
  ],
};

const grandchildProject: Project = {
  id: 'p-grandchild',
  parentId: 'p-child',
  name: 'Grandchild Module',
  path: 'C:/repos/old-path/packages/child/nested',
  type: 'node',
};

const unrelatedProject: Project = {
  id: 'p-unrelated',
  name: 'Unrelated Project',
  path: 'C:/repos/unrelated',
  type: 'node',
};

store.projects = [parentProject, childProject, grandchildProject, unrelatedProject];

// 修改父项目路径并更新
store.updateProject({
  ...parentProject,
  path: 'D:/workspace/new-path',
});

// 验证父项目路径及内部 projectFiles 更新
const updatedParent = store.projects.find((p) => p.id === 'p-parent')!;
assert.equal(updatedParent.path, 'D:/workspace/new-path', '父项目路径应更新为新路径');
assert.equal(
  updatedParent.projectFiles?.[0]?.path,
  'D:/workspace/new-path/readme.md',
  '父项目内位于原目录下的 projectFiles 应同步重定向到新路径',
);
assert.equal(
  updatedParent.projectFiles?.[1]?.path,
  'D:/external.txt',
  '父项目内不位于原目录下的 projectFiles 不应被误修改',
);

// 验证子项目及孙项目路径更新
const updatedChild = store.projects.find((p) => p.id === 'p-child')!;
assert.equal(
  updatedChild.path,
  'D:/workspace/new-path/packages/child',
  '子项目路径应同步重定向到父项目新路径下',
);
assert.equal(
  updatedChild.projectFiles?.[0]?.path,
  'D:/workspace/new-path/packages/child/package.json',
  '子项目内的 projectFiles 应同步重定向到新路径',
);

const updatedGrandchild = store.projects.find((p) => p.id === 'p-grandchild')!;
assert.equal(
  updatedGrandchild.path,
  'D:/workspace/new-path/packages/child/nested',
  '孙级项目路径也应同步重定向到父项目新路径下',
);

// 验证无关项目未被修改
const updatedUnrelated = store.projects.find((p) => p.id === 'p-unrelated')!;
assert.equal(updatedUnrelated.path, 'C:/repos/unrelated', '无关项目路径不应改变');

console.log('editProjectPathSubProjects tests passed');
