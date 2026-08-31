import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getRuntimeListMode } from '../src/utils/nodeRuntimeLayout';

assert.equal(getRuntimeListMode(1200), 'table');
assert.equal(getRuntimeListMode(1050), 'table');
assert.equal(getRuntimeListMode(1049), 'compact-table');
assert.equal(getRuntimeListMode(760), 'compact-table');
assert.equal(getRuntimeListMode(759), 'card');
assert.equal(getRuntimeListMode(0), 'card');

const nodeManager = readFileSync(resolve(process.cwd(), 'src/views/NodeManager.vue'), 'utf8');
assert.match(nodeManager, /new ResizeObserver/);
assert.match(nodeManager, /runtimeListMode !== 'card'/);
assert.match(nodeManager, /runtime-card-list/);
assert.match(nodeManager, /row\.effectiveRuntime\.source/);
assert.match(nodeManager, /runtime-table-actions[\s\S]*flex-wrap: nowrap/);
assert.match(nodeManager, /runtime-card__actions[\s\S]*flex-wrap: nowrap/);
assert.match(nodeManager, /@container \(max-width: 1100px\)/);
assert.match(nodeManager, /@container \(max-width: 700px\)/);

console.log('nodeRuntimeResponsive tests passed');
