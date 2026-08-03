/**
 * 让 ZTools 的 preload.js 与 uTools 的保持逐字节一致。
 *
 * 两个插件运行时的能力完全相同，preload 也一直是同一份实现的两个副本
 * （历史上曾因手工改单边而分叉过：ZTools 少了 6 个静态资源忽略目录）。
 * 因此把 utools/preload.js 当作唯一事实源，ZTools 一侧只做镜像。
 *
 * 改动流程：先改 utools/preload.js，再跑本脚本同步。
 * 校验由 tests/terminalNodeInjection.test.ts 的字节比对与
 * scripts/verify-preload-scanner.mjs 的行为比对共同守住。
 *
 * 用法：node scripts/sync-preload-scanner.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'utools/preload.js';
const MIRROR = 'ztools/preload.js';

const source = readFileSync(resolve(root, SOURCE), 'utf8');
const mirror = readFileSync(resolve(root, MIRROR), 'utf8');

if (source === mirror) {
  console.log(`${MIRROR} 已与 ${SOURCE} 一致，无需同步`);
} else {
  writeFileSync(resolve(root, MIRROR), source, 'utf8');
  console.log(`已同步 ${SOURCE} → ${MIRROR}`);
}
