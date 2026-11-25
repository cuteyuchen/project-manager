import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

/***********************项目类型自动检测的接线约束*********************/
// 检测逻辑本身由 projectTypeSync.test.ts 覆盖；这里锁住「谁在什么时候触发它」，
// 避免以后重构 App.vue / git store 时把入口弄丢，功能又悄悄失效。

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

const app = read('src/App.vue');
const gitStore = read('src/stores/git.ts');
const projectStoreSource = read('src/stores/project.ts');
const explorer = read('src/components/dashboard/WorkspaceProjectExplorer.vue');
const dashboard = read('src/views/Dashboard.vue');
const zh = read('src/locales/zh.ts');
const en = read('src/locales/en.ts');

assert(
  app.includes('useProjectTypeWatch') && /startProjectTypeWatch\(\)/.test(app),
  'App.vue 必须在数据加载完成后启动项目类型检测',
);
assert(
  /loaded\.value = true;[\s\S]{0,200}startProjectTypeWatch\(\)/.test(app),
  '检测应在 loaded 之后启动，避免扫描尚未载入的项目列表',
);

for (const operation of ['gitPull', 'gitSwitchBranch', 'gitMerge', 'gitReset']) {
  assert(
    gitStore.includes(operation),
    `git store 缺少 ${operation}`,
  );
}
assert(
  (gitStore.match(/notifyProjectFilesChanged\(path\)/g) ?? []).length >= 4,
  '拉取/合并/切分支/reset 成功后都要通知项目类型检测立即重跑',
);

assert(
  explorer.includes('notifyProjectFilesChanged(rootProject.value.path)'),
  '工作区文件树的刷新按钮必须触发项目类型检测',
);
assert(
  /notifyProjectFilesChanged\(\)/.test(dashboard),
  '项目列表的刷新按钮必须触发项目类型检测',
);

/***********************后期入库/刷新的 node 项目都要有安装依赖*********************/

assert(
  (projectStoreSource.match(/withNodeInstallCommand\(/g) ?? []).length >= 3,
  'addProject / addProjectTree 入库时必须补齐 node 项目的「安装依赖」命令',
);
assert(
  /if \(info && p\.type === 'node'\)[\s\S]{0,600}ensureNodeInstallCommand/.test(projectStoreSource),
  '刷新 node 项目时必须补齐「安装依赖」命令，并按 lockfile 校正包管理器',
);

for (const locale of [zh, en]) {
  for (const key of ['typeWatch:', 'typeChanged:', 'scriptsAdded:', 'confirm:', 'dismiss:']) {
    assert(locale.includes(key), `本地化文案缺少 ${key}`);
  }
}

console.log('project type watch wiring tests passed');
