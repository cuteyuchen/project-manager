import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const projectNode = read('src/components/dashboard/ProjectExplorerNode.vue');
const workspaceExplorer = read('src/components/dashboard/WorkspaceProjectExplorer.vue');
const gitCommit = read('src/components/git/GitCommitArea.vue');
const gitFiles = read('src/components/git/GitFileContextMenu.vue');
const gitHistory = read('src/components/git/GitHistory.vue');
const theme = read('src/styles/theme.css');

function assertLayout(source: string, selector: string, required: string[], label: string): void {
  const start = source.indexOf(selector);
  assert(start >= 0, `${label} 缺少 ${selector}`);
  const block = source.slice(start, source.indexOf('}', start) + 1);
  for (const declaration of required) {
    assert(block.includes(declaration), `${label} 缺少 ${declaration}`);
  }
}

assertLayout(projectNode, '.explorer-action-menu {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Explorer More 菜单');
assertLayout(projectNode, '.explorer-menu-item {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Explorer More 菜单项');
assertLayout(projectNode, '.explorer-menu-item > div {', ['flex: 0 0 auto;'], 'Explorer 菜单图标');
assertLayout(workspaceExplorer, '.workspace-context-menu {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Explorer 上下文菜单');
assertLayout(workspaceExplorer, '.context-item {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Explorer 上下文菜单项');
assertLayout(gitCommit, '.git-commit-menu {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Git commit action 菜单');
assertLayout(gitCommit, '.git-commit-menu button {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Git commit action 菜单项');
assertLayout(gitFiles, '.git-file-context-menu {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Git file context 菜单');
assertLayout(gitFiles, '.ctx-item {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Git file context 菜单项');
assertLayout(gitHistory, '.git-history-ctx {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Git history context 菜单');
assertLayout(gitHistory, '.ctx-item {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Git history context 菜单项');
assertLayout(theme, '.el-dropdown-menu {', ['width: max-content;', 'min-width:', 'max-width: min(320px'], 'Element dropdown 菜单');
assertLayout(theme, '.el-dropdown-menu__item {', ['display: flex;', 'align-items: center;', 'white-space: nowrap;'], 'Element dropdown 菜单项');

for (const label of ['git.undoCommitSoft', 'git.undoCommitMixed']) {
  assert(gitCommit.includes(label), `${label} 必须保留，不能通过缩小字号规避换行`);
}

console.log('action menu layout tests passed');
