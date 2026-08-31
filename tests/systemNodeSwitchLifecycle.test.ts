import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const rust = read('src-tauri/src/system_node.rs');
const store = read('src/stores/node.ts');
const nodeManager = read('src/views/NodeManager.vue');

assert.match(rust, /pub async fn switch_system_node\(/, 'system switching should yield off the Tauri command thread');
assert.match(
  rust,
  /spawn_blocking\(move \|\| switch_system_node_blocking\(app, runtime, options\)\)/,
  'blocking registry/process work should run in a blocking worker',
);
assert.match(rust, /fn switch_system_node_blocking\(/);
assert.match(rust, /ELEVATED_OPERATION_TIMEOUT_MS: u32 = 45_000/);
assert.match(rust, /WaitForSingleObject\(info\.hProcess, ELEVATED_OPERATION_TIMEOUT_MS\)/);
assert.match(rust, /TerminateProcess\(info\.hProcess, 1\)/);
assert.match(rust, /elevated_operation_timeout/);

const switchBody = store.slice(
  store.indexOf('const switchSystemNode ='),
  store.indexOf('function applyProgress'),
);
assert.match(switchBody, /if \(result\.current\) applySystemNodeState\(result\.current\)/);
assert.match(switchBody, /finally \{\s*systemNodeSwitching\.value = false;/);
assert.doesNotMatch(switchBody, /loadRuntimes\(/, 'the switch action should not block on a full registry reload');
assert.match(store, /const refreshRuntimeRegistryAfterSystemSwitch = async/);
assert.match(store, /await refreshNvmRuntimes\(\{ throwOnError: true \}\)/);
assert.match(store, /await refreshSystemNode\(\{ throwOnError: true \}\)/);
assert.match(
  nodeManager,
  /void nodeStore\.refreshRuntimeRegistryAfterSystemSwitch\(\)\.catch\(/,
  'registry refresh failures should be reported separately after a successful switch',
);

console.log('systemNodeSwitchLifecycle tests passed');
