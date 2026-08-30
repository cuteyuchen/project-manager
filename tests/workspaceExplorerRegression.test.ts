import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';

const root = process.cwd();
const explorer = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceProjectExplorer.vue'), 'utf8');
const projectNode = readFileSync(resolve(root, 'src/components/dashboard/ProjectExplorerNode.vue'), 'utf8');
const fileNode = readFileSync(resolve(root, 'src/components/dashboard/FileTreeNode.vue'), 'utf8');
const editor = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceEditor.vue'), 'utf8');

assert.match(explorer, /const opening = editorStore\.openFile\(project, relativePath\);[\s\S]*requestRightTab\('editor', project\.id\);[\s\S]*await opening/);
assert.match(explorer, /async function handleProjectAction\(project: Project, action: ExplorerProjectAction\)/);
assert.match(explorer, /await handleProjectAction\(project, action\)/, '右键项目动作必须复用 inline handler');

assert.match(projectNode, /resolveProjectQuickCommands/);
assert.match(projectNode, /@click="selectProject"/);
assert.match(projectNode, /is-root-project/);
assert.match(projectNode, /is-child-project/);
assert.match(projectNode, /@project-action="forwardProjectAction"/);
assert.match(projectNode, /explorer-project-actions/);
assert.match(projectNode, /explorer-action-menu/);
assert.match(projectNode, /user-select: none/);
assert.match(
  projectNode,
  /class="min-w-0 flex-1 truncate">\{\{ project\.name \}\}<\/span>/,
  '项目名称应占据可收缩区域，不能被右侧 Git 信息挤到不可见',
);
assert.doesNotMatch(projectNode, /moduleKindLabel|explorer-module-kind/, 'Explorer 不应显示项目类别');
assert.doesNotMatch(projectNode, /explorer-project-boundary/, 'Explorer 不应显示子项目标识徽标');

assert.match(explorer, /const explorerWidth = ref\(readWorkspaceExplorerWidth\(settingsStore\.settings\)\)/, 'Explorer 宽度应从设置恢复并由响应式状态控制');
assert.match(explorer, /function startExplorerResize\(event: PointerEvent\)/, 'Explorer 应支持指针拖拽调整宽度');
assert.match(explorer, /function resizeExplorer\(event: PointerEvent\)/, 'Explorer 应在拖拽过程中更新宽度');
assert.match(explorer, /class="explorer-resize-handle"/, 'Explorer 应渲染宽度拖拽分隔条');
assert.match(explorer, /role="separator"/, '宽度拖拽分隔条应具备无障碍语义');
assert.match(explorer, /@keydown="handleExplorerResizeKeydown"/, '宽度拖拽分隔条应支持键盘调整');
assert.match(explorer, /persistWorkspaceExplorerWidth/, 'Explorer 宽度应持久化到设置');
assert.doesNotMatch(projectNode, /paddingLeft:.*depth\s*\*/, '项目行不应按 depth 计算第二套缩进');
assert.doesNotMatch(fileNode, /paddingLeft:.*depth\s*\*/, '文件行不应按 depth 计算第二套缩进');
assert.match(projectNode, /\.explorer-project-children\s*\{[\s\S]*margin-left: 14px[\s\S]*padding-left: 0/);
assert.match(fileNode, /\.explorer-children\s*\{[\s\S]*margin-left: 14px[\s\S]*padding-left: 0/);

assert.match(fileNode, /@dblclick="open"/);
assert.match(fileNode, /event\?\.preventDefault\(\)/);
assert.match(fileNode, /event\?\.stopPropagation\(\)/);
assert.match(fileNode, /explorer-file-row\.is-selected/);
assert.match(fileNode, /user-select: none/);
assert.doesNotMatch(fileNode, /\*\s*\{[^}]*user-select\s*:\s*none/);

assert.match(editor, /activeDocument\.loading/);
assert.match(editor, /正在加载 \{\{ activeDocument\.name \}\}/);
assert.match(editor, /retryDocument/);
assert.match(editor, /!activeDocument\.error/);

console.log('workspace explorer regression tests passed');
