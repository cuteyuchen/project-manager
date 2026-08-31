import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const rust = read('src-tauri/src/system_node.rs');
const store = read('src/stores/node.ts');
const nodeManager = read('src/views/NodeManager.vue');
const apiTypes = read('src/api/types.ts');
const tauriAdapter = read('src/api/adapters/tauri.ts');
const runner = read('src-tauri/src/runner.rs');

assert.match(rust, /where\.exe/);
assert.match(rust, /command\.arg\("-v"\)/);
assert.match(rust, /Command::new\(nvm_executable\)/);
assert.match(rust, /args\(\["use", version\]\)/);
assert.match(rust, /ShellExecuteExW/);
assert.match(rust, /"runas"/);
assert.match(rust, /WM_SETTINGCHANGE/);
assert.match(rust, /write_user_path/);
assert.match(rust, /write_machine_path/);
assert.match(rust, /machine_path_conflict/);
assert.match(rust, /--elevated-node-operation/);

assert.match(store, /systemNodeState/);
assert.match(store, /refreshSystemNode/);
assert.match(store, /switchSystemNode/);
assert.match(store, /systemNodeSwitchSupported/);
assert.match(nodeManager, /systemCurrentNode/);
assert.match(nodeManager, /setSystemNode/);
assert.match(nodeManager, /chooseRuntimeTitle/);
assert.match(nodeManager, /elevationRequiredMessage/);
assert.match(nodeManager, /repairPathPriority/);
assert.match(nodeManager, /\{ \.\.\.options, repairPathPriority: true \}/);
assert.match(nodeManager, /groupCanSetAppDefault/);
assert.match(nodeManager, /groupCanSetSystemNode/);

assert.match(apiTypes, /getSystemNodeState\(\): Promise<SystemNodeState>/);
assert.match(apiTypes, /switchSystemNode\(runtime: NodeVersion/);
assert.match(apiTypes, /systemNodeSwitchSupported\(\): Promise<boolean>/);
assert.match(tauriAdapter, /invoke\('get_system_node_state'\)/);
assert.match(tauriAdapter, /invoke\('switch_system_node'/);
assert.match(runner, /system_node::latest_effective_path\(\)/);
assert.match(runner, /"-NoProfile"/);

console.log('systemNodeCenterR22 tests passed');
