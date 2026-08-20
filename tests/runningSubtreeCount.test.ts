import assert from 'node:assert/strict';
import { aggregateRunningSubtreeCount } from '../src/utils/projectTree.ts';

/***********************测试用项目树*********************/
// root
//  ├─ childA
//  │   └─ grandchild
//  └─ childB
// other（独立一级项目）
const projects = [
  { id: 'root' },
  { id: 'childA', parentId: 'root' },
  { id: 'grandchild', parentId: 'childA' },
  { id: 'childB', parentId: 'root' },
  { id: 'other' },
];

/***********************基本聚合*********************/

// 没有任何东西在跑 → 空结果，不该凭空造出 0 条目
assert.deepEqual(aggregateRunningSubtreeCount(projects, {}), {});

// 孙项目在跑 → 它自己、父、祖父都该被算上；旁支不受影响
{
  const result = aggregateRunningSubtreeCount(projects, { grandchild: 1 });
  assert.equal(result.grandchild, 1, '孙项目自身应计入');
  assert.equal(result.childA, 1, '父项目应聚合到孙项目的运行数');
  assert.equal(result.root, 1, '一级项目应聚合到孙项目的运行数（这是主页漏检的那条）');
  assert.equal(result.childB, undefined, '旁支不应被算上');
  assert.equal(result.other, undefined, '无关的一级项目不应被算上');
}

// 一级项目自己在跑 → 只有它自己
{
  const result = aggregateRunningSubtreeCount(projects, { root: 2 });
  assert.equal(result.root, 2);
  assert.equal(result.childA, undefined, '运行数只向上聚合，不向下扩散');
}

/***********************多处同时运行时求和*********************/

{
  const result = aggregateRunningSubtreeCount(projects, {
    grandchild: 1,
    childB: 2,
    root: 3,
  });
  assert.equal(result.grandchild, 1);
  assert.equal(result.childA, 1);
  assert.equal(result.childB, 2);
  // root 自身 3 + childA 子树 1 + childB 2
  assert.equal(result.root, 6, '同一项目下多处运行应求和');
}

/***********************脏数据防御*********************/

// 计数里出现已删除的项目 id → 跳过，不该造出不存在的条目
{
  const result = aggregateRunningSubtreeCount(projects, { ghost: 5, root: 1 });
  assert.equal(result.ghost, undefined, '已删除项目的残留计数应被忽略');
  assert.equal(result.root, 1);
}

// 计数为 0 的条目应被忽略
assert.deepEqual(aggregateRunningSubtreeCount(projects, { root: 0 }), {});

// parentId 成环时必须终止而不是死循环
{
  const cyclic = [
    { id: 'a', parentId: 'b' },
    { id: 'b', parentId: 'a' },
  ];
  const result = aggregateRunningSubtreeCount(cyclic, { a: 1 });
  assert.equal(result.a, 1);
  assert.equal(result.b, 1);
}

// parentId 指向不存在的项目时应安全停止
{
  const orphan = [{ id: 'lonely', parentId: 'missing' }];
  const result = aggregateRunningSubtreeCount(orphan, { lonely: 1 });
  assert.equal(result.lonely, 1);
  assert.equal(result.missing, undefined, '不存在的父项目不应被创建出来');
}

console.log('runningSubtreeCount tests passed');
