import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const panel = readFileSync(
  resolve(process.cwd(), 'src/components/dashboard/ProjectManagementPanel.vue'),
  'utf8',
);

/***********************页签溢出按钮：比较后再写、RO 走 frame 调度、正确清理*********************/
assert.match(panel, /if \(nextCanScrollLeft !== canScrollLeft\.value\)/);
assert.match(panel, /if \(nextCanScrollRight !== canScrollRight\.value\)/);
assert.match(panel, /tabOverflowScheduler\.schedule/);
assert.match(panel, /tabOverflowScheduler\.cancel/);
assert.match(panel, /tabResizeObserver\?\.disconnect/);
assert.match(panel, /new ResizeObserver\(\(\) => tabOverflowScheduler\.schedule\(\)\)/);

// 左右按钮与平滑滚动必须保留
assert.match(panel, /v-show="canScrollLeft"/);
assert.match(panel, /v-show="canScrollRight"/);
assert.match(panel, /scrollBy\(\{ left: direction === 'left' \? -120 : 120, behavior: 'smooth' \}\)/);
assert.match(panel, /@scroll="checkTabOverflow"/);

// 不应再在 RO 回调里同步写按钮显隐
assert.ok(
  !panel.includes('new ResizeObserver(checkTabOverflow)'),
  'ResizeObserver 不应同步执行会改布局的 checkTabOverflow',
);

console.log('projectManagementTabOverflow tests passed');
