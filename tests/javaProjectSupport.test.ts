import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  resolveJavaBuildExecutable,
  buildJavaCommand,
  buildJavaPresetCommands,
  getCustomCommandDisplayName,
  MAVEN_COMMAND_PRESETS,
  GRADLE_COMMAND_PRESETS,
} from '../src/utils/projectCommands.ts';
import { flattenImportNodeTree } from '../src/utils/importProjectTree.ts';
import type { ImportNode } from '../src/api/types.ts';

/***********************构建工具可执行文件解析*********************/
// 有 wrapper 就用 wrapper：它锁定构建工具版本，也免去「本机没装」的问题

// Maven
assert.equal(resolveJavaBuildExecutable('maven', true, true), 'mvnw.cmd', 'Windows 下 Maven wrapper 是 .cmd');
assert.equal(resolveJavaBuildExecutable('maven', true, false), './mvnw', '类 Unix 下需要 ./ 前缀');
assert.equal(resolveJavaBuildExecutable('maven', false, true), 'mvn', '无 wrapper 时回落到全局 mvn');
assert.equal(resolveJavaBuildExecutable('maven', false, false), 'mvn');

// Gradle
assert.equal(resolveJavaBuildExecutable('gradle', true, true), 'gradlew.bat', 'Windows 下 Gradle wrapper 是 .bat');
assert.equal(resolveJavaBuildExecutable('gradle', true, false), './gradlew');
assert.equal(resolveJavaBuildExecutable('gradle', false, true), 'gradle');

/***********************命令拼装*********************/

assert.equal(
  buildJavaCommand('maven', true, true, 'spring-boot:run'),
  'mvnw.cmd spring-boot:run',
);
assert.equal(
  buildJavaCommand('gradle', true, false, 'bootRun'),
  './gradlew bootRun',
);
assert.equal(
  buildJavaCommand('maven', false, false, 'clean package -DskipTests'),
  'mvn clean package -DskipTests',
);
assert.equal(buildJavaCommand('maven', false, false, ''), 'mvn', '空参数不该留下尾随空格');

/***********************预设命令*********************/

{
  const commands = buildJavaPresetCommands('maven', true, true, () => 'fixed-id');
  assert.equal(commands.length, MAVEN_COMMAND_PRESETS.length);
  assert.deepEqual(
    commands.map(c => c.command),
    ['mvnw.cmd spring-boot:run', 'mvnw.cmd clean package -DskipTests', 'mvnw.cmd test'],
  );
  assert.deepEqual(
    commands.map(c => c.builtinId),
    ['java_run', 'java_package', 'java_test'],
    '显示名靠 builtinId 在渲染时翻译，不把语言写死进数据',
  );
  assert(commands.every(c => c.id === 'fixed-id'), 'id 由调用方注入，便于测试与去重');
}

{
  const commands = buildJavaPresetCommands('gradle', false, false, () => 'x');
  assert.equal(commands.length, GRADLE_COMMAND_PRESETS.length);
  assert.deepEqual(
    commands.map(c => c.command),
    ['gradle bootRun', 'gradle build -x test', 'gradle test'],
  );
}

/***********************显示名按当前语言翻译*********************/

assert.equal(
  getCustomCommandDisplayName({ name: 'java_run', builtinId: 'java_run' }, key => `T:${key}`),
  'T:project.javaCommand.run',
  'Java 预设命令的显示名应走 i18n',
);
assert.equal(
  getCustomCommandDisplayName({ name: '我改过的名字' }, key => `T:${key}`),
  '我改过的名字',
  '用户自建命令的名字不该被翻译层改掉',
);

// 打包默认跳过测试：首次编译跑全量测试往往要等很久
assert(
  MAVEN_COMMAND_PRESETS.some(p => p.args.includes('-DskipTests')),
  'Maven 打包预设应跳过测试',
);
assert(
  GRADLE_COMMAND_PRESETS.some(p => p.args.includes('-x test')),
  'Gradle 打包预设应跳过测试',
);

/***********************扫描导入的 Java 子项目也要拿到命令*********************/
// monorepo（前端 + Java 后端）里的后端模块走的是子项目扫描这条路径，
// 而不是单个添加。这里原先会被映射成 type: 'other'，
// 于是没有构建工具、没有命令，「命令」页签整个不渲染。

function importNode(overrides: Partial<ImportNode> & { name: string; path: string; kind: string }): ImportNode {
  return {
    framework: undefined,
    hasGit: false,
    hasPackageJson: false,
    scripts: [],
    children: [],
    ...overrides,
  } as ImportNode;
}

{
  let seq = 0;
  const projects = flattenImportNodeTree(
    [
      importNode({
        name: 'MyRepo',
        path: '/repo',
        kind: 'unknown',
        children: [
          importNode({ name: 'web', path: '/repo/web', kind: 'frontend', hasPackageJson: true, scripts: ['dev'] }),
          importNode({
            name: 'api',
            path: '/repo/api',
            kind: 'backend',
            framework: 'Spring Boot',
            buildTool: 'maven',
            hasWrapper: true,
          }),
        ],
      }),
    ],
    undefined,
    { createId: () => `id-${seq++}` },
  );

  const api = projects.find(p => p.name === 'api');
  assert(api, '后端模块应被导入');
  assert.equal(api!.type, 'java', '带构建工具的后端模块应建成 java 项目，而不是 other');
  assert.equal(api!.buildTool, 'maven');
  assert.equal(api!.hasWrapper, true);
  assert.equal(
    api!.customCommands?.length,
    MAVEN_COMMAND_PRESETS.length,
    '扫描导入的 Java 模块必须预置构建命令，否则「命令」页签不渲染',
  );
  assert(
    api!.customCommands?.every(c => c.builtinId?.startsWith('java_')),
    '预设命令应带 builtinId 以便按语言显示',
  );

  const web = projects.find(p => p.name === 'web');
  assert.equal(web!.type, 'node', '前端模块不该被误判成 java');
  assert.equal(web!.customCommands, undefined, '非 Java 模块不该被塞入 Java 命令');
}

// 没有构建工具的后端模块（例如只识别到 kind 但目录里没有 pom/gradle）仍回落 other
{
  const projects = flattenImportNodeTree(
    [importNode({ name: 'svc', path: '/svc', kind: 'backend' })],
    undefined,
    { createId: () => 'x' },
  );
  assert.equal(projects[0].type, 'other', '没有构建工具时不该硬认成 java');
}

/***********************后端与插件侧的识别必须一致*********************/

const root = process.cwd();
const projectRs = readFileSync(resolve(root, 'src-tauri/src/project.rs'), 'utf8');
const utoolsPreload = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');
const ztoolsPreload = readFileSync(resolve(root, 'ztools/preload.js'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');
const settingsView = readFileSync(resolve(root, 'src/views/Settings.vue'), 'utf8');

for (const [name, source] of [
  ['project.rs', projectRs],
  ['utools/preload.js', utoolsPreload],
  ['ztools/preload.js', ztoolsPreload],
] as const) {
  // 多模块仓库的根目录可能只有 settings.gradle 没有 build.gradle，
  // 漏掉它会整个仓库根都识别不出来
  assert(
    source.includes('settings.gradle'),
    `${name} 的 Gradle 识别必须包含 settings.gradle，否则多模块仓库根扫不出来`,
  );
  // 所有带 pom.xml 的项目都被标成 Spring Boot 是错的
  assert(
    source.includes('spring-boot'),
    `${name} 应检查 pom.xml 内容再决定是否报 Spring Boot`,
  );
  assert(
    /projectType: 'java'|project_type: "java"/.test(source),
    `${name} 必须能返回 java 项目类型，否则「命令」页签不渲染`,
  );
  assert(
    /hasWrapper|has_wrapper/.test(source),
    `${name} 必须返回 wrapper 检测结果`,
  );
}

// 两个插件 preload 必须保持同源，否则 uTools 与 ZTools 行为会分叉
assert.equal(
  utoolsPreload.length,
  ztoolsPreload.length,
  'utools 与 ztools 的 preload.js 应保持同步',
);

assert(
  /info\.projectType === 'java' \? 'java'/.test(app)
  && /buildJavaPresetCommands/.test(app),
  '直接拖拽目录导入 Java 项目时必须保留 java 类型并生成预设命令',
);
assert(
  /project\.type === 'java' \? 'java'/.test(settingsView)
  && /buildTool: project\.buildTool/.test(settingsView),
  '备份导入不能把 Java 项目误归成 Node，且必须保留构建工具信息',
);

/***********************Java 不该被注入 Node 环境*********************/

const projectStore = readFileSync(resolve(root, 'src/stores/project.ts'), 'utf8');
assert(
  /if \(project\.type !== 'node' \|\| !project\.packageManager\)/.test(projectStore),
  '包管理器解析应对非 node 项目直接放行，不要给 Java 项目做 PM 检查',
);
assert(
  /p\.type === 'java' && info\.buildTool/.test(projectStore),
  '刷新项目时应更新 Java 的构建工具与 wrapper 状态',
);

console.log('javaProjectSupport tests passed');
