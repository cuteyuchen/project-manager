import assert from 'node:assert/strict';
import type { ImportNode } from '../src/api/types.ts';
import { flattenImportNodeTree } from '../src/utils/importProjectTree.ts';
import { MAX_PROJECT_DEPTH, normalizeProjectPath, assignSortOrders } from '../src/utils/projectTree.ts';
import {
  buildDefaultSelection,
  collectDeselectedExistingPaths,
  collectForestPaths,
  countModulesInNode,
  getCandidateCheckState,
  mergeExistingSubtree,
  pruneSelectedTree,
  toggleCandidateSelection,
} from '../src/utils/scanCandidateTree.ts';

/***********************测试用节点构造*********************/

function node(
  name: string,
  path: string,
  kind: string,
  children: ImportNode[] = [],
  extra: Partial<ImportNode> = {},
): ImportNode {
  return {
    name,
    path,
    kind,
    hasGit: false,
    hasPackageJson: kind === 'node' || kind === 'frontend',
    scripts: [],
    children,
    ...extra,
  };
}

/** 用户报告的场景：MyApp/packages/{web,api}，中间隔着一层容器 */
const web = node('web', 'F:/ws/MyApp/packages/web', 'frontend');
const api = node('api', 'F:/ws/MyApp/packages/api', 'go');
const packages = node('packages', 'F:/ws/MyApp/packages', 'unknown', [web, api]);
const myApp = node('MyApp', 'F:/ws/MyApp', 'unknown', [packages], { hasGit: true });

/***********************孙级必须挂在真实父节点下*********************/

let counter = 0;
const createId = () => `id-${++counter}`;

const flattened = flattenImportNodeTree([myApp], undefined, { createId });

assert.equal(flattened.length, 4, '整棵树应展开为 4 个项目（含容器占位）');

const byPath = new Map(flattened.map((p) => [p.path, p]));
const rootProject = byPath.get('F:/ws/MyApp')!;
const packagesProject = byPath.get('F:/ws/MyApp/packages')!;
const webProject = byPath.get('F:/ws/MyApp/packages/web')!;
const apiProject = byPath.get('F:/ws/MyApp/packages/api')!;

assert.equal(rootProject.parentId, undefined, '顶层节点应为一级项目');
assert.equal(packagesProject.parentId, rootProject.id, '容器目录应挂在顶层项目之下');
assert.equal(
  webProject.parentId,
  packagesProject.id,
  '孙级模块必须挂在其真实父节点（packages）之下，而不是被平铺到顶层项目',
);
assert.equal(apiProject.parentId, packagesProject.id, '同层的另一个孙级模块同样挂在 packages 之下');
assert.notEqual(webProject.parentId, rootProject.id, '孙级绝不能成为顶层项目的直接子级');

/***********************父在前、子在后*********************/

const order = flattened.map((p) => p.path);
assert(
  order.indexOf('F:/ws/MyApp') < order.indexOf('F:/ws/MyApp/packages'),
  '父项目必须排在子项目之前，便于调用方顺序入库',
);
assert(
  order.indexOf('F:/ws/MyApp/packages') < order.indexOf('F:/ws/MyApp/packages/web'),
  '容器必须排在其子模块之前',
);

/***********************模块类型与包管理器映射*********************/

assert.equal(webProject.moduleKind, 'frontend', 'frontend 应映射为 frontend 模块类型');
assert.equal(webProject.type, 'node', 'frontend 项目类型应为 node');
assert.equal(webProject.nodeVersion, 'Default', '嵌套扫描未带 nvm 信息，应使用 Default');
assert.equal(apiProject.moduleKind, 'go', 'go 应映射为 go 模块类型');
assert.equal(apiProject.type, 'other', 'go 项目类型应为 other');
assert.equal(packagesProject.moduleKind, 'unknown', '容器占位节点应为 unknown 模块类型');

/***********************超出层级截断而非上提*********************/

counter = 0;
const truncated = flattenImportNodeTree([myApp], undefined, { createId, maxDepth: 2 });

assert.equal(truncated.length, 2, 'maxDepth=2 时只应保留前两层');
assert.deepEqual(
  truncated.map((p) => p.path),
  ['F:/ws/MyApp', 'F:/ws/MyApp/packages'],
  '第三层的模块应被丢弃',
);
assert(
  !truncated.some((p) => p.path.endsWith('/web') || p.path.endsWith('/api')),
  '被截断的深层模块绝不能被上提压平到上层',
);

/***********************已存在项目复用既有 id 作为父级*********************/

counter = 0;
const reused = flattenImportNodeTree([myApp], undefined, {
  createId,
  resolveExistingId: (path) =>
    normalizeProjectPath(path) === normalizeProjectPath('F:/ws/MyApp') ? 'existing-root' : undefined,
});

assert.equal(reused.length, 3, '已存在的节点不应重复入库');
assert(
  !reused.some((p) => p.path === 'F:/ws/MyApp'),
  '已存在的项目不应再产出一个新 Project',
);
const reusedPackages = reused.find((p) => p.path === 'F:/ws/MyApp/packages')!;
assert.equal(
  reusedPackages.parentId,
  'existing-root',
  '已存在项目的既有 id 应作为其后代的 parentId，避免孙级挂到错误层级',
);

/***********************默认勾选与路径收集*********************/

const allPaths = collectForestPaths([myApp]);
assert.equal(allPaths.length, 4, '应收集到整棵树的全部路径');
assert(
  allPaths.every((p) => p === p.toLowerCase()),
  '收集到的路径应为归一化（小写）形式，便于跨平台比较',
);

const existingPaths = new Set([normalizeProjectPath('F:/ws/MyApp/packages/api')]);
const defaultSelection = buildDefaultSelection([myApp]);
assert.equal(defaultSelection.size, 4, '默认全选：已导入的项目也勾上');
assert(
  defaultSelection.has(normalizeProjectPath('F:/ws/MyApp/packages/api')),
  '已导入的项目默认应为勾选态——勾选表达"该项目应存在"，取消才表示要移除它',
);

/***********************合并已入库的子树*********************/

// 扫描有两处盲区：深度预算用尽（编辑二级项目时 remainingDepth=1，孙级被截断）、
// 带清单但无 .git 的目录不向内递归。候选里没有的节点无法被取消勾选——
// 用户会看到"已添加的子项目压根不出现在列表里，因而删不掉"。
const scannedOnly = [node('web', 'F:/ws/MyApp/packages/web', 'node')];
const storedSubtree = [
  node('web', 'F:/ws/MyApp/packages/web', 'node'),
  node('api', 'F:/ws/MyApp/packages/api', 'go'),
];
const mergedForest = mergeExistingSubtree(scannedOnly, storedSubtree);
assert.deepEqual(
  mergedForest.map((n) => n.name),
  ['web', 'api'],
  '已入库但扫描不到的节点必须被补进候选，否则无法被取消/移除',
);
assert.equal(
  mergedForest.filter((n) => n.name === 'web').length,
  1,
  '同路径不得重复出现',
);

// 同路径应保留扫描结果的元数据（更新鲜），并递归合并各自的子树
const scannedParent = [
  node('packages', 'F:/ws/MyApp/packages', 'node', [
    node('web', 'F:/ws/MyApp/packages/web', 'node'),
  ]),
];
const storedParent = [
  node('packages', 'F:/ws/MyApp/packages', 'unknown', [
    node('api', 'F:/ws/MyApp/packages/api', 'go'),
  ]),
];
const mergedNested = mergeExistingSubtree(scannedParent, storedParent);
assert.equal(mergedNested.length, 1, '同路径的父节点应合并为一个');
assert.equal(mergedNested[0].kind, 'node', '同路径应保留扫描结果的元数据');
assert.deepEqual(
  mergedNested[0].children.map((n) => n.name).sort(),
  ['api', 'web'],
  '两边的子树应递归合并，而不是一边覆盖另一边',
);

/***********************勾选子节点自动向上补齐祖先*********************/

const onlyWeb = toggleCandidateSelection(
  [myApp],
  'F:/ws/MyApp/packages/web',
  true,
  new Set<string>(),
);

assert(onlyWeb.has(normalizeProjectPath('F:/ws/MyApp/packages/web')), '目标节点应被勾选');
assert(
  onlyWeb.has(normalizeProjectPath('F:/ws/MyApp/packages')),
  '勾选子节点应自动勾选其父级——孙级无法脱离父级单独挂载',
);
assert(
  onlyWeb.has(normalizeProjectPath('F:/ws/MyApp')),
  '勾选子节点应自动补齐到根的整条祖先链',
);
assert(
  !onlyWeb.has(normalizeProjectPath('F:/ws/MyApp/packages/api')),
  '兄弟节点不应被牵连勾选',
);

/***********************已导入的节点同样参与联动*********************/

// 取消已导入的项目 = 要移除它，因此它必须能被取消
const uncheckExisting = toggleCandidateSelection(
  [myApp],
  'F:/ws/MyApp/packages/api',
  false,
  new Set(collectForestPaths([myApp])),
);
assert(
  !uncheckExisting.has(normalizeProjectPath('F:/ws/MyApp/packages/api')),
  '已导入的项目必须能被取消勾选，否则用户只能加不能减',
);

// 反过来，它也必须能在子级被勾选时被重新补上
const recheckAncestor = toggleCandidateSelection(
  [myApp],
  'F:/ws/MyApp/packages/web',
  true,
  new Set<string>(),
);
assert(
  recheckAncestor.has(normalizeProjectPath('F:/ws/MyApp')),
  '祖先即使已导入也要参与向上补齐，否则挂载链会断开',
);

/***********************取消父节点级联取消后代*********************/

const allSelected = new Set(collectForestPaths([myApp]));
const afterUncheck = toggleCandidateSelection(
  [myApp],
  'F:/ws/MyApp/packages',
  false,
  allSelected,
);

assert(
  !afterUncheck.has(normalizeProjectPath('F:/ws/MyApp/packages/web')),
  '取消父节点应级联取消其全部后代',
);
assert(
  !afterUncheck.has(normalizeProjectPath('F:/ws/MyApp/packages/api')),
  '取消父节点应级联取消其全部后代',
);
assert(
  afterUncheck.has(normalizeProjectPath('F:/ws/MyApp')),
  '取消子树不应影响其祖先的勾选状态',
);

/***********************勾选父节点不再级联向下*********************/

// 这是本次修复的核心：旧实现里"勾选父级"会级联勾上全部后代，
// 导致"保留父级、去掉其下全部孙级"这个状态无法维持——
// 用户刚取消完孙级，父级变半选，再点一下父级孙级就全被勾回来了。
const parentOnly = toggleCandidateSelection(
  [myApp],
  'F:/ws/MyApp/packages',
  true,
  new Set<string>(),
);
assert(
  parentOnly.has(normalizeProjectPath('F:/ws/MyApp/packages')),
  '勾选父节点应勾上它自己',
);
assert(
  !parentOnly.has(normalizeProjectPath(web.path)) && !parentOnly.has(normalizeProjectPath(api.path)),
  '勾选父节点不应级联勾选后代——否则取消掉的孙级会被一键勾回来',
);

/***********************复选框三态*********************/

assert.equal(
  getCandidateCheckState(packages, allSelected),
  'checked',
  '节点自身被勾选时显示为全选',
);
assert.equal(
  getCandidateCheckState(packages, new Set([normalizeProjectPath(web.path)])),
  'indeterminate',
  '自身未勾选但后代中有勾选时显示为半选',
);
assert.equal(
  getCandidateCheckState(packages, new Set<string>()),
  'unchecked',
  '自身与后代都未勾选时显示为未选',
);

// 关键回归：取消掉全部孙级后，父级自身仍在选择集合里 → 必须是 checked 而非
// indeterminate。若是 indeterminate，行点击的 `checkState !== 'checked'` 会算出
// checked=true，用户再点一下就把孙级全勾回来，永远取消不干净。
const parentKeptChildrenDropped = new Set([normalizeProjectPath(packages.path)]);
assert.equal(
  getCandidateCheckState(packages, parentKeptChildrenDropped),
  'checked',
  '自身被勾选就是 checked——后代是否勾选不该把它拖成半选，否则点击方向会反向',
);

// 完整走一遍用户的操作序列，确认孙级不会被勾回来
let seq = new Set(collectForestPaths([myApp]));
seq = toggleCandidateSelection([myApp], web.path, false, seq);
seq = toggleCandidateSelection([myApp], api.path, false, seq);
const clickChecked = getCandidateCheckState(packages, seq) !== 'checked';
seq = toggleCandidateSelection([myApp], packages.path, clickChecked, seq);
assert(
  !seq.has(normalizeProjectPath(web.path)) && !seq.has(normalizeProjectPath(api.path)),
  '取消完全部孙级后再点父级那一行，孙级不得被重新勾上',
);

// 纯新增场景：已导入的项目永不进入勾选集合，必须排除在统计之外
assert.equal(
  getCandidateCheckState(packages, new Set([normalizeProjectPath(web.path)]), existingPaths),
  'indeterminate',
  '批量导入下 packages 自身未勾选、web 已勾选 → 半选',
);

/***********************识别被取消勾选的已导入项目*********************/

// api 已导入且被取消勾选 → 该被移除；web 未导入且被取消 → 只是不新增，不涉及删除
const removalSelection = new Set(collectForestPaths([myApp]));
removalSelection.delete(normalizeProjectPath(api.path));
removalSelection.delete(normalizeProjectPath(web.path));

const toRemove = collectDeselectedExistingPaths([myApp], existingPaths, removalSelection);
assert.deepEqual(
  toRemove,
  [normalizeProjectPath(api.path)],
  '只有"已导入且被取消勾选"的节点才是要移除的；未导入的取消勾选只是不新增',
);

// 全选时不该移除任何东西——直接确认应当是无操作
assert.deepEqual(
  collectDeselectedExistingPaths([myApp], existingPaths, allSelected),
  [],
  '全部勾选时不应产生任何移除',
);

// 树外的已导入项目绝不能被牵连删除
const outsideExisting = new Set([
  normalizeProjectPath(api.path),
  normalizeProjectPath('F:/ws/OtherProject'),
]);
assert(
  !collectDeselectedExistingPaths([myApp], outsideExisting, removalSelection)
    .includes(normalizeProjectPath('F:/ws/OtherProject')),
  '候选树之外的项目不在本次操作语义内，绝不能因为"不在勾选集合中"就被删掉',
);

/***********************移除作用域必须限定在当前父级的后代*********************/

// 关键安全用例：被扫描到的目录可能已作为**别的父级下的项目**或一级项目存在。
// 若 existingPaths 取自全库，它会显示「已存在」并默认勾选；用户一取消，
// 就会把不属于本次编辑范围的项目连同其后代一起删掉。
// 作用域限定后，它不计入 existingPaths，取消它只是"不新增"，绝不触发删除。
const elsewhereProject = normalizeProjectPath('F:/ws/MyApp/packages/web');

// 场景 A（错误做法）：existingPaths 来自全库，web 属于别的父级
const globalScope = new Set([elsewhereProject]);
const selectionWithoutWeb = new Set(collectForestPaths([myApp]));
selectionWithoutWeb.delete(elsewhereProject);
assert.deepEqual(
  collectDeselectedExistingPaths([myApp], globalScope, selectionWithoutWeb),
  [elsewhereProject],
  '若作用域是全库，取消这个"他处已存在"的节点会被算作要移除——这正是要避免的越界删除',
);

// 场景 B（正确做法）：existingPaths 只含当前父级的后代，不含 web
const scopedEmpty = new Set<string>();
assert.deepEqual(
  collectDeselectedExistingPaths([myApp], scopedEmpty, selectionWithoutWeb),
  [],
  '作用域限定到当前父级的后代后，取消他处的项目只是"不新增"，不得产生任何移除',
);

/***********************裁剪保留已存在节点作为层级容器*********************/

const prunedOnlyWeb = pruneSelectedTree([myApp], onlyWeb);
assert.equal(prunedOnlyWeb.length, 1, '裁剪后应保留唯一顶层节点');
assert.equal(prunedOnlyWeb[0].children.length, 1, '未勾选的兄弟分支应被裁掉');
assert.equal(
  prunedOnlyWeb[0].children[0].children.length,
  1,
  '仅勾选的 web 分支应被保留',
);
assert.equal(prunedOnlyWeb[0].children[0].children[0].name, 'web');

// 只勾选孙级、祖先均已存在时，祖先仍需作为层级容器保留在树中
const onlyLeafSelected = new Set([normalizeProjectPath(web.path)]);
const prunedWithContainers = pruneSelectedTree([myApp], onlyLeafSelected);
assert.equal(
  prunedWithContainers.length,
  1,
  '未勾选但含被保留子孙的节点应作为层级容器保留（入库时复用其既有 id）',
);
assert.equal(prunedWithContainers[0].children[0].children[0].name, 'web');

/***********************模块计数忽略容器自身*********************/

assert.equal(countModulesInNode(packages), 2, '容器自身不计入模块数，仅累加其下模块');
assert.equal(countModulesInNode(web), 1, '已识别模块自身计 1');
assert.equal(countModulesInNode(myApp), 2, '整棵树共两个可识别模块');

/***********************sortOrder 按父级独立分桶*********************/

// 模拟两个父级各带两个子项目的展开结果（父在前、子在后）
const toOrder = [
  { path: 'root', parentId: undefined },
  { path: 'root/a', parentId: 'parent-a' },
  { path: 'root/b', parentId: 'parent-a' },
  { path: 'root/c', parentId: 'parent-b' },
  { path: 'root/d', parentId: 'parent-b' },
];

const ordered = assignSortOrders(toOrder, () => 0);

assert.deepEqual(
  ordered.filter((p) => p.parentId === 'parent-a').map((p) => p.sortOrder),
  [0, 1],
  '同一父级下的子项目应连续续号',
);
assert.deepEqual(
  ordered.filter((p) => p.parentId === 'parent-b').map((p) => p.sortOrder),
  [0, 1],
  '不同父级各自独立计数，不应共用同一计数器（否则会得到 2、3 导致顺序错乱）',
);
assert.equal(ordered[0].sortOrder, 0, '一级项目从 0 起算');

// 已有子项目时应从已有数量续号
const appended = assignSortOrders(
  [{ path: 'root/e', parentId: 'parent-a' }],
  (id) => (id === 'parent-a' ? 3 : 0),
);
assert.equal(appended[0].sortOrder, 3, '应从该父级已有子项目数量续号');

/***********************深度常量与项目树上限一致*********************/

assert.equal(MAX_PROJECT_DEPTH, 3, '项目树最大层级应为 3，与后端 MAX_SCAN_DEPTH 保持一致');

console.log('projectTreeScan tests passed');
