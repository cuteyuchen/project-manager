import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const workspace = read('src/components/dashboard/ProjectWorkspace.vue');
const managementPanel = read('src/components/dashboard/ProjectManagementPanel.vue');
const tabFallback = read('src/utils/workspaceTabFallback.ts');
const calendar = read('src/views/CommitCalendar.vue');
const projectStore = read('src/stores/project.ts');
const theme = read('src/styles/theme.css');

assert(/workspaceProject = computed<Project \| null>\(\(\) => activeLeaf\.value \|\| currentNode\.value\)/.test(workspace), '文件和备忘录应绑定当前项目');
assert(/if \(!selectedLeafId\.value\) return currentNode\.value/.test(workspace), '父项目应作为容器模式下的默认活动项目');
assert(/parentProjectEntry/.test(workspace) && /:active="!selectedLeafId \|\| selectedLeafId === currentNode\.id"/.test(workspace), '父项目入口应与子项目同级并默认选中');
assert(/v-if="hasRunnableCommands"[\s\S]*?selectTab\('console'\)/.test(managementPanel), '无命令时应隐藏命令入口');
assert(/v-if="hasFrontendEnv"[\s\S]*?selectTab\('env'\)/.test(managementPanel), '无环境配置时应隐藏环境入口');

// 页签按钮必须走 selectTab 而不是直接赋值：
// 只有「用户点击」才算意图，才该被写进导航记忆。若用 watch(rightTab) 自动记忆，
// 兜底纠正的结果也会入库，形成用户改不回来的单向棘轮。
assert(
  !/@click="rightTab = '/.test(workspace),
  '页签按钮应调用 selectTab 记录用户意图，不要直接给 rightTab 赋值',
);

/***********************无可运行命令时默认落在 Git*********************/

assert(
  /const defaultTab = computed<WorkspaceTab>\(\(\) => \(hasRunnableCommands\.value \? 'console' : 'git'\)\)/.test(managementPanel),
  '没有可运行脚本时默认页签应为 Git 而非文件——命令入口带 v-if 会整个消失，Git 则无条件渲染',
);

// 页签类型只留一份定义（types.ts 的 WorkspaceTab），组件与 store 都引用它
assert(
  !/type WorkTab =/.test(workspace),
  '页签类型应统一到 types.ts 的 WorkspaceTab，不要在组件里再定义一份',
);

assert(
  !/rightTab\.value = container \? 'files' : /.test(workspace),
  '容器模式不应一律默认「文件」：父项目自身同样按有无可运行命令决定默认页签',
);

assert(
  !/rightTab\.value = hasRunnableCommands\.value \? 'console' : 'files'/.test(workspace),
  '选中父项目入口时的回落目标应为 Git，不是文件',
);

/***********************页签回退规则只有一份*********************/
// 回退判据已抽到 utils/workspaceTabFallback.ts，由「切换子项目」与「能力变化兜底」共用。
// 断言随之落到那个纯函数上，避免规则被复制回组件里各写一份。

assert(
  /if \(tab === 'console'\) return capabilities\.hasRunnableCommands/.test(tabFallback)
  && /if \(tab === 'env'\) return capabilities\.hasFrontendEnv/.test(tabFallback),
  '命令/环境入口带 v-if 会整个消失，对应页签必须判为不可用',
);

assert(
  /if \(capabilities\.leafTabsDisabled\) return 'files';[\s\S]{0,40}?return 'git';/.test(tabFallback),
  '页签不可用时应回退到 Git（仅无活动叶子时退到文件）；一律回退到文件会把默认页签的判断又冲掉',
);

assert(
  /resolveWorkspaceTabFallback\(activeTab\.value, tabCapabilities\.value\)/.test(managementPanel),
  '共享管理面板应复用 resolveWorkspaceTabFallback，不要另写一份回退规则',
);

assert(
  /navMemory\.getLeafTab\(project\.id\)/.test(managementPanel),
  '共享管理面板应优先恢复项目自己的页签记忆',
);

assert(
  /<ProjectManagementPanel :project="workspaceProject"\s*\/>/.test(workspace),
  '完整工作区应把当前项目交给共享管理面板',
);

// defaultTab 在 setup 期由 immediate watcher 同步求值，
// 其依赖的 hasRunnableCommands 必须先声明，否则无子项目的工作区会直接抛 TDZ 错误
assert(
  managementPanel.indexOf('const hasRunnableCommands = computed') < managementPanel.indexOf('const defaultTab = computed'),
  'hasRunnableCommands 必须声明在 defaultTab 之前，否则初始页签解析会撞上暂时性死区',
);

assert(/:project="workspaceProject"/.test(workspace), '文件和备忘录应使用当前项目实例');
assert(/SKIPPED_PREVIEW_LIMIT = 8/.test(calendar), '跳过项目应限制默认展示数量');
assert(/visibleSkippedProjects/.test(calendar) && /skippedExpanded/.test(calendar), '跳过项目应支持展开和收起');
assert(/scanFrontendEnvForProject\(newProject\.id\)/.test(projectStore), '新增子项目后应扫描环境配置');
assert(/--app-content-max:\s*1440px/.test(theme), '主要页面应共享最大内容宽度');
assert(/-webkit-backdrop-filter/.test(theme), '玻璃模糊应兼容桌面 WebView');

console.log('workspace style and capabilities tests passed');
