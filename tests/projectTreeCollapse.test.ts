import assert from 'node:assert/strict';
import {
  isProjectTreeExpanded,
  resolveExpandedProjectIds,
  toggleProjectTreeExpansion,
  type ProjectTreeExpansionInput,
} from '../src/utils/projectTreeView.ts';

function createState(overrides: Partial<{
  expandedIds: string[];
  collapsedIds: string[];
  autoExpandedIds: string[];
}> = {}): ProjectTreeExpansionInput {
  return {
    expandedIds: new Set(overrides.expandedIds ?? []),
    collapsedIds: new Set(overrides.collapsedIds ?? []),
    autoExpandedIds: new Set(overrides.autoExpandedIds ?? []),
  };
}

const sorted = (ids: Iterable<string>) => [...ids].sort();

/*********************** 筛选态：手动折叠要能压过自动展开 ***********************/
// 「最近使用」筛选命中子项目时，父项目会被自动展开
const filtering = createState({ autoExpandedIds: ['root'] });

assert.equal(isProjectTreeExpanded(filtering, 'root'), true);
assert.deepEqual(sorted(resolveExpandedProjectIds(filtering)), ['root']);

const collapsed = toggleProjectTreeExpansion(filtering, 'root');
assert.deepEqual(sorted(collapsed.collapsedIds), ['root'], '折叠应记录到手动折叠集合');
assert.equal(
  resolveExpandedProjectIds({
    expandedIds: collapsed.expandedIds,
    collapsedIds: collapsed.collapsedIds,
    autoExpandedIds: filtering.autoExpandedIds,
  }).size,
  0,
  '自动展开必须被手动折叠抵消，否则层级关不掉',
);

// 已折叠的节点上再点一次应恢复展开
const reopened = toggleProjectTreeExpansion({
  expandedIds: collapsed.expandedIds,
  collapsedIds: collapsed.collapsedIds,
  autoExpandedIds: filtering.autoExpandedIds,
}, 'root');
assert.deepEqual(sorted(reopened.expandedIds), ['root']);
assert.equal(reopened.collapsedIds.size, 0);

/*********************** 普通态：仍按用户展开集合工作 ***********************/
const plain = createState({ expandedIds: ['root'] });
const plainCollapsed = toggleProjectTreeExpansion(plain, 'root');
assert.equal(plainCollapsed.expandedIds.size, 0);
assert.deepEqual(sorted(plainCollapsed.collapsedIds), ['root']);

const plainReopened = toggleProjectTreeExpansion(plainCollapsed, 'root');
assert.deepEqual(sorted(plainReopened.expandedIds), ['root']);
assert.equal(plainReopened.collapsedIds.size, 0);

// 手动展开同时清掉遗留的折叠标记
const staleCollapsed = createState({ collapsedIds: ['root'] });
assert.equal(isProjectTreeExpanded(staleCollapsed, 'root'), false);
const revived = toggleProjectTreeExpansion(staleCollapsed, 'root');
assert.deepEqual(sorted(revived.expandedIds), ['root']);
assert.equal(revived.collapsedIds.size, 0);

/*********************** 只影响目标节点 ***********************/
const multi = createState({ expandedIds: ['a'], autoExpandedIds: ['b'] });
const afterToggle = toggleProjectTreeExpansion(multi, 'b');
assert.deepEqual(sorted(afterToggle.expandedIds), ['a']);
assert.deepEqual(sorted(afterToggle.collapsedIds), ['b']);
assert.deepEqual(sorted(resolveExpandedProjectIds({
  expandedIds: afterToggle.expandedIds,
  collapsedIds: afterToggle.collapsedIds,
  autoExpandedIds: multi.autoExpandedIds,
})), ['a']);

console.log('projectTreeCollapse tests passed');
