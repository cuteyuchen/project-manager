import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const runner = readFileSync(resolve(root, 'src-tauri/src/runner.rs'), 'utf8');
const consoleView = readFileSync(resolve(root, 'src/components/ConsoleView.vue'), 'utf8');
const projectStore = readFileSync(resolve(root, 'src/stores/project.ts'), 'utf8');
const apiTypes = readFileSync(resolve(root, 'src/api/types.ts'), 'utf8');
const tauriAdapter = readFileSync(resolve(root, 'src/api/adapters/tauri.ts'), 'utf8');
const utoolsAdapter = readFileSync(resolve(root, 'src/api/adapters/utools.ts'), 'utf8');
const utoolsPreload = readFileSync(resolve(root, 'utools/preload.js'), 'utf8');
const ztoolsPreload = readFileSync(resolve(root, 'ztools/preload.js'), 'utf8');

assert(/struct RunningProcess/.test(runner), 'ProcessState 必须保存 pid + stdin');
assert(/stdin:\s*Option<Arc<Mutex<ChildStdin>>>/.test(runner), 'RunningProcess.stdin 必须可写');
assert(/\.stdin\(Stdio::piped\(\)\)/.test(runner), 'project/custom command 必须 piped stdin');
assert(/pub fn send_project_input/.test(runner) && /pub fn close_project_input/.test(runner), '必须暴露 stdin API');
assert(/broken pipe/.test(runner), 'broken pipe 必须有明确错误');
assert(/commandKey 不存在/.test(runner), '缺失 commandKey 必须有明确错误');
assert(/struct StreamDecoder/.test(runner), '必须有 partial prompt decoder');
assert(/"partial": true/.test(runner), '无换行 prompt 必须 emit partial');

assert(/sendProjectInput/.test(apiTypes) && /closeProjectInput/.test(apiTypes), 'PlatformAPI 三端必须有 stdin 签名');
assert(/sendProjectInput/.test(tauriAdapter) && /sendProjectInput/.test(utoolsAdapter), 'Tauri/uTools adapter 必须实现 stdin');
assert(/sendProjectInput/.test(utoolsPreload) && /sendProjectInput/.test(ztoolsPreload), '插件 preload 必须实现 stdin');
assert(/attachProcessIo/.test(utoolsPreload), '插件必须用 chunk decoder，而不是只按 data.toString 整段刷');
assert.equal(utoolsPreload, ztoolsPreload, '两个插件 preload 必须一致');

assert(/stdinPlaceholder/.test(consoleView), 'Console 必须有运行中输入条');
assert(/handleStdinKeydown/.test(consoleView), 'Enter 发送、Esc 不发送');
assert(/partialOutput/.test(projectStore), 'partial prompt 不能写进持久 logs');
assert(/sendProjectInput\(commandKey, `\$\{stdinInput\.value\}\\n`\)/.test(consoleView), 'Enter 必须写 input + newline');

console.log('console stdin tests passed');
