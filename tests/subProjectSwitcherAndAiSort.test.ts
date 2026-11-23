import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Project, WorkspaceTab } from '../src/types.ts';
import { useNavMemoryStore } from '../src/stores/navMemory.ts';
import { setActivePinia, createPinia } from 'pinia';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

const subSwitcher = read('src/components/dashboard/SubProjectSwitcher.vue');
const panel = read('src/components/dashboard/ProjectManagementPanel.vue');
const settingsView = read('src/views/Settings.vue');
const navMemorySource = read('src/stores/navMemory.ts');

/***********************1. 快捷切换项目按钮高度与文字完整展示*********************/
// 按钮高度增加（至少 28px），不设置 240px 限制，项目名称和分支名不截断省略
assert(/height:\s*28px/.test(subSwitcher), '胶囊高度应增加到至少 28px');
assert(!/max-width:\s*240px/.test(subSwitcher), '胶囊不应限制 240px 最大宽度');
assert(!/\.sub-project-chip-name\s*\{[^}]*text-overflow:\s*ellipsis/s.test(subSwitcher), '项目名称不应使用省略号截断');
assert(!/\.sub-project-chip-branch-name\s*\{[^}]*text-overflow:\s*ellipsis/s.test(subSwitcher), '分支名称不应使用省略号截断');
assert(/white-space:\s*nowrap/.test(subSwitcher), '项目名与分支名应单行完整呈现');

/***********************2. 切换项目记住每个项目上次选中的菜单*********************/
// Mock localStorage
const storageMock: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => storageMock[key] ?? null,
  setItem: (key: string, value: string) => { storageMock[key] = value; },
  removeItem: (key: string) => { delete storageMock[key]; },
  clear: () => { Object.keys(storageMock).forEach(k => delete storageMock[k]); },
};

setActivePinia(createPinia());
const navMemory = useNavMemoryStore();

// 记忆读写与持久化验证
navMemory.rememberLeafTab('project-a', 'git');
assert.equal(navMemory.getLeafTab('project-a'), 'git', '应能读取 project-a 记住的 git 页签');
assert(storageMock['pm:workspace_leaf_tab']?.includes('"project-a":"git"'), '应同步持久化到 localStorage');

navMemory.rememberLeafTab('project-b', 'console');
assert.equal(navMemory.getLeafTab('project-b'), 'console', '应能读取 project-b 记住的 console 页签');

// 验证 ProjectManagementPanel 中切换项目优先使用目标项目的 rememberedTab
assert(
  /preferredTab = projectChanged\s*\?\s*rememberedTab\s*:\s*\(firstActivation\s*\?\s*\(props\.initialTab\s*\?\?\s*rememberedTab\)\s*:\s*activeTab\.value\)/.test(panel),
  '切换项目时应恢复目标项目自身的 rememberedTab，而不是继承上一项目的 activeTab',
);

/***********************3. 设置中 AI 生成提交信息的拖拽排序模型*********************/
// 校验 dragover 设置 dropEffect = 'move'
assert(
  /onModelDragOver[\s\S]*?e\.dataTransfer\.dropEffect\s*=\s*'move'/.test(settingsView),
  '单渠道模型 dragover 必须设置 dropEffect = move 允许放置',
);
assert(
  /onChannelDragOver[\s\S]*?e\.dataTransfer\.dropEffect\s*=\s*'move'/.test(settingsView),
  '多渠道列表 dragover 必须设置 dropEffect = move 允许放置',
);

// 校验 drop 逻辑与状态重置
assert(/moveAiModelSlot/.test(settingsView), '应提供移动模型顺序的函数');
assert(/moveAiChannelSlot/.test(settingsView), '应提供移动渠道顺序的函数');

// 校验防止子元素阻挡拖放的样式与手柄样式
assert(/\.drag-handle\s*\{[^}]*cursor:\s*grab/s.test(settingsView), '拖拽手柄应设置 grab 光标');
assert(/\.drag-handle\s*\*\s*\{[^}]*pointer-events:\s*none/s.test(settingsView), '拖拽手柄内部图标应禁止 pointer-events 避免拦截');
assert(
  /is-dragging-models[\s\S]*?pointer-events:\s*none/.test(settingsView),
  '拖拽中应屏蔽输入框 pointer-events，防止拦截 drop 事件或触发输入框文本拖入',
);

console.log('All subProjectSwitcherAndAiSort tests passed!');
