import assert from 'node:assert/strict';
import type { ImportCandidate, ImportNode, ProjectInfo } from '../src/api/types.ts';
import { buildImportRootProject, flattenImportNodeTree } from '../src/utils/importProjectTree.ts';

/***********************批量导入根项目*********************/

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

const root = buildImportRootProject(candidate, rootInfo, { createId: () => 'root-id' });

assert.equal(root.name, 'workspace-root', '一级项目应使用顶级文件夹名称');
assert.equal(root.path, candidate.path, '一级项目路径应指向顶级文件夹');
assert.equal(root.type, 'node', '一级项目仍保留自身扫描到的项目类型');
assert.equal(root.packageManager, 'pnpm', '一级项目保留自身包管理器');
assert.deepEqual(root.scripts, ['dev'], '一级项目保留自身脚本');
assert.equal(root.parentId, undefined, '一级项目不应带 parentId');

/***********************顶级目录扫描失败兜底*********************/

const fallbackRoot = buildImportRootProject(candidate, null, {
  createId: () => 'fallback-root-id',
});

assert.equal(fallbackRoot.name, 'workspace-root', '扫描失败时一级项目仍应使用顶级文件夹名称');
assert.equal(fallbackRoot.type, 'other', '扫描失败时一级项目应降级为普通容器项目');

/***********************子项目按层级挂载*********************/

/** 后端返回的嵌套树：workspace-root 下有 apps 与 services 两个容器，各含一个模块 */
const subTree: ImportNode[] = [
  {
    name: 'apps',
    path: 'F:/workspace/workspace-root/apps',
    kind: 'unknown',
    hasGit: false,
    hasPackageJson: false,
    scripts: [],
    children: [
      {
        name: 'web',
        path: 'F:/workspace/workspace-root/apps/web',
        kind: 'frontend',
        framework: 'Vue',
        hasGit: false,
        hasPackageJson: true,
        scripts: ['dev', 'build'],
        children: [],
      },
    ],
  },
  {
    name: 'services',
    path: 'F:/workspace/workspace-root/services',
    kind: 'unknown',
    hasGit: false,
    hasPackageJson: false,
    scripts: [],
    children: [
      {
        name: 'api',
        path: 'F:/workspace/workspace-root/services/api',
        kind: 'go',
        framework: 'Go',
        hasGit: false,
        hasPackageJson: false,
        scripts: [],
        children: [],
      },
    ],
  },
];

let counter = 0;
const children = flattenImportNodeTree(subTree, root.id, { createId: () => `id-${++counter}` });

assert.equal(children.length, 4, '两个容器与两个模块都应作为项目入库');

const byPath = new Map(children.map((p) => [p.path, p]));
const apps = byPath.get('F:/workspace/workspace-root/apps')!;
const web = byPath.get('F:/workspace/workspace-root/apps/web')!;
const services = byPath.get('F:/workspace/workspace-root/services')!;
const api = byPath.get('F:/workspace/workspace-root/services/api')!;

assert.equal(apps.parentId, root.id, '容器目录应挂在一级项目之下');
assert.equal(services.parentId, root.id, '容器目录应挂在一级项目之下');
assert.equal(web.parentId, apps.id, '模块应挂在其真实父容器之下，而不是平铺到一级项目');
assert.equal(api.parentId, services.id, '模块应挂在其真实父容器之下，而不是平铺到一级项目');

assert.equal(web.moduleKind, 'frontend', 'Vue 项目应识别为 frontend');
assert.equal(web.packageManager, 'npm', '含 package.json 的模块应默认使用 npm');
assert.deepEqual(web.scripts, ['dev', 'build'], '模块应保留其 npm scripts');
assert.equal(api.moduleKind, 'go', 'Go 项目应识别为 go');
assert.equal(api.packageManager, undefined, '无 package.json 的模块不应带包管理器');

console.log('importProjectTree tests passed');
