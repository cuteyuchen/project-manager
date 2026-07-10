import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const theme = readFileSync(resolve(process.cwd(), 'src/styles/theme.css'), 'utf8');

const dialogRule = theme.match(/\.el-dialog\s*\{([^}]*)\}/)?.[1] ?? '';
const overlayRule = theme.match(/\.el-overlay\s*\{([^}]*)\}/)?.[1] ?? '';

assert(/--app-dialog-surface:\s*rgba\(255, 255, 255, 0\.9\)/.test(theme), '浅色主题应定义高可读性的弹窗表面');
assert(/html\.dark[\s\S]*?--app-dialog-surface:\s*rgba\(17, 24, 39, 0\.92\)/.test(theme), '深色主题应定义独立的弹窗表面');
assert(/background:\s*var\(--app-dialog-surface\)/.test(dialogRule), '弹窗应使用独立的表面变量');
assert(/backdrop-filter:\s*blur\(20px\) saturate\(125%\)/.test(dialogRule), '弹窗应应用高斯模糊和饱和度增强');
assert(/-webkit-backdrop-filter:\s*blur\(20px\) saturate\(125%\)/.test(dialogRule), '弹窗应兼容 WebKit 背景模糊');
assert(/background-color:\s*var\(--app-dialog-overlay\)/.test(overlayRule), '遮罩层应使用主题化遮罩颜色');
assert(/backdrop-filter:\s*blur\(5px\)/.test(overlayRule), '遮罩层应轻度模糊后方内容');
assert(/-webkit-backdrop-filter:\s*blur\(5px\)/.test(overlayRule), '遮罩层应兼容 WebKit 背景模糊');

console.log('dialog backdrop tests passed');
