import assert from 'node:assert/strict';
import {
  collectAutoExpandedProjectIds,
  collectProjectAncestorIds,
  collectVisibleProjectIds,
  createProjectTreeExpansionState,
  setProjectTreeConstraint,
} from '../src/utils/projectTreeView.ts';

const projects = [
  { id: 'root' },
  { id: 'child', parentId: 'root' },
  { id: 'grandchild', parentId: 'child' },
  { id: 'other' },
];

assert.deepEqual(collectProjectAncestorIds(projects, 'grandchild'), ['root', 'child']);
assert.deepEqual([...collectVisibleProjectIds(projects, ['grandchild'])].sort(), ['child', 'grandchild', 'root']);
assert.deepEqual([...collectAutoExpandedProjectIds(projects, ['grandchild'])].sort(), ['child', 'root']);

const state = createProjectTreeExpansionState(['root']);
setProjectTreeConstraint(state, true);
state.expandedIds.add('child');
assert(state.expandedIds.has('child'), '约束模式仍允许用户临时展开节点');
setProjectTreeConstraint(state, false);
assert.deepEqual([...state.expandedIds], ['root'], '清空搜索/筛选后恢复进入前的手动展开状态');

console.log('projectTreeView tests passed');
