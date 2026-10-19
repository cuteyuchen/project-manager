import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  buildNodeRuntimeId,
  isExplicitNodeVersion,
  resolveAppDefaultNodePath,
  resolveNodePathFromVersion,
  resolveProjectNodePath,
  resolveProjectRuntime,
} from '../src/utils/nodeRuntime';
import { normalizeNodeVersion, projectNodeVersionHint } from '../src/utils/nvm';
import { getCustomCommandDisplayNameByLocale, getProjectCommandRunId } from '../src/utils/projectCommands';
import type { NodeVersion, Project } from '../src/types';

const read = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
const store = read('src/stores/project.ts');
const runner = read('src-tauri/src/runner.rs');
const preload = read('utools/preload.js');

/** 提取真实实现，避免在测试中复制一份 PATH 处理逻辑。 */
function findNode(source: string, predicate: (node: ts.Node) => boolean): ts.Node {
  const root = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (!found && predicate(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(root);
  assert(found, '未找到待测试的实现');
  return found;
}

function functionSource(source: string, name: string): string {
  return findNode(source, node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name,
  ).getText();
}

/***********************前端与三端参数契约*********************/
const customCommand = functionSource(store, 'runCustomCommand');
assert.match(customCommand, /await prepareProjectCommand\(project, sessionId\)/);
assert.match(customCommand, /api\.runCustomCommand\([\s\S]*nodePath[\s\S]*pmNodePath/);
assert.match(customCommand, /\[Runner\] Node Path:/);
assert.match(customCommand, /builtinId === 'install_dependencies' && pmCommandPath/);

for (const file of ['src/api/types.ts', 'src/api/adapters/tauri.ts', 'src/api/adapters/utools.ts']) {
  assert.match(read(file), /runCustomCommand\([^)]*nodePath\?: string, pmNodePath\?: string\)/, file);
}
assert.match(runner, /pub fn run_custom_command\([\s\S]*?node_path: Option<String>,\s*pm_node_path: Option<String>/);
const rustCustom = runner.slice(runner.indexOf('pub fn run_custom_command('), runner.indexOf('fn ensure_node_exe_in_dir('));
assert.match(rustCustom, /build_command_path_env\(/);
assert.match(rustCustom, /\.env\("PATH", path_env\)/);
assert.match(rustCustom, /system_node::latest_effective_path\(\)/);
assert.equal(preload, read('ztools/preload.js'), '两端插件必须保持相同的执行逻辑');

/***********************自定义命令运行与预检取消*********************/
const runtime = (version: string, runtimePath: string): NodeVersion => ({
  runtimeId: buildNodeRuntimeId('managed', version, runtimePath),
  source: 'managed',
  version,
  path: runtimePath,
  status: 'available',
});
const selectedNode = runtime('v24.14.1', 'C:/project-node24');
const defaultNode = runtime('v22.11.0', 'C:/default-node22');
const sessions = { value: {} as Record<string, { sessionId: string; status: string; nodePath?: string; nodeVersion?: string }> };
const calls: unknown[][] = [];
const canonicalPmCommand = '"C:/project-node24/node.exe" "C:/default-node22/node_modules/corepack/dist/pnpm.js"';
let pmAvailable = true;
let stopDuringPmCheck = false;
let latestSessionId = '';
const nodeStore = {
  versions: [selectedNode, defaultNode],
  appDefault: defaultNode,
  systemNodeRuntime: null,
  managedSupported: false,
  loadRuntimes: async () => {},
};
const storeFunctions = ['resolvePmForProject', 'prepareProjectCommand', 'runCustomCommand']
  .map(name => functionSource(store, name)).join('\n');
const storeImplementation = runInNewContext(
  ts.transpile(`${storeFunctions}\n({runCustomCommand})`, { target: ts.ScriptTarget.ES2022 }),
  {
    console,
    useNodeStore: () => nodeStore,
    useSettingsStore: () => ({ settings: { locale: 'zh' } }),
    resolveProjectRuntime, resolveProjectNodePath, resolveAppDefaultNodePath, resolveNodePathFromVersion,
    isExplicitNodeVersion, normalizeNodeVersion, projectNodeVersionHint,
    getCustomCommandDisplayNameByLocale, getProjectCommandRunId,
    runSessions: sessions,
    runningStatus: { value: {} },
    backendStartedSessionIds: new Set(),
    ElMessage: { error() {}, info() {}, success() {} },
    appendSessionLog() {},
    createRunSession() {
      latestSessionId = `run_${Object.keys(sessions.value).length}`;
      const session = { sessionId: latestSessionId, status: 'starting' };
      sessions.value[latestSessionId] = session;
      return session;
    },
    updateRunSession(id: string, update: object) { Object.assign(sessions.value[id], update); },
    failRunSession(id: string) { sessions.value[id].status = 'failed'; },
    api: {
      async resolvePackageManager() {
        if (stopDuringPmCheck) sessions.value[latestSessionId].status = 'stopped';
        return { available: pmAvailable, commandPath: canonicalPmCommand };
      },
      async runCustomCommand(...args: unknown[]) { calls.push(args); },
    },
  },
);
const project: Project = {
  id: 'my-admin', type: 'node', name: 'my-admin', path: 'C:/my-admin',
  nodeRuntimeId: selectedNode.runtimeId, nodeVersion: selectedNode.version,
  packageManager: 'pnpm', packageManagerSource: 'default',
  customCommands: [{ id: 'install', name: '安装依赖', command: 'pnpm install', builtinId: 'install_dependencies' }],
};
await storeImplementation.runCustomCommand(project, 'install');
assert.equal(calls.length, 1);
assert.equal(calls[0][3], `${canonicalPmCommand} install`, '内置安装必须使用真实 CLI，不执行旧 pnpm shim');
assert.equal(calls[0][4], selectedNode.path, '项目 Node 必须传给后端');
assert.equal(calls[0][5], defaultNode.path, '显式 PM 来源必须传给后端');
assert.equal(sessions.value[latestSessionId].nodeVersion, selectedNode.version);

stopDuringPmCheck = true;
pmAvailable = false;
await storeImplementation.runCustomCommand(project, 'install');
assert.equal(calls.length, 1, '预检时已停止的命令不得启动后端');
assert.equal(sessions.value[latestSessionId].status, 'stopped', '迟到的预检失败不能覆盖停止状态');
stopDuringPmCheck = false;
await storeImplementation.runCustomCommand(project, 'install');
assert.equal(calls.length, 1, 'PM 不可用时不得启动命令');
assert.equal(sessions.value[latestSessionId].status, 'failed');
pmAvailable = true;
await storeImplementation.runCustomCommand({
  ...project, nodeRuntimeId: 'missing', nodeVersion: 'v18.0.0',
}, 'install');
assert.equal(calls.length, 1, '显式绑定的 Runtime 不可用时不能回退到系统 Node');
await storeImplementation.runCustomCommand({
  ...project, type: 'go', customCommands: [{ id: 'test', name: 'test', command: 'go test ./...' }],
}, 'test');
assert.equal(calls.length, 2);
assert.equal(calls[1][3], 'go test ./...', '非 Node 自定义命令必须原样执行');
assert.equal(calls[1][4], '', '非 Node 项目不能注入 Node 环境');

/***********************插件真实 PATH 与 spawn 参数*********************/
const helperNames = [
  'ensureNodeExeInDir',
  'resolveTerminalNodeDir',
  'dirHasNodeTools',
  'normalizePathStr',
  'filterPathEntries',
  'buildCommandEnv',
  'resolvePmCli',
];
const helpers = helperNames.map(name => functionSource(preload, name)).join('\n');
const pluginCommand = findNode(preload, node =>
  ts.isPropertyAssignment(node) && node.name.getText() === 'runCustomCommand',
).getText();
const pluginPmResolver = findNode(preload, node =>
  ts.isPropertyAssignment(node) && node.name.getText() === 'resolvePackageManager',
).getText();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-custom-env-'));

try {
  const projectNode = path.join(temporaryRoot, 'project node');
  const staleNode = path.join(temporaryRoot, 'old-node20');
  const pmNode = path.join(temporaryRoot, 'default node');
  const tools = path.join(temporaryRoot, 'tools');
  for (const directory of [projectNode, staleNode, pmNode, tools]) fs.mkdirSync(directory);
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const pmName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  for (const directory of [projectNode, staleNode, pmNode]) {
    fs.writeFileSync(path.join(directory, nodeName), '');
  }
  // 旧 shim 存在但其 Corepack 目标缺失，模拟用户日志中的残留入口。
  fs.writeFileSync(path.join(staleNode, pmName), 'missing corepack/dist/pnpm.js');
  fs.writeFileSync(path.join(pmNode, pmName), '');
  fs.writeFileSync(path.join(tools, 'git.exe'), '');
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const originalPath = [staleNode, projectNode, pmNode, tools].join(path.delimiter);
  const inheritedEnv = { [pathKey]: originalPath, CUSTOM_ENV: 'preserved' };
  const spawnFailure = new Error('spawn intercepted');
  let spawnOptions: { env: Record<string, string>; cwd: string; shell: boolean } | undefined;
  const context = {
    fs,
    path,
    process: { platform: process.platform, env: inheritedEnv },
    processes: new Map(),
    spawn: (_command: string, options: typeof spawnOptions) => {
      spawnOptions = options;
      throw spawnFailure;
    },
  };
  const implementation = runInNewContext(
    `${helpers}\n({ buildCommandEnv, resolvePmCli, ...({${pluginCommand}, ${pluginPmResolver}}) })`,
    context,
  );
  const env = implementation.buildCommandEnv(path.join(projectNode, nodeName), pmNode);
  assert.deepEqual(
    env[pathKey].split(path.delimiter),
    [projectNode, pmNode, tools],
    '只保留项目 Node、显式 PM 来源与普通工具，不能回退到旧 Corepack shim',
  );
  assert.equal(env.CUSTOM_ENV, 'preserved');
  assert.equal(inheritedEnv[pathKey], originalPath, '不得修改宿主进程环境');
  assert.equal(
    implementation.buildCommandEnv(projectNode, projectNode)[pathKey],
    [projectNode, tools].join(path.delimiter),
    '相同的 Node/PM 目录不能重复注入',
  );
  assert.equal(
    implementation.buildCommandEnv('', '')[pathKey],
    originalPath,
    '非 Node 项目应保留原有环境',
  );
  await assert.rejects(
    implementation.runCustomCommand('project:custom:install', 'run_test', '/project', 'pnpm install', projectNode, pmNode),
    error => error === spawnFailure,
  );
  assert(spawnOptions);
  assert.equal(spawnOptions.env[pathKey], env[pathKey], '实际 spawn 必须使用解析后的环境');
  assert.equal(spawnOptions.cwd, '/project');
  assert.equal(spawnOptions.shell, true, '保留自定义 shell 命令语义');

  const corepackDir = path.join(pmNode, 'node_modules', 'corepack');
  const corepackCli = path.join(corepackDir, 'dist', 'pnpm.js');
  fs.mkdirSync(path.dirname(corepackCli), { recursive: true });
  fs.writeFileSync(corepackCli, '');
  fs.writeFileSync(path.join(corepackDir, 'package.json'), JSON.stringify({ bin: { pnpm: 'dist/pnpm.js' } }));
  const result = await implementation.resolvePackageManager(projectNode, pmNode, 'pnpm', 'default');
  assert.equal(result.available, true);
  assert.equal(
    result.commandPath,
    `"${path.join(projectNode, nodeName)}" "${corepackCli}"`,
    '不能调用残留的 pnpm.cmd；借用默认 PM 时也必须使用项目 Node',
  );
  const pnpmDir = path.join(pmNode, 'node_modules', 'pnpm');
  fs.mkdirSync(path.join(pnpmDir, 'bin'), { recursive: true });
  const pnpmCli = path.join(pnpmDir, 'bin', 'pnpm.cjs');
  fs.writeFileSync(pnpmCli, '');
  fs.writeFileSync(path.join(pnpmDir, 'package.json'), JSON.stringify({ bin: { pnpm: 'bin/pnpm.cjs' } }));
  assert.equal(implementation.resolvePmCli(pmNode, 'pnpm'), pnpmCli, '独立安装的 pnpm 应优先于 Corepack');
  fs.rmSync(pnpmCli);
  assert.equal(implementation.resolvePmCli(pmNode, 'pnpm'), corepackCli, '忽略 bin 元数据中不存在的文件');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('custom command Node environment tests passed');
