import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const store = read('src/stores/node.ts');
const runner = read('src-tauri/src/runner.rs');
const nodeManager = read('src/views/NodeManager.vue');

const plainTerminalBody = store.slice(
  store.indexOf('const openSystemTerminal ='),
  store.indexOf('return {', store.indexOf('const openSystemTerminal =')),
);
assert.match(plainTerminalBody, /api\.getHomeDirectory\(\)/);
assert.match(
  plainTerminalBody,
  /api\.openInTerminal\(home \|\| '\.', terminal, '', ''\)/,
  'a plain terminal must not inject a project Node or package manager',
);
assert.match(nodeManager, /@click="openPlainTerminal"/);
assert.match(nodeManager, /t\('nodes\.openSystemTerminal'\)/);

const terminalPathBody = runner.slice(
  runner.indexOf('fn build_terminal_path_env'),
  runner.indexOf('#[cfg(target_os = "windows")]\nfn escape_for_cmd_double_quotes'),
);
assert.match(terminalPathBody, /let current_path = system_node::latest_effective_path\(\)/);
assert.match(
  terminalPathBody,
  /if node_dir\.is_none\(\) \{\s*return \(!current_path\.trim\(\)\.is_empty\(\)\)\.then_some\(current_path\);/,
  'a terminal without project injection should use the latest effective system PATH',
);

console.log('nodeRuntimePlainTerminal tests passed');
