import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
const tauri = read('src/api/adapters/tauri.ts');
const runner = read('src-tauri/src/runner.rs');
const lib = read('src-tauri/src/lib.rs');
const capabilities = read('src-tauri/capabilities/default.json');

const openPathMethod = tauri.slice(tauri.indexOf('async openPath'), tauri.indexOf('async revealInFolder'));
assert.match(openPathMethod, /return invoke\('open_path', \{ path \}\)/, 'Tauri Adapter.openPath 必须调用受控 backend');
assert.doesNotMatch(openPathMethod, /opener|openUrlFn/, '任意项目文件不能继续依赖 opener plugin');
assert.match(runner, /pub fn open_path\(path: String\) -> Result<\(\), String\>/, 'runner 必须实现 open_path 命令');
assert(runner.includes('validate_existing_absolute_path'), 'open_path 必须校验非空、绝对路径和存在性');
assert(runner.includes('ShellExecuteW'), 'Windows open_path 必须使用参数化系统 API');
assert.match(runner, /Command::new\("open"\)[\s\S]*\.arg\(target\.as_os_str\(\)\)/, 'macOS open_path 必须参数化传入路径');
assert.match(runner, /Command::new\("xdg-open"\)[\s\S]*\.arg\(target\.as_os_str\(\)\)/, 'Linux open_path 必须参数化传入路径');
assert(lib.includes('runner::open_path'), 'open_path 必须注册到 generate_handler');
assert(!capabilities.includes('opener:allow-open-path'), '不能通过扩大 opener capability 解决任意项目文件打开');
assert.match(runner, /windows_reveal_args[\s\S]*OsString::from\("\/select,"\)[\s\S]*path\.as_os_str\(\)\.to_os_string\(\)/, 'Windows reveal 必须拆分 /select, 和目标参数');
assert.doesNotMatch(runner, /format!\("\/select,\\"\{target\}\\""\)/, 'Windows reveal 禁止拼接内嵌引号参数');

console.log('Tauri open path architecture tests passed');
