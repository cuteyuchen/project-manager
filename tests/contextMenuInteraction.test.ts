import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const fileTree = read('src/components/dashboard/FileTreeNode.vue');
const explorer = read('src/components/dashboard/WorkspaceProjectExplorer.vue');
const tauri = read('src/api/adapters/tauri.ts');
const runner = read('src-tauri/src/runner.rs');
const gitMenu = read('src/components/git/GitFileContextMenu.vue');
const history = read('src/components/git/GitHistory.vue');
const utools = read('utools/preload.js');
const ztools = read('ztools/preload.js');

assert(
  /function select\(\): void \{\s*if \(!props\.entry\.isDirectory\) emit\('selectFile'/.test(fileTree),
  '目录单击不应与双击共同翻转展开状态',
);
assert(fileTree.includes('@dblclick="open"'), '目录应通过双击执行展开/收起');
assert(explorer.includes('if (payload.isDirectory) await api.openFolder(target)'), '目录外部打开应使用文件夹 API');
assert(tauri.includes("return invoke('open_folder', { path });"), 'Tauri 文件夹打开应固定走后端 Explorer 命令');
assert(runner.includes('Command::new("explorer.exe")'), 'Windows 应显式调用 explorer.exe');
assert.match(runner, /windows_reveal_args|\.args\(args\)/, 'Windows 定位应通过参数数组传递目标路径');
assert.doesNotMatch(runner, /format!\("\/select,\\"\{target\}\\""\)/, 'Windows 定位参数不能把内嵌引号拼成单个参数');
assert(gitMenu.includes('function closeIgnoreSubmenu'), 'Ignore 二级菜单应有独立关闭动作');
assert(gitMenu.includes('@mouseenter="closeIgnoreSubmenu"'), '悬浮其他主菜单项时应关闭 Ignore 二级菜单');
assert(gitMenu.includes("document.addEventListener('wheel', closeOnViewportChange, true)"), 'Git 文件菜单应在滚轮时关闭');
assert(history.includes('clampContextMenuPosition'), 'Git History 菜单应限制在视口内');
assert(history.includes("document.addEventListener('scroll', closeOnViewportChange, true)"), 'Git History 菜单应在滚动时关闭');
assert(utools.includes("spawn('explorer.exe', [folderPath], { windowsHide: true });"), 'uTools Windows 文件夹打开应显式使用 Explorer');
assert(utools.includes('const target = fs.existsSync(normalized) ? normalized : path.dirname(normalized);'), 'uTools 定位不存在目标时应回退到父目录');
assert(utools.includes("spawn('explorer.exe', ['/select,', target]"), 'uTools 定位应使用分离的 /select 与目标参数');
assert.equal(utools, ztools, 'uTools 与 ZTools 的外部打开逻辑必须保持一致');

console.log('context menu interaction tests passed');
