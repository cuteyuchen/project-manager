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
const composable = readFileSync(resolve(root, 'src/composables/useListDragSort.ts'), 'utf8');

assert(
  /useListDragSort/.test(dashboard) && /useListDragSort/.test(workspace),
  '项目列表与子项目列表都应复用 useListDragSort，不要各写一份拖拽逻辑',
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

/***********************父项目入口卡必须在拖拽容器外*********************/
// 换位判定用的是 .draggable-list 直接子元素的下标，必须与 draggableChildren
// 一一对应。父项目入口卡不在 children 里，混进容器会让所有下标错位。

const listStart = workspace.indexOf('class="draggable-list');
const parentEntryIndex = workspace.indexOf('dashboard.parentProjectEntry');

assert(listStart >= 0, '子项目列表应有 .draggable-list 容器');
assert(parentEntryIndex >= 0, '子项目列表应有父项目入口卡');
assert(
  parentEntryIndex < listStart,
  '父项目入口卡必须渲染在 .draggable-list 之前（容器外），否则拖拽换位的下标会错位',
);

assert(
  /:data-project-id="child\.id"/.test(workspace),
  '子项目条目必须带 data-project-id，FLIP 动画靠它匹配换位前后的元素',
);

console.log('listDragSort tests passed');
