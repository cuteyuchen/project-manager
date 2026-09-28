import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getRuntimeListMode,
  resolveRuntimeListModeChange,
} from '../src/utils/nodeRuntimeLayout';

assert.equal(getRuntimeListMode(1400), 'table');
assert.equal(getRuntimeListMode(1350), 'table');
assert.equal(getRuntimeListMode(1349), 'compact-table');
assert.equal(getRuntimeListMode(760), 'compact-table');
assert.equal(getRuntimeListMode(759), 'card');
assert.equal(getRuntimeListMode(0), 'card');

/***********************未跨 breakpoint 不重复写 runtimeListMode*********************/
assert.equal(resolveRuntimeListModeChange(1400, 'table'), null);
assert.equal(resolveRuntimeListModeChange(1350, 'table'), null);
assert.equal(resolveRuntimeListModeChange(1349, 'compact-table'), null);
assert.equal(resolveRuntimeListModeChange(760, 'compact-table'), null);
assert.equal(resolveRuntimeListModeChange(759, 'card'), null);
assert.equal(resolveRuntimeListModeChange(0, 'card'), null);

/***********************跨 breakpoint 返回目标模式*********************/
assert.equal(resolveRuntimeListModeChange(1349, 'table'), 'compact-table');
assert.equal(resolveRuntimeListModeChange(1350, 'compact-table'), 'table');
assert.equal(resolveRuntimeListModeChange(759, 'compact-table'), 'card');
assert.equal(resolveRuntimeListModeChange(760, 'card'), 'compact-table');
assert.equal(resolveRuntimeListModeChange(1400, 'card'), 'table');
assert.equal(resolveRuntimeListModeChange(0, 'table'), 'card');

const nodeManager = readFileSync(resolve(process.cwd(), 'src/views/NodeManager.vue'), 'utf8');
assert.match(nodeManager, /new ResizeObserver/);
assert.match(nodeManager, /runtimeListMode !== 'card'/);
assert.match(nodeManager, /runtime-card-list/);
assert.match(nodeManager, /row\.effectiveRuntime\.source/);
assert.match(nodeManager, /runtime-table-actions[\s\S]*flex-wrap: nowrap/);
assert.match(nodeManager, /runtimeListMode === 'table' \? 500 : 190/);
assert.match(nodeManager, /runtime-action-slot--app-default/);
assert.match(nodeManager, /runtime-action-slot--system-node/);
assert.match(nodeManager, /runtime-action-placeholder/);
assert.match(nodeManager, /grid-template-columns: 32px minmax\(190px, 1fr\) 160px 32px 32px/);
assert.match(nodeManager, /runtime-card__actions[\s\S]*flex-wrap: nowrap/);
assert.match(nodeManager, /showRuntimeDetailsDialog/);
assert.match(nodeManager, /runtime-details-item__actions/);
assert.match(nodeManager, /@container \(max-width: 1100px\)/);
assert.match(nodeManager, /@container \(max-width: 700px\)/);

/***********************布局写入调度与清理*********************/
assert.match(nodeManager, /createFrameScheduler/);
assert.match(nodeManager, /runtimeListModeScheduler\.schedule/);
assert.match(nodeManager, /runtimeListModeScheduler\.cancel/);
assert.match(nodeManager, /resolveRuntimeListModeChange/);
assert.match(nodeManager, /runtimeListResizeObserver\?\.disconnect/);

console.log('nodeRuntimeResponsive tests passed');

