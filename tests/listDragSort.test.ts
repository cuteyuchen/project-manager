import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { computeManualOrderAssignments } from '../src/utils/projectTree.ts';

/***********************拖拽后的序号写回*********************/

// 全部未置顶：sortOrder 按新顺序从 0 连续排，且不写 pinOrder
{
  const result = computeManualOrderAssignments([{ id: 'b' }, { id: 'c' }, { id: 'a' }]);
  assert.deepEqual(result, [
    { id: 'b', sortOrder: 0 },
    { id: 'c', sortOrder: 1 },
    { id: 'a', sortOrder: 2 },
  ]);
}

// 置顶项写 pinOrder（用整个列表里的下标），未置顶项的 sortOrder 独立递增。
// 两个字段互不覆盖：取消置顶后还能回到原来的手动位置。
{
  const result = computeManualOrderAssignments([
    { id: 'p1', pinned: true },
    { id: 'p2', pinned: true },
    { id: 'n1' },
    { id: 'n2' },
  ]);
  assert.deepEqual(result, [
    { id: 'p1', pinOrder: 0 },
    { id: 'p2', pinOrder: 1 },
    { id: 'n1', sortOrder: 0 },
    { id: 'n2', sortOrder: 1 },
  ]);
}

// 置顶项不该占用未置顶项的 sortOrder 号段
{
  const result = computeManualOrderAssignments([
    { id: 'pinned', pinned: true },
    { id: 'first' },
  ]);
  assert.equal(result[1].sortOrder, 0, '第一个未置顶项的 sortOrder 应从 0 起算');
  assert.equal(result[1].pinOrder, undefined, '未置顶项不应被写 pinOrder');
  assert.equal(result[0].sortOrder, undefined, '置顶项不应被写 sortOrder');
}

// 空列表不该炸
assert.deepEqual(computeManualOrderAssignments([]), []);

/***********************两个列表共用同一套拖拽约定*********************/

const root = process.cwd();
const dashboard = readFileSync(resolve(root, 'src/views/Dashboard.vue'), 'utf8');
const workspace = readFileSync(resolve(root, 'src/components/dashboard/ProjectWorkspace.vue'), 'utf8');
const treeNode = readFileSync(resolve(root, 'src/components/dashboard/ProjectTreeNode.vue'), 'utf8');
const fileTreeNode = readFileSync(resolve(root, 'src/components/dashboard/FileTreeNode.vue'), 'utf8');
const composable = readFileSync(resolve(root, 'src/composables/useListDragSort.ts'), 'utf8');

assert(
  /useListDragSort/.test(dashboard) && /useListDragSort/.test(treeNode),
  'Dashboard 项目树与其节点应复用 useListDragSort',
);

assert(
  !/function onDragMouseMove/.test(dashboard) && !/function animateReorder/.test(dashboard),
  '拖拽实现应只留在 composable 里，Dashboard 不应残留一份',
);

assert(
  /calculateDraggedItemTranslateY/.test(composable)
  && /calculateDraggedItemCenterY/.test(composable)
  && /calculateFlipTransforms/.test(composable),
  'composable 应复用 utils/dragPosition 的纯函数，不要重新实现位置计算',
);

assert(
  /onBeforeUnmount/.test(composable),
  '拖拽途中组件卸载时必须解绑 document 上的全局监听',
);

assert(
  /WorkspaceProjectExplorer/.test(workspace)
  && !/useListDragSort/.test(workspace)
  && !/draggable/.test(fileTreeNode),
  'R1 Explorer 不承担项目排序，文件行也不能触发项目拖拽',
);

console.log('listDragSort tests passed');
