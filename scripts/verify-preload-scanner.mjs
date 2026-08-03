/**
 * 在真实目录树上验证 preload.js 镜像的扫描行为与 Rust 实现一致。
 * 用法：node scripts/verify-preload-scanner.mjs <fixtureRoot>
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = process.argv[2];
if (!fixtureRoot) throw new Error('用法: node scripts/verify-preload-scanner.mjs <fixtureRoot>');

// 从 preload.js 中抽出扫描相关的纯函数在本进程中求值（避免加载整个 uTools 运行时）
const source = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');
const slice = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1 || end === -1) throw new Error(`无法定位片段: ${startMarker}`);
  return source.slice(start, end);
};

const scannerSource = [
  slice('const PROJECT_SCAN_IGNORED_DIRS', 'function readPackageJson('),
  slice('function readPackageJson(', 'function identifyProjectModule('),
  slice('function identifyProjectModule(', 'function scanProjectTree('),
  slice('function scanProjectTree(', 'const processes = new Map();'),
].join('\n');

const factory = new Function('fs', 'path', `${scannerSource}\nreturn { scanChildDirs, MAX_SCAN_DEPTH };`);
const { scanChildDirs, MAX_SCAN_DEPTH } = factory(fs, path);

const tree = scanChildDirs(fixtureRoot, 1, MAX_SCAN_DEPTH, new Set());
const byName = (nodes, name) => nodes.find((n) => n.name === name);
const names = (nodes) => nodes.map((n) => n.name).sort();

/***********************Git 仓库作为边界并继续向内递归*********************/
const repo = byName(tree, 'MyRepo');
assert(repo, 'MyRepo 应作为项目节点存在');
assert.equal(repo.hasGit, true, 'MyRepo 应标记 hasGit');
assert.deepEqual(names(repo.children), ['backend', 'frontend'], '仓库内部模块应作为其子节点');

/***********************纯容器保留为占位层级*********************/
const group = byName(tree, 'group');
assert.equal(group.kind, 'unknown', '容器目录应为 unknown 占位节点');
assert.deepEqual(names(group.children), ['ProjectA', 'ProjectB'], '两个项目应挂在容器之下');

/***********************孙级不得平铺到父级*********************/
const myApp = byName(tree, 'MyApp');
assert.deepEqual(names(myApp.children), ['packages'], 'MyApp 的直接子级只应有 packages');
assert.deepEqual(names(byName(myApp.children, 'packages').children), ['api', 'web'], '模块应挂在 packages 之下');

/***********************超出层级截断而非上提*********************/
const allPaths = [];
const collect = (nodes) => nodes.forEach((n) => { allPaths.push(n.path.replace(/\\/g, '/')); collect(n.children); });
collect(tree);
assert(!allPaths.some((p) => p.endsWith('/d')), `第 4 层模块应被截断丢弃，实际: ${allPaths.join(', ')}`);

/***********************无清单无子模块的仓库仍保留*********************/
const docsRepo = byName(tree, 'DocsRepo');
assert(docsRepo, '只有 README 的仓库也必须保留');
assert.equal(docsRepo.children.length, 0, '该仓库内部没有子模块');

/***********************空容器不入结果*********************/
assert(!byName(tree, 'empty-group'), '没有任何模块的空容器不应入结果');

/***********************同层内 Git 仓库优先*********************/
const gitIndexes = tree.map((n, i) => (n.hasGit ? i : -1)).filter((i) => i >= 0);
const nonGitIndexes = tree.map((n, i) => (n.hasGit ? -1 : i)).filter((i) => i >= 0);
assert(
  Math.max(...gitIndexes) < Math.min(...nonGitIndexes),
  `Git 仓库应排在同层非 git 节点之前，实际顺序: ${tree.map((n) => `${n.name}(${n.hasGit})`).join(', ')}`,
);

console.log('preload scanner mirror tests passed');
