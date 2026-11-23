import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import type { Project } from '../src/types.ts';
import {
  expandAllProjects,
  collapseAllProjects,
  isAllProjectsExpanded,
  isProjectTreeExpanded,
  resolveExpandedProjectIds,
} from '../src/utils/projectTreeView.ts';

// TauriAdapter mock
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 1,
      invoke: () => Promise.resolve(),
    },
  },
});

const root = process.cwd();
const zhLocale = readFileSync(resolve(root, 'src/locales/zh.ts'), 'utf8');
const enLocale = readFileSync(resolve(root, 'src/locales/en.ts'), 'utf8');
const dashboardSource = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const candidateTreeSource = readFileSync(resolve(root, 'src/components/ScanCandidateTree.vue'), 'utf8');

/*********************** 1. 语言包与静态模板检查 ***********************/

assert(zhLocale.includes("expandAll: '全部展开'"), 'zh.ts 应包含 expandAll');
assert(zhLocale.includes("collapseAll: '全部折叠'"), 'zh.ts 应包含 collapseAll');
assert(enLocale.includes("expandAll: 'Expand All'"), 'en.ts 应包含 expandAll');
assert(enLocale.includes("collapseAll: 'Collapse All'"), 'en.ts 应包含 collapseAll');

assert(
  dashboardSource.includes('toggleExpandAll') && dashboardSource.includes('isAllTreeExpanded'),
  'Dashboard.vue 应包含一键展开/折叠全部列表的按钮与逻辑',
);

assert(
  /\.toolbar-text-btn\s*\{[^}]*white-space:\s*nowrap;[^}]*flex-shrink:\s*0;/.test(dashboardSource),
  'toolbar-text-btn 应设置 white-space: nowrap 和 flex-shrink: 0 避免工具栏文字换行',
);

assert(
  /class="[^"]*whitespace-nowrap[^"]*shrink-0[^"]*"[^>]*>\s*\{\{\s*t\('dashboard\.sortMode'\)\s*\}\}/.test(dashboardSource),
  '排序方式文本应具有 whitespace-nowrap 和 shrink-0，避免最小宽度下换行',
);

assert(
  dashboardSource.includes('rootUsageWeights'),
  'Dashboard.vue 应包含汇聚一级项目最近使用权重的计算',
);

/*********************** 2. 候选树（ScanCandidateTree）缩进与子级指示符检查 ***********************/

assert(
  candidateTreeSource.includes('i-mdi-subdirectory-arrow-right'),
  'ScanCandidateTree.vue 应为子级项目渲染直观的层级分支箭头指示符',
);

assert(
  candidateTreeSource.includes('28px') || candidateTreeSource.includes('(depth || 0) * 28'),
  'ScanCandidateTree.vue 应增大层级缩进间距（每层至少 28px），确保子级比父级明显往后显示',
);

/*********************** 3. 树展开/折叠全部工具函数测试 ***********************/

const state = {
  expandedIds: new Set(['root-1']),
  collapsedIds: new Set<string>(),
  autoExpandedIds: new Set(['root-2']),
};

const targetParents = ['root-1', 'root-2', 'root-3'];

// 初始状态：root-1 和 root-2 展开，root-3 未展开
assert.equal(isAllProjectsExpanded(state, targetParents), false, '并非全部展开时应返回 false');

// 批量全部展开
const expandedAll = expandAllProjects(state, targetParents);
const expandedState = {
  expandedIds: expandedAll.expandedIds,
  collapsedIds: expandedAll.collapsedIds,
  autoExpandedIds: state.autoExpandedIds,
};
assert.equal(isAllProjectsExpanded(expandedState, targetParents), true, '全部展开后应返回 true');
assert.equal(isProjectTreeExpanded(expandedState, 'root-3'), true);

// 批量全部折叠
const collapsedAll = collapseAllProjects(expandedState, targetParents);
const collapsedState = {
  expandedIds: collapsedAll.expandedIds,
  collapsedIds: collapsedAll.collapsedIds,
  autoExpandedIds: state.autoExpandedIds,
};
assert.equal(isAllProjectsExpanded(collapsedState, targetParents), false, '全部折叠后应返回 false');
assert.equal(isProjectTreeExpanded(collapsedState, 'root-1'), false);
assert.equal(isProjectTreeExpanded(collapsedState, 'root-2'), false);
assert.equal(isProjectTreeExpanded(collapsedState, 'root-3'), false);
assert.equal(resolveExpandedProjectIds(collapsedState).size, 0, '全部折叠后有效展开集合应为空');

/*********************** 4. 最近使用统计与一级项目汇聚测试 ***********************/

const { useProjectStore } = await import('../src/stores/project.ts');
const { useUsageStore } = await import('../src/stores/usage.ts');

setActivePinia(createPinia());
const projectStore = useProjectStore();
const usageStore = useUsageStore();

const rootProj: Project = { id: 'root-proj', name: 'Root Project', path: 'C:/root', type: 'node' };
const subProj1: Project = { id: 'sub-proj-1', parentId: 'root-proj', name: 'Sub 1', path: 'C:/root/sub1', type: 'node' };
const subProj2: Project = { id: 'sub-proj-2', parentId: 'root-proj', name: 'Sub 2', path: 'C:/root/sub2', type: 'node' };
const otherRoot: Project = { id: 'other-root', name: 'Other Root', path: 'C:/other', type: 'node' };

projectStore.projects = [rootProj, subProj1, subProj2, otherRoot];

// 当子项目产生使用记录时，应统计到一级项目
const rootId = projectStore.getRootProjectId(subProj1.id);
assert.equal(rootId, 'root-proj', '子项目的根项目 id 应正确解析为一级项目');

usageStore.recordUsage(rootId);
assert(usageStore.getWeight('root-proj') > 0, '一级项目应具有使用权重');
assert.equal(usageStore.getWeight('other-root'), 0, '未使用的项目权重应为 0');

console.log('dashboardTreeRecentAndCandidateHierarchy tests passed');
