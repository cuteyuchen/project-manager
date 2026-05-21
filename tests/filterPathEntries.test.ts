/**
 * 终端 PATH 过滤逻辑（filterPathEntries）单元测试
 *
 * 验收场景：
 * 1. 项目 nodeDir 在最终 PATH 中排第一且不重复
 * 2. 原始 PATH 中有其它 Node/npm 目录时，输出 PATH 不包含这些目录
 * 3. 普通工具目录保留
 * 4. 空 PATH / 空条目正确处理
 * 5. Windows 风格路径比较（大小写、斜杠方向）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function assert(condition: unknown, message: string) {
    if (!condition) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

function assertEq<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(
            `ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
        );
    }
}

/***********************从 preload.js 中复刻的纯逻辑函数，保持一致*********************/

function dirHasNodeTools(dir: string): boolean {
    try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    } catch (_) {
        return false;
    }
    const names =
        process.platform === 'win32'
            ? ['node.exe', 'npm.cmd', 'npm.exe', 'npx.cmd', 'pnpm.cmd', 'yarn.cmd', 'cnpm.cmd']
            : ['node', 'npm', 'npx', 'pnpm', 'yarn', 'cnpm'];
    return names.some((n) => {
        try {
            return fs.existsSync(path.join(dir, n));
        } catch (_) {
            return false;
        }
    });
}

function normalizePathStr(s: string): string {
    if (process.platform === 'win32') {
        return s.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
    }
    return s.replace(/\/+$/, '');
}

function filterPathEntries(nodeDir: string, pathValue: string): string {
    const nodeDirNorm = normalizePathStr(nodeDir);
    return pathValue
        .split(path.delimiter)
        .filter((entry) => {
            const e = entry.trim();
            if (!e) return false;
            if (normalizePathStr(e) === nodeDirNorm) return false;
            if (dirHasNodeTools(e)) return false;
            return true;
        })
        .join(path.delimiter);
}

function buildTerminalPathEnv(nodeDir: string, pathValue: string): string {
    const filtered = filterPathEntries(nodeDir, pathValue);
    return filtered ? `${nodeDir}${path.delimiter}${filtered}` : nodeDir;
}

/***********************测试辅助：创建临时目录结构*********************/

function mkTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touchFile(dir: string, name: string) {
    fs.writeFileSync(path.join(dir, name), '');
}

function cleanDir(dir: string) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

/***********************测试用例*********************/

const tempDirs: string[] = [];

function setup() {
    // projectNodeDir: 项目 Node 目录，含 node 可执行文件
    const projectNodeDir = mkTempDir('pm-test-project-node-');
    tempDirs.push(projectNodeDir);
    if (process.platform === 'win32') {
        touchFile(projectNodeDir, 'node.exe');
        // 项目 Node 14 没有 npm → 不放 npm.cmd
    } else {
        touchFile(projectNodeDir, 'node');
    }

    // otherNodeDir: 其它 Node 目录（如 D:\nvm\v22.18.0），含 node + npm
    const otherNodeDir = mkTempDir('pm-test-other-node-');
    tempDirs.push(otherNodeDir);
    if (process.platform === 'win32') {
        touchFile(otherNodeDir, 'node.exe');
        touchFile(otherNodeDir, 'npm.cmd');
        touchFile(otherNodeDir, 'npx.cmd');
    } else {
        touchFile(otherNodeDir, 'node');
        touchFile(otherNodeDir, 'npm');
        touchFile(otherNodeDir, 'npx');
    }

    // pnpmDir: 含 pnpm 的目录
    const pnpmDir = mkTempDir('pm-test-pnpm-');
    tempDirs.push(pnpmDir);
    if (process.platform === 'win32') {
        touchFile(pnpmDir, 'pnpm.cmd');
    } else {
        touchFile(pnpmDir, 'pnpm');
    }

    // normalDir: 普通工具目录（如 C:\Windows\system32），不含 Node 相关
    const normalDir = mkTempDir('pm-test-normal-');
    tempDirs.push(normalDir);
    touchFile(normalDir, 'git.exe');
    touchFile(normalDir, 'curl.exe');

    // normalDir2: 第二个普通目录
    const normalDir2 = mkTempDir('pm-test-normal2-');
    tempDirs.push(normalDir2);
    touchFile(normalDir2, 'python.exe');

    return { projectNodeDir, otherNodeDir, pnpmDir, normalDir, normalDir2 };
}

function teardown() {
    for (const d of tempDirs) {
        cleanDir(d);
    }
    tempDirs.length = 0;
}

/***********************运行测试*********************/

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  [PASS] ${name}`);
        passed++;
    } catch (e: any) {
        console.error(`  [FAIL] ${name}`);
        console.error(`     ${e.message}`);
        failed++;
    }
}

console.log('\n=== filterPathEntries 测试 ===\n');

const dirs = setup();

test('1. 其它 Node/npm 目录被过滤', () => {
    const sep = path.delimiter;
    const original = [dirs.otherNodeDir, dirs.normalDir, dirs.normalDir2].join(sep);
    const result = filterPathEntries(dirs.projectNodeDir, original);
    const entries = result.split(sep);
    assert(!entries.includes(dirs.otherNodeDir), '其它 Node 目录应被过滤');
    assert(entries.includes(dirs.normalDir), '普通目录应保留');
    assert(entries.includes(dirs.normalDir2), '普通目录 2 应保留');
});

test('2. 最终 PATH 中项目 nodeDir 排第一且不重复', () => {
    const sep = path.delimiter;
    const original = [dirs.projectNodeDir, dirs.otherNodeDir, dirs.normalDir].join(sep);
    const result = buildTerminalPathEnv(dirs.projectNodeDir, original);
    const entries = result.split(sep);
    assertEq(entries[0], dirs.projectNodeDir, '项目 nodeDir 应排第一');
    assertEq(entries.filter((item) => item === dirs.projectNodeDir).length, 1, '项目 nodeDir 不应重复');
    assert(!entries.includes(dirs.otherNodeDir), '其它 Node 目录应被过滤');
    assert(entries.includes(dirs.normalDir), '普通目录应保留');
});

test('3. pnpm 目录也被过滤', () => {
    const sep = path.delimiter;
    const original = [dirs.pnpmDir, dirs.normalDir].join(sep);
    const result = filterPathEntries(dirs.projectNodeDir, original);
    const entries = result.split(sep);
    assert(!entries.includes(dirs.pnpmDir), 'pnpm 目录应被过滤');
    assert(entries.includes(dirs.normalDir), '普通目录应保留');
});

test('4. 空 PATH 返回空字符串', () => {
    const result = filterPathEntries(dirs.projectNodeDir, '');
    assertEq(result, '', '空 PATH 应返回空');
});

test('5. 只有项目 nodeDir 的 PATH', () => {
    const result = buildTerminalPathEnv(dirs.projectNodeDir, dirs.projectNodeDir);
    assertEq(result, dirs.projectNodeDir, '仅含项目 nodeDir 应原样返回');
});

test('6. 多个 Node 目录全部被过滤，普通目录保留', () => {
    const sep = path.delimiter;
    const original = [dirs.otherNodeDir, dirs.pnpmDir, dirs.normalDir].join(sep);
    const result = filterPathEntries(dirs.projectNodeDir, original);
    const entries = result.split(sep);
    assertEq(entries.length, 1, '应只剩一个普通目录');
    assertEq(entries[0], dirs.normalDir, '保留的应是普通目录');
});

test('7. 不存在的目录保留（不会被误判为 Node 目录）', () => {
    const sep = path.delimiter;
    const fakePath = path.join(os.tmpdir(), 'pm-test-nonexistent-12345');
    const original = [fakePath, dirs.normalDir].join(sep);
    const result = filterPathEntries(dirs.projectNodeDir, original);
    const entries = result.split(sep);
    assert(entries.includes(fakePath), '不存在的目录应保留');
    assert(entries.includes(dirs.normalDir), '普通目录应保留');
});

if (process.platform === 'win32') {
    test('8. Windows 路径大小写不敏感比较', () => {
        const sep = path.delimiter;
        const upperCaseDir = dirs.projectNodeDir.toUpperCase();
        const original = [upperCaseDir, dirs.normalDir].join(sep);
        const result = buildTerminalPathEnv(dirs.projectNodeDir, original);
        const entries = result.split(sep);
        assertEq(entries[0], dirs.projectNodeDir, '大小写不同的项目 nodeDir 最终应使用标准项目 nodeDir');
        assert(!entries.includes(upperCaseDir), '原 PATH 中大小写不同的项目 nodeDir 不应重复保留');
    });
}

test('9. dirHasNodeTools 对项目目录（只含 node，无 npm）返回 true', () => {
    // 项目目录含 node 可执行文件，所以 dirHasNodeTools 返回 true
    // 但 filterPathEntries 通过路径比较跳过它
    assert(dirHasNodeTools(dirs.projectNodeDir), '含 node 的目录应检测为 Node 工具目录');
});

test('10. dirHasNodeTools 对普通目录返回 false', () => {
    assert(!dirHasNodeTools(dirs.normalDir), '普通目录不应被检测为 Node 工具目录');
});

teardown();

console.log(`\n总计: ${passed} 通过, ${failed} 失败\n`);

if (failed > 0) {
    process.exit(1);
}
