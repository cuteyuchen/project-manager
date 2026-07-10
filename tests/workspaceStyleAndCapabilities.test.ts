import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const workspace = read('src/components/dashboard/ProjectWorkspace.vue');
const calendar = read('src/views/CommitCalendar.vue');
const projectStore = read('src/stores/project.ts');
const theme = read('src/styles/theme.css');

assert(/workspaceProject = computed<Project \| null>\(\(\) => activeLeaf\.value \|\| currentNode\.value\)/.test(workspace), '文件和备忘录应绑定当前项目');
assert(/if \(!selectedLeafId\.value\) return currentNode\.value/.test(workspace), '父项目应作为容器模式下的默认活动项目');
assert(/parentProjectEntry/.test(workspace) && /:active="!selectedLeafId \|\| selectedLeafId === currentNode\.id"/.test(workspace), '父项目入口应与子项目同级并默认选中');
assert(/v-if="hasRunnableCommands"[\s\S]*?rightTab = 'console'/.test(workspace), '无命令时应隐藏命令入口');
assert(/v-if="hasFrontendEnv"[\s\S]*?rightTab = 'env'/.test(workspace), '无环境配置时应隐藏环境入口');
assert(/:project="workspaceProject"/.test(workspace), '文件和备忘录应使用当前项目实例');
assert(/SKIPPED_PREVIEW_LIMIT = 8/.test(calendar), '跳过项目应限制默认展示数量');
assert(/visibleSkippedProjects/.test(calendar) && /skippedExpanded/.test(calendar), '跳过项目应支持展开和收起');
assert(/scanFrontendEnvForProject\(newProject\.id\)/.test(projectStore), '新增子项目后应扫描环境配置');
assert(/--app-content-max:\s*1440px/.test(theme), '主要页面应共享最大内容宽度');
assert(/-webkit-backdrop-filter/.test(theme), '玻璃模糊应兼容桌面 WebView');

console.log('workspace style and capabilities tests passed');
