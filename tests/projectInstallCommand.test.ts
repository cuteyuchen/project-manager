import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import type { Project } from '../src/types.ts';
import type { ImportNode } from '../src/api/types.ts';

// TauriAdapter 构造时会读取当前窗口，先提供最小宿主形状
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      // 目录扫描返回空数组，避免后台前端环境扫描报错刷屏
      invoke: (command: string) => Promise.resolve(command === 'read_dir' ? [] : undefined),
    },
    matchMedia: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  },
});

// settings store 初始化时会读 localStorage
const storageMock: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => storageMock[key] ?? null,
  setItem: (key: string, value: string) => { storageMock[key] = value; },
  removeItem: (key: string) => { delete storageMock[key]; },
  clear: () => { Object.keys(storageMock).forEach(key => delete storageMock[key]); },
};

const { useProjectStore } = await import('../src/stores/project.ts');

setActivePinia(createPinia());
const store = useProjectStore();

/***********************添加 node 项目：自动补「安装依赖」*********************/

const nodeProject: Project = {
  id: 'p-node',
  name: 'Frontend App',
  path: 'C:/repos/app',
  type: 'node',
  packageManager: 'pnpm',
  scripts: ['dev', 'build'],
};

store.addProject(nodeProject);

const added = store.projects.find(project => project.id === 'p-node');
const installCommand = added?.customCommands?.find(command => command.builtinId === 'install_dependencies');
assert(installCommand, '通过后期导入/刷新入库的 node 项目必须自动带上「安装依赖」命令');
assert.equal(installCommand.command, 'pnpm install', '安装命令应使用项目推断出的包管理器');

/***********************已在列表中时不得重复插入*********************/

const duplicated = store.projects.filter(project => project.id === 'p-node');
assert.equal(duplicated.length, 1);
assert.equal(
  duplicated[0].customCommands?.filter(command => command.builtinId === 'install_dependencies').length,
  1,
  '重复调用 addProject 不应产生两条安装依赖命令',
);

/***********************扫描导入的子项目同样补齐*********************/

const importNodes: ImportNode[] = [
  {
    name: 'web',
    path: 'C:/repos/mono/web',
    kind: 'frontend',
    framework: 'Vue',
    hasGit: false,
    hasPackageJson: true,
    scripts: ['dev', 'build'],
    children: [],
  },
  {
    name: 'docs-site',
    path: 'C:/repos/mono/docs-site',
    kind: 'static',
    hasGit: false,
    hasPackageJson: false,
    scripts: [],
    children: [],
  },
];

const created = store.addProjectTree(undefined, importNodes);

const web = created.find(project => project.name === 'web');
assert(web, '扫描导入应创建前端子项目');
assert.equal(web.type, 'node');
const webInstall = web.customCommands?.find(command => command.builtinId === 'install_dependencies');
assert(webInstall, '扫描导入的前端模块必须自动带上「安装依赖」');
assert.equal(webInstall.command, 'npm install');

const staticSite = created.find(project => project.name === 'docs-site');
assert(staticSite, '静态目录仍应作为项目导入');
assert(
  !staticSite.customCommands?.some(command => command.builtinId === 'install_dependencies'),
  '没有 package.json 的纯静态目录不能被塞进 npm install',
);

console.log('project install command tests passed');
