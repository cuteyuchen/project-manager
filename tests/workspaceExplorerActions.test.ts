import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const explorer = read('src/components/dashboard/WorkspaceProjectExplorer.vue');
const node = read('src/components/dashboard/ProjectExplorerNode.vue');

assert.match(
  node,
  /@contextmenu\.prevent="forwardContextMenu\(\$event, \{ kind: 'project', project, relativePath: '', name: project\.name, isDirectory: true \}\)"/,
  '项目节点右键 payload 必须把空相对路径表示为项目根目录',
);
assert(explorer.includes("createItem('file')"), '项目上下文菜单应调用统一的新建文件逻辑');
assert(explorer.includes("createItem('directory')"), '项目上下文菜单应调用统一的新建文件夹逻辑');
assert.match(explorer, /const relativePath = joinWorkspacePath\(menuTargetDirectory\(payload\), name\)/, '创建内容应复用目标目录解析');

assert(node.includes('resolveProjectQuickCommands'), 'More/项目节点应复用快捷命令解析');
assert(node.includes('toggleQuickCommand'), 'More/项目节点应复用快捷命令切换');
assert(node.includes('isQuickCommandRunning'), 'More/项目节点应复用快捷命令运行态');
for (const action of [
  "emitProjectAction('git')",
  "emitProjectAction('terminal')",
  "emitProjectAction('editor')",
  "emitProjectAction('folder')",
  "emitProjectAction('edit')",
  "emitProjectAction('scan')",
  "emitProjectAction('pin')",
  "emitProjectAction('delete')",
]) {
  assert(node.includes(action), `More 菜单缺少 ${action}`);
}
assert.match(node, /v-for="command in quickCommands"[\s\S]*quickCommandMenuLabel\(command\)/, 'More 菜单应完整列出快捷命令并显示运行/停止');
assert.match(node, /@container \(max-width: 340px\)[\s\S]*\.explorer-action-secondary[\s\S]*display: none/, '窄 Explorer 可隐藏次要 inline action');
assert(node.includes('explorer-more-menu'), '隐藏 inline action 后仍必须保留 More fallback');

assert.match(explorer, /async function openFile[\s\S]*try \{[\s\S]*api\.openPath/, 'binary openPath 必须位于本地 try/catch 内');
assert.match(explorer, /async function revealItem[\s\S]*try \{[\s\S]*api\.revealInFolder/, 'Explorer reveal 失败必须本地处理');
assert.match(explorer, /async function externalOpen[\s\S]*try \{[\s\S]*api\.openPath/, 'Explorer 外部打开失败必须本地处理');
assert.match(explorer, /async function copyPath[\s\S]*try \{[\s\S]*navigator\.clipboard/, '复制路径失败必须本地处理');
assert.match(explorer, /async function trashItem[\s\S]*try \{[\s\S]*workspaceTrashMode/, '删除模式读取失败必须本地处理');
assert.match(explorer, /fileKind\(contextMenu\.payload\.relativePath\) !== 'binary'/, 'binary 文件不可显示轻量编辑器动作');

console.log('workspace explorer action tests passed');
