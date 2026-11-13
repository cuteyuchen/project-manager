import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPortableDownloadUrl } from '../src/utils/updateChannel.ts';

/***********************便携版更新分流*********************/
// 便携版不能走 NSIS 安装器，否则会被装成普通版本；这里锁住行为与下载地址。

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

const EXPECTED = 'https://github.com/cuteyuchen/project-manager/releases/download/v1.7.6/project-manager_1.7.6_x64-portable.zip';
assert.equal(buildPortableDownloadUrl('1.7.6'), EXPECTED);
assert.equal(buildPortableDownloadUrl('v1.7.6'), EXPECTED, '带 v 前缀也应生成同一地址');
assert.equal(buildPortableDownloadUrl(' 1.7.6 '), EXPECTED, '版本号两端空白应被忽略');

const appVue = read('src/App.vue');
assert(
  /if \(isPortableMode\.value\) \{\s*await promptPortableUpdate\(update, version\);/.test(appVue),
  '检查更新必须先判断便携版并走独立分支',
);
assert(
  /async function promptPortableUpdate\(update: Update, version: string\) \{[\s\S]*?update\.close\(\)/.test(appVue),
  '便携版分支应关闭更新句柄',
);
const portablePrompt = appVue.match(/async function promptPortableUpdate[\s\S]*?\n\}/)?.[0] || '';
assert(!/update\.download\(/.test(portablePrompt), '便携版分支不得调用更新下载');
assert(!/update\.install\(/.test(portablePrompt), '便携版分支不得调用安装器');
assert(/loadAppMode\(\)/.test(appVue), '启动时应先探测运行形态再检查更新');

const rustLib = read('src-tauri/src/lib.rs');
assert(/fn is_portable_build\(\) -> bool/.test(rustLib), 'Rust 应提供便携版探测命令');
assert(rustLib.includes('portable.marker'), '便携版应通过 portable.marker 识别');
assert(/is_portable_build,/.test(rustLib), '探测命令必须在 generate_handler 中注册');

const apiTypes = read('src/api/types.ts');
assert(/isPortableBuild\(\): Promise<boolean>/.test(apiTypes), 'PlatformAPI 应暴露运行形态查询');
assert(/invoke\('is_portable_build'\)/.test(read('src/api/adapters/tauri.ts')), 'Tauri 适配器应调用 Rust 命令');
assert(
  /isPortableBuild\(\): Promise<boolean> \{ return Promise\.resolve\(false\); \}/.test(read('src/api/adapters/utools.ts')),
  '插件版不存在便携版概念，固定返回 false',
);

const settings = read('src/views/Settings.vue');
assert(settings.includes("t('settings.portableUpdateHint')"), '设置页应说明便携版更新方式');
assert(settings.includes('isPortable'), '设置页应读取运行形态');

console.log('portableUpdateFlow tests passed');
