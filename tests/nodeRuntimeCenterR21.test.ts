import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const rust = readFileSync(resolve(root, 'src-tauri/src/node_runtime.rs'), 'utf8');
const nodeManager = readFileSync(resolve(root, 'src/views/NodeManager.vue'), 'utf8');
const nodeStore = readFileSync(resolve(root, 'src/stores/node.ts'), 'utf8');
const apiTypes = readFileSync(resolve(root, 'src/api/types.ts'), 'utf8');
const tauriAdapter = readFileSync(resolve(root, 'src/api/adapters/tauri.ts'), 'utf8');
const app = readFileSync(resolve(root, 'src/App.vue'), 'utf8');

assert(rust.includes('fn resolve_managed_runtime_root('), 'all managed operations need one formal root resolver');
assert(rust.includes('run_node_runtime_task'), 'filesystem-heavy runtime work should run off the async executor');
assert(rust.includes('directory_size_stats'), 'managed usage must use real recursive directory statistics');
assert(rust.includes('pub size_status: String'), 'the backend must report size calculation state');
assert(rust.includes('pub async fn open_managed_node_runtime_root'), 'opening the managed root needs a dedicated command');
for (const phase of ['Prepare', 'Scan', 'Copy', 'Verify', 'Switch', 'Cleanup', 'Complete']) {
  assert(rust.includes(`Self::${phase}`), `migration state machine should include ${phase}`);
}
assert(rust.includes('迁移成功，但旧文件未完全删除'), 'cleanup failure must remain a post-success warning');
const switchOnlyIndex = rust.indexOf('if !migrate');
const scanIndex = rust.indexOf('let installed = runtime_directory_entries(&old_root)');
assert(switchOnlyIndex >= 0 && switchOnlyIndex < scanIndex, 'switch-only mode must save and return before scanning old runtimes');
assert(rust.includes('portable_available'), 'Portable mode must expose an explicit writable capability check');

assert(nodeManager.includes('width="420px"'), 'usage dialog width should be 420px');
assert(nodeManager.includes('max-height: 70vh'), 'usage dialog should cap its height');
assert(nodeManager.includes('usageSearchQuery'), 'usage dialog should support search');
assert(nodeManager.includes('emit(\'navigateProject\''), 'usage entries should navigate to the selected project');
assert(nodeManager.includes('runtimeGroups'), 'runtime rows should be grouped by version');
assert(nodeManager.includes('openManagedRuntimeRoot'), 'managed root should use the dedicated open command');

assert(apiTypes.includes('openManagedNodeRuntimeRoot(): Promise<void>'), 'PlatformAPI must expose managed root opening');
assert(tauriAdapter.includes("invoke('open_managed_node_runtime_root')"), 'Tauri adapter must call the managed root command');
const setDefaultStart = nodeStore.indexOf('const setAppDefaultNode = async');
const setDefaultEnd = nodeStore.indexOf('/** 验证 Runtime', setDefaultStart);
const setDefaultBody = nodeStore.slice(setDefaultStart, setDefaultEnd);
assert(setDefaultBody.includes('await api.getNodeVersion'), 'default Node changes must validate the selected runtime');
assert(setDefaultBody.includes('await flushPendingSave()'), 'default Node changes must persist before reloading');
assert(setDefaultBody.includes('await loadRuntimes();'), 'default Node changes must reload the runtime registry');
assert(setDefaultBody.indexOf('await flushPendingSave()') < setDefaultBody.indexOf('await loadRuntimes();'), 'default Node persistence must precede registry reload');
assert(app.includes('@navigate-project="activateQuickSearchSelection"'), 'App must bridge usage clicks into Dashboard navigation');

console.log('nodeRuntimeCenterR21 tests passed');
