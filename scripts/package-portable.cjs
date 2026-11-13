#!/usr/bin/env node
/**
 * 打包 Windows 免安装便携版。
 *
 * 输入是 `tauri build`（或 `tauri build --no-bundle`）产出的主程序 exe，
 * 输出 `dist-portable/project-manager_<version>_<target>-portable.zip`，
 * 解压即用，不进注册表、不产生卸载项。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXE_NAME = 'project-manager.exe';
const README_NAME = '便携版说明.txt';

function parseArgs(argv) {
    const options = {
        version: null,
        target: process.arch === 'arm64' ? 'arm64' : 'x64',
        exe: null,
        outDir: path.join(ROOT_DIR, 'dist-portable'),
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const readValue = (name) => {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
            return value;
        };
        if (arg === '--version') options.version = readValue(arg);
        else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length);
        else if (arg === '--target') options.target = readValue(arg);
        else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
        else if (arg === '--exe') options.exe = path.resolve(ROOT_DIR, readValue(arg));
        else if (arg.startsWith('--exe=')) options.exe = path.resolve(ROOT_DIR, arg.slice('--exe='.length));
        else if (arg === '--out-dir') options.outDir = path.resolve(ROOT_DIR, readValue(arg));
        else if (arg.startsWith('--out-dir=')) options.outDir = path.resolve(ROOT_DIR, arg.slice('--out-dir='.length));
        else throw new Error(`Unknown portable packaging argument: ${arg}`);
    }

    return options;
}

function readVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    if (!pkg.version) throw new Error('package.json is missing version.');
    return pkg.version;
}

function defaultExeCandidates(target) {
    return [
        path.join(ROOT_DIR, 'src-tauri', 'target', 'release', EXE_NAME),
        path.join(ROOT_DIR, 'src-tauri', 'target', `${target}-pc-windows-msvc`, 'release', EXE_NAME),
        path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'Project Manager.exe'),
    ];
}

function resolveExe(explicitPath, target) {
    if (explicitPath) {
        if (!fs.existsSync(explicitPath)) throw new Error(`Executable not found: ${explicitPath}`);
        return explicitPath;
    }
    const found = defaultExeCandidates(target).find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error(
            `Executable not found. Run "npm run tauri build -- --no-bundle" first, or pass --exe <path>.\n`
            + `Looked for:\n${defaultExeCandidates(target).map((item) => `  ${item}`).join('\n')}`,
        );
    }
    return found;
}

function buildReadme(version) {
    return `Project Manager 便携版 v${version}
================================

1. 免安装
   解压到任意目录，双击 ${EXE_NAME} 即可运行。不会写注册表，也不会产生卸载项；
   不需要时直接删除整个文件夹即可。

2. 运行环境
   Windows 10 1809+ / Windows 11，需要系统已安装 Microsoft Edge WebView2 Runtime。
   Windows 11 与大部分 Windows 10 已自带；若启动后白屏或提示缺少组件，请安装：
   https://go.microsoft.com/fwlink/p/?LinkId=2124703

3. 数据位置
   %APPDATA%\\com.cuteyuchen.project-manager
   便携版与安装版共用同一份 data.json；如需完全隔离，请先备份该目录。

4. 更新方式
   下载新版本的 portable 压缩包，用其中的 ${EXE_NAME} 覆盖旧文件即可。
   应用内的“检查更新”会下载安装包并按普通版本安装，便携版建议直接替换文件。

5. 校验
   压缩包与安装包来自同一次构建，版本号应与 GitHub Release 的标签一致。
`;
}

function quotePowerShell(value) {
    return `'${value.replace(/'/g, "''")}'`;
}

function zipDirectory(sourceDir, zipPath) {
    fs.rmSync(zipPath, { force: true });

    if (process.platform === 'win32') {
        const command = [
            'Add-Type -AssemblyName System.IO.Compression.FileSystem',
            `[System.IO.Compression.ZipFile]::CreateFromDirectory(${quotePowerShell(sourceDir)}, ${quotePowerShell(zipPath)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
        ].join('; ');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            stdio: 'inherit',
        });
        return;
    }

    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: sourceDir, stdio: 'inherit' });
}

function packagePortable(options = {}) {
    if (process.platform !== 'win32') {
        throw new Error('Portable packaging currently targets Windows builds only.');
    }

    const version = options.version || readVersion();
    const target = options.target || 'x64';
    const exePath = resolveExe(options.exe, target);
    const outDir = options.outDir || path.join(ROOT_DIR, 'dist-portable');
    const stageName = `project-manager_${version}_${target}-portable`;
    const stageDir = path.join(outDir, stageName);
    const zipPath = `${stageDir}.zip`;

    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });

    fs.copyFileSync(exePath, path.join(stageDir, EXE_NAME));
    fs.writeFileSync(path.join(stageDir, README_NAME), buildReadme(version), 'utf8');

    zipDirectory(stageDir, zipPath);

    const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`Portable package: ${path.relative(ROOT_DIR, zipPath)} (${sizeMb} MB)`);
    console.log(`  from: ${path.relative(ROOT_DIR, exePath)}`);
    return { zipPath, stageDir, version, target };
}

function runCli(argv = process.argv.slice(2)) {
    try {
        packagePortable(parseArgs(argv));
    } catch (error) {
        console.error(`\nPortable packaging failed: ${error.message}`);
        process.exitCode = 1;
    }
}

if (require.main === module) runCli();

module.exports = { parseArgs, packagePortable, buildReadme, EXE_NAME, README_NAME };
