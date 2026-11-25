import assert from 'node:assert/strict';
import type { Project } from '../src/types';
import type { ProjectInfo } from '../src/api/types';
import {
  applyProjectSnapshot,
  createSnapshotFromScan,
  diffProjectSnapshot,
  projectSnapshotSignature,
} from '../src/utils/projectTypeSync';

/***********************测试数据*********************/

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'demo',
    path: 'C:/work/demo',
    type: 'other',
    ...overrides,
  };
}

function makeScanInfo(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: 'demo',
    path: 'C:/work/demo',
    scripts: [],
    projectType: 'other',
    ...overrides,
  };
}

const APPLY_OPTIONS = { installCommandName: '安装依赖', isWindows: true };

/***********************空目录拉下前端代码：类型与脚本都要更新*********************/

const emptyProject = makeProject();
const frontendScan = makeScanInfo({
  projectType: 'node',
  scripts: ['dev', 'build'],
  packageManager: 'pnpm',
});

const frontendDiff = diffProjectSnapshot(emptyProject, frontendScan);
assert(frontendDiff, '空目录拉下 package.json 后必须识别为变化');
assert.equal(frontendDiff.typeChanged, true, '项目类型应从 other 变为 node');
assert.deepEqual(frontendDiff.scriptsAdded, ['build', 'dev'], '新增脚本应完整列出');
assert.deepEqual(frontendDiff.scriptsRemoved, []);

const frontendProject = applyProjectSnapshot(emptyProject, frontendScan, APPLY_OPTIONS);
assert.equal(frontendProject.type, 'node');
assert.deepEqual(frontendProject.scripts, ['build', 'dev']);
assert.equal(frontendProject.packageManager, 'pnpm');

const installCommand = frontendProject.customCommands?.find(command => command.builtinId === 'install_dependencies');
assert(installCommand, 'node 项目必须补上「安装依赖」命令，否则命令菜单缺项');
assert.equal(installCommand.command, 'pnpm install', '安装命令应跟随 lockfile 推断的包管理器');
assert.deepEqual(
  frontendProject.quickCommands?.[0],
  { type: 'script', id: 'dev' },
  '一级页快捷命令应指向新出现的 dev 脚本',
);

/***********************配置未变化时不得提示*********************/

const stableNodeProject = makeProject({ type: 'node', scripts: ['dev'], packageManager: 'npm' });
assert.equal(
  diffProjectSnapshot(stableNodeProject, makeScanInfo({ projectType: 'node', scripts: ['dev'], packageManager: 'npm' })),
  null,
  '内容与配置一致时不应产生变化提示',
);

/***********************仅脚本变化：保留用户隐藏旧脚本的选择，新脚本默认可见*********************/

const scriptDiff = diffProjectSnapshot(
  makeProject({ type: 'node', scripts: ['dev', 'old'], visibleScripts: ['dev'], packageManager: 'npm' }),
  makeScanInfo({ projectType: 'node', scripts: ['dev', 'build'], packageManager: 'npm' }),
);
assert(scriptDiff, '脚本增删应被识别');
assert.deepEqual(scriptDiff.scriptsAdded, ['build']);
assert.deepEqual(scriptDiff.scriptsRemoved, ['old']);

const scriptUpdated = applyProjectSnapshot(
  makeProject({
    type: 'node',
    scripts: ['dev', 'old'],
    visibleScripts: ['dev'],
    packageManager: 'npm',
    quickCommands: [{ type: 'script', id: 'old' }],
  }),
  makeScanInfo({ projectType: 'node', scripts: ['dev', 'build'], packageManager: 'npm' }),
  APPLY_OPTIONS,
);
assert.deepEqual(scriptUpdated.visibleScripts, ['build', 'dev'], '新脚本默认可见，已隐藏的旧脚本仍保持隐藏');
assert.deepEqual(scriptUpdated.scripts, ['build', 'dev']);
assert(
  !scriptUpdated.quickCommands?.some(command => command.type === 'script' && command.id === 'old'),
  '指向已删除脚本的快捷命令必须被裁掉',
);

/***********************快捷命令全部失效时回退默认挑选*********************/

const quickCommandFallback = applyProjectSnapshot(
  makeProject({
    type: 'node',
    scripts: ['old'],
    packageManager: 'npm',
    quickCommands: [{ type: 'script', id: 'old' }],
  }),
  makeScanInfo({ projectType: 'node', scripts: ['dev'], packageManager: 'npm' }),
  APPLY_OPTIONS,
);
assert.deepEqual(
  quickCommandFallback.quickCommands?.[0],
  { type: 'script', id: 'dev' },
  '原快捷命令全部失效时应回退到默认挑选，而不是留空',
);

/***********************node → java：清掉 node 内置命令，保留用户自定义命令*********************/

const nodeWithCustom = makeProject({
  type: 'node',
  scripts: ['dev'],
  packageManager: 'npm',
  customCommands: [
    { id: 'c-install', name: '安装依赖', command: 'npm install', builtinId: 'install_dependencies' },
    { id: 'c-custom', name: '自定义命令', command: 'echo hi' },
  ],
});

const javaScan = makeScanInfo({ projectType: 'java', buildTool: 'maven', hasWrapper: true });
const javaDiff = diffProjectSnapshot(nodeWithCustom, javaScan);
assert(javaDiff?.typeChanged, 'node → java 属于类型变化');

const javaProject = applyProjectSnapshot(nodeWithCustom, javaScan, APPLY_OPTIONS);
assert.equal(javaProject.type, 'java');
assert.equal(javaProject.buildTool, 'maven');
assert.equal(javaProject.hasWrapper, true);
assert.deepEqual(javaProject.scripts, [], 'java 项目不保留 npm scripts');
assert.equal(javaProject.packageManager, undefined);

assert(
  !javaProject.customCommands?.some(command => command.builtinId === 'install_dependencies'),
  '切到 java 后应移除 node 专属的安装依赖命令',
);
assert(
  javaProject.customCommands?.some(command => command.id === 'c-custom'),
  '用户自建命令不能被清理',
);
const javaRun = javaProject.customCommands?.find(command => command.builtinId === 'java_run');
assert(javaRun, 'java 项目应补齐预设命令');
assert.equal(javaRun.command, 'mvnw.cmd spring-boot:run', '存在 wrapper 时应优先使用 wrapper');

/***********************java → other：清空构建信息，只留用户命令*********************/

const javaWithCustom = makeProject({
  type: 'java',
  buildTool: 'maven',
  hasWrapper: false,
  customCommands: [
    { id: 'j-run', name: '启动服务', command: 'mvn spring-boot:run', builtinId: 'java_run' },
    { id: 'c-custom', name: '自定义命令', command: 'echo hi' },
  ],
});

const otherProject = applyProjectSnapshot(javaWithCustom, makeScanInfo({ projectType: 'other' }), APPLY_OPTIONS);
assert.equal(otherProject.type, 'other');
assert.equal(otherProject.buildTool, undefined);
assert.equal(otherProject.hasWrapper, undefined);
assert.deepEqual(otherProject.scripts, []);
assert.deepEqual(
  otherProject.customCommands?.map(command => command.id),
  ['c-custom'],
  '类型变为 other 时内置命令全部移除，用户命令保留',
);

/***********************签名去重：同一变化只提示一次*********************/

const signatureA = projectSnapshotSignature(createSnapshotFromScan(frontendScan));
const signatureB = projectSnapshotSignature(createSnapshotFromScan({
  ...frontendScan,
  scripts: ['dev', 'build', 'test'],
}));
assert.equal(
  signatureA,
  projectSnapshotSignature(createSnapshotFromScan(frontendScan)),
  '相同内容必须得到相同签名，才能避免重复弹窗',
);
assert.notEqual(signatureA, signatureB, '脚本变化后签名应改变，允许再次提示');

/***********************后端未识别的语言不应误报*********************/

assert.equal(
  diffProjectSnapshot(makeProject(), makeScanInfo({ projectType: 'other' })),
  null,
  'Go/Python 等后端返回 other 的项目不应触发提示',
);

console.log('project type sync tests passed');
