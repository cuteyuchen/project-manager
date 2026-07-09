import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const source = readFileSync(resolve(process.cwd(), 'src/components/ProjectGroupManager.vue'), 'utf8');

/***********************新增分组操作区布局*********************/

const addGroupBlock = source.match(/<!-- 新增分组 -->[\s\S]*?<!-- 添加按钮 -->/)?.[0] ?? '';

assert(
  addGroupBlock.includes('class="group-add-actions"'),
  '新增分组确认/取消按钮应放在独立操作区，避免挤压输入框 append 插槽',
);

assert(
  !/<template\s+#append>[\s\S]*confirmAddGroup[\s\S]*cancelAddGroup[\s\S]*<\/template>/.test(addGroupBlock),
  '新增分组不应把确认/取消文字按钮放进 el-input append 插槽',
);

console.log('projectGroupManagerLayout tests passed');
