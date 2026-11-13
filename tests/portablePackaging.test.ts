import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/***********************便携版打包（仅 Windows 产物）*********************/
// 校验发布脚本能从一个 exe 产出可解压的 zip，并且说明文件版本号跟随参数。

if (process.platform !== 'win32') {
  console.log('portablePackaging tests skipped (windows only)');
  process.exit(0);
}

const root = process.cwd();
const script = resolve(root, 'scripts/package-portable.cjs');
const workspace = mkdtempSync(join(tmpdir(), 'pm-portable-'));

try {
  const fakeExe = join(workspace, 'project-manager.exe');
  writeFileSync(fakeExe, Buffer.from('MZ fake executable for portable packaging test'));

  const outDir = join(workspace, 'out');
  mkdirSync(outDir, { recursive: true });

  execFileSync(process.execPath, [
    script,
    '--version', '9.9.9',
    '--target', 'x64',
    '--exe', fakeExe,
    '--out-dir', outDir,
  ], { cwd: root, stdio: 'pipe' });

  const zipPath = join(outDir, 'project-manager_9.9.9_x64-portable.zip');
  assert(existsSync(zipPath), '应产出 project-manager_<version>_<target>-portable.zip');
  assert(statSync(zipPath).size > 100, 'zip 不应为空');

  const zipBuffer = readFileSync(zipPath);
  assert(zipBuffer.includes(Buffer.from('project-manager.exe')), 'zip 内应包含主程序');
  assert(zipBuffer.includes(Buffer.from('便携版说明.txt', 'utf8')), 'zip 内应包含便携版说明');

  const readme = readFileSync(join(outDir, 'project-manager_9.9.9_x64-portable', '便携版说明.txt'), 'utf8');
  assert(readme.includes('9.9.9'), '说明文件应写入版本号');
  assert(readme.includes('免安装'), '说明文件应说明免安装特性');
  assert(readme.includes('WebView2'), '说明文件应提示 WebView2 运行库');

  console.log('portablePackaging tests passed');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
