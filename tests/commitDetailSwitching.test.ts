import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

/***********************提交详情：左侧当天概览可切换右侧详情*********************/
// 详情弹窗不再只能看单条提交：打开时按日期取出当天全部提交，
// 点击左侧概览项直接切换右侧内容。这里锁住关键接线，避免被改回单条模式。

const view = readFileSync(resolve(process.cwd(), 'src/views/CommitCalendar.vue'), 'utf8');

assert(
  view.includes('resolveDayCommitItems(calendarDays.value, item)'),
  '打开详情时应按提交日期取出当天全部提交',
);
assert(
  /@click="selectDetailCommit\(item\)"/.test(view),
  '左侧概览项应能切换右侧详情',
);
assert(
  /v-for="item in detailDayItems"/.test(view),
  '左侧应遍历当天提交概览',
);
assert(
  /class="[^"]*commit-detail-layout/.test(view),
  '详情弹窗应为左右分栏布局',
);
assert(
  /detailDayItems\.value = \[\]/.test(view),
  '关闭弹窗时应清空当天概览，避免下次打开显示旧数据',
);
assert(
  !/width="560px"/.test(view),
  '弹窗宽度应容纳左侧概览，不能继续使用单栏宽度',
);

console.log('commitDetailSwitching tests passed');
