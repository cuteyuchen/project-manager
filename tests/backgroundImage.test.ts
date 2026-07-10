import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createImageDataUrl, inferImageMimeType } from '../src/utils/backgroundImage.ts';

assert.equal(inferImageMimeType('C:/wallpaper/photo.JPG'), 'image/jpeg');
assert.equal(inferImageMimeType('/tmp/background.webp'), 'image/webp');
assert.equal(createImageDataUrl('background.png', 'YWJj'), 'data:image/png;base64,YWJj');

const root = process.cwd();
const settingsStore = readFileSync(resolve(root, 'src/stores/settings.ts'), 'utf8');
const settingsView = readFileSync(resolve(root, 'src/views/Settings.vue'), 'utf8');
const themeCss = readFileSync(resolve(root, 'src/styles/theme.css'), 'utf8');
const appView = readFileSync(resolve(root, 'src/App.vue'), 'utf8');

assert(/api\.readBinaryFileBase64\(imagePath\)/.test(settingsStore), '设置应用时应读取背景图片数据');
assert(/preparedDataUrl/.test(settingsStore), '设置页应能使用已读取的数据即时预览全局背景');
assert(/backgroundImageDataUrl = ref\(''\)/.test(settingsStore), '背景图片数据应保存在响应式状态中');
assert(/classList\.add\('has-custom-background'\)/.test(settingsStore), '背景加载成功后应启用自定义背景样式');
assert(/selectBackgroundImage/.test(settingsView) && /clearBackgroundImage/.test(settingsView), '设置页应支持选择和清除背景图片');
assert(/backgroundImageOpacity/.test(settingsView), '设置页应支持调节背景图片强度');
assert(/@input="previewBackgroundOpacity"/.test(settingsView), '拖动背景强度时应即时更新全局预览');
assert(/app-background-layer/.test(appView), '应用模板应包含真实的全局背景层');
assert(/:style="appBackgroundStyle"/.test(appView), '全局背景应由 App 直接绑定到真实背景层');
assert(/\.app-background-layer/.test(themeCss), '全局背景应通过应用壳层内的真实元素绘制');
assert(/html\.has-custom-background\s*\{[^}]*--app-surface:\s*rgba/s.test(themeCss), '自定义背景模式应统一使用半透明语义表面');

console.log('background image tests passed');
