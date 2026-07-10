import assert from 'node:assert/strict';
import type { ImportCandidate, ProjectInfo, SubProjectCandidate } from '../src/api/types.ts';
import { buildImportProjectTree } from '../src/utils/importProjectTree.ts';

/***********************批量导入项目树*********************/

const candidate: ImportCandidate = {
  name: 'workspace-root',
  path: 'F:/workspace/workspace-root',
  subModuleCount: 2,
  hasGit: true,
};

const rootInfo: ProjectInfo = {
  name: 'package-json-name',
  path: candidate.path,
  projectType: 'node',
  packageManager: 'pnpm',
  scripts: ['dev'],
};

const subProjects: SubProjectCandidate[] = [
  {
    name: 'web',
    path: 'F:/workspace/workspace-root/apps/web',
    kind: 'frontend',
    framework: 'Vue',
    hasPackageJson: true,
    scripts: ['dev', 'build'],
  },
  {
    name: 'api',
    path: 'F:/workspace/workspace-root/services/api',
    kind: 'go',
    framework: 'Go',
    hasPackageJson: false,
    scripts: [],
  },
];

const tree = buildImportProjectTree(candidate, rootInfo, subProjects, {
  createId: () => 'root-id',
});

assert.equal(tree.root.name, 'workspace-root', '一级项目应使用顶级文件夹名称');
assert.equal(tree.root.path, candidate.path, '一级项目路径应指向顶级文件夹');
assert.equal(tree.root.type, 'node', '一级项目仍保留自身扫描到的项目类型');
assert.equal(tree.root.packageManager, 'pnpm', '一级项目保留自身包管理器');
assert.deepEqual(tree.root.scripts, ['dev'], '一级项目保留自身脚本');

assert.equal(tree.children.length, 2, '识别到的子项目应作为二级项目返回');
assert.deepEqual(
  tree.children.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type,
    moduleKind: item.moduleKind,
    packageManager: item.packageManager,
    scripts: item.scripts,
  })),
  [
    {
      name: 'web',
      path: 'F:/workspace/workspace-root/apps/web',
      type: 'node',
      moduleKind: 'frontend',
      packageManager: 'npm',
      scripts: ['dev', 'build'],
    },
    {
      name: 'api',
      path: 'F:/workspace/workspace-root/services/api',
      type: 'other',
      moduleKind: 'go',
      packageManager: undefined,
      scripts: [],
    },
  ],
  '子项目应转换为 addSubProjects 可消费的二级项目定义',
);

/***********************顶级目录扫描失败兜底*********************/

const fallbackTree = buildImportProjectTree(candidate, null, subProjects, {
  createId: () => 'fallback-root-id',
});

assert.equal(fallbackTree.root.name, 'workspace-root', '扫描失败时一级项目仍应使用顶级文件夹名称');
assert.equal(fallbackTree.root.type, 'other', '扫描失败时一级项目应降级为普通容器项目');
assert.equal(fallbackTree.children.length, 2, '扫描失败不应影响已识别子项目挂载');

console.log('importProjectTree tests passed');
