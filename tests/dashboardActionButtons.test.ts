import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const viewPresets = readFileSync(resolve(root, 'src/components/dashboard/ViewPresetChips.vue'), 'utf8');
const profiles = readFileSync(resolve(root, 'src/components/dashboard/WorkspaceProfileMenu.vue'), 'utf8');
const theme = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');

assert(/class="dashboard-secondary-action"/.test(viewPresets), '保存视图应使用统一次级操作按钮');
assert(/dashboard-secondary-action profile-create-button/.test(profiles), '新建启动组应使用统一次级操作按钮');
assert(/profile-add-item-button/.test(profiles), '启动组弹窗应使用独立的添加按钮样式');
assert(/:disabled="!newItemProjectId \|\| !newItemSelection"/.test(profiles), '未选择项目或命令时添加按钮应禁用');
assert(/min-height:\s*32px/.test(theme), '顶部次级按钮应保持统一高度');

console.log('dashboard action button tests passed');
