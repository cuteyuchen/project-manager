/**
 * 打开终端时的 Node/包管理器注入行为。
 *
 * 三处实现必须保持一致：useProjectExternalActions.ts（决定传什么）、
 * src-tauri/src/runner.rs（Tauri 端拼命令）、utools|ztools/preload.js（插件端镜像）。
 * Rust 侧的分支逻辑另有 cargo 单测覆盖，这里守住前端契约与插件镜像不跑偏。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const projectListItem = readFileSync(resolve(root, 'src/components/ProjectListItem.vue'), 'utf8');
const externalActions = readFileSync(resolve(root, 'src/composables/useProjectExternalActions.ts'), 'utf8');
const runner = readFileSync(resolve(root, 'src-tauri/src/runner.rs'), 'utf8');
const utoolsPreload = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');
const ztoolsPreload = readFileSync(resolve(root, 'ztools/preload.js'), 'utf8');

/***********************前端：非 node 项目传空包管理器*********************/

assert(
  /packageManager: project\.type === 'node'\s*\?\s*\(project\.packageManager \|\| 'npm'\)\s*:\s*''/.test(externalActions),
  '非 node 项目打开终端时应传空包管理器，不注入 node/npm 版本',
);

// nodePath 的解析本就包在 type === 'node' 分支里，非 node 项目自然拿到空串
const openTerminalBody = externalActions.slice(
  externalActions.indexOf('async function resolveTerminalOptions'),
  externalActions.indexOf('async function openTerminal'),
);
assert(
  /if \(project\.type === 'node'\) \{[\s\S]*nodePath = resolveProjectNodePath/.test(openTerminalBody),
  '非 node 项目不应解析 nodePath，否则仍会往 PATH 里注入 Node 目录',
);

assert(projectListItem.includes('useProjectExternalActions'), '项目行应复用共享外部打开能力');

/***********************Rust：空包管理器不产出启动脚本*********************/

assert(
  /fn build_startup_check[\s\S]{0,600}?if pm\.is_empty\(\) \{\s*return String::new\(\);/.test(runner),
  'Rust 侧空包管理器应返回空启动脚本，而不是回退到 `node -v`',
);

assert(
  /fn join_shell_commands/.test(runner),
  'Rust 侧需要 join_shell_commands 跳过空片段，避免悬空的 `&&` / `;`',
);

// 启动脚本为空时若仍用模板直接拼接，会产出 `cd /d "..." && ` 这种语法错误
assert(
  !/format!\("cd \/d \\"\{\}\\" && \{\}"/.test(runner),
  'Rust 侧不应再用模板直接拼接启动脚本，空脚本会留下悬空的 `&&`',
);

/***********************插件镜像：与 Rust 行为一致*********************/

for (const [name, source] of [
  ['utools/preload.js', utoolsPreload],
  ['ztools/preload.js', ztoolsPreload],
] as const) {
  assert(
    /function buildStartupCheck[\s\S]{0,400}?if \(!pm\) return '';/.test(source),
    `${name} 空包管理器应返回空启动脚本，与 Rust 实现一致`,
  );
  assert(
    /function joinShellCommands/.test(source),
    `${name} 需要 joinShellCommands 跳过空片段`,
  );
  assert(
    !/`\$\{startupCheckBash\}; exec bash`/.test(source),
    `${name} 不应再用模板直接拼接 bash 启动命令，空脚本会留下悬空的分号`,
  );
}

assert.equal(
  utoolsPreload,
  ztoolsPreload,
  '两个插件 preload 必须逐字节一致，否则两个 target 行为会分叉',
);

console.log('terminal node injection tests passed');
