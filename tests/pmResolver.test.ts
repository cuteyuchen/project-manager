/**
 * 包管理器解析器（pmResolver）单元测试
 *
 * 测试验收场景：
 * 1. 当前 Node 有 PM，来源 project → 命令可用
 * 2. 当前 Node 无 PM，默认 Node 有 PM，来源 project → 命令禁用
 * 3. 当前 Node 无 PM，默认 Node 有 PM，来源 default → 命令可用，且 Node 仍是项目 Node
 * 4. 当前 Node 和默认 Node 都无 PM → 命令禁用
 * 5. npm 也必须真实存在，不能默认视为可用
 */

import {
    findPmInEntries,
    resolvePackageManager,
    getPmDisabledReason,
    getPmAvailabilitySuffix,
} from '../src/utils/pmResolver';
import type { PackageManagerResolveResult } from '../src/api/types';

function assert(condition: unknown, message: string) {
    if (!condition) {
        throw new Error(`ASSERTION FAILED: ${message}`);
    }
}

function assertEq<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`ASSERTION FAILED: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

/** 模拟 checkEntries 回调：返回预设的目录内容 */
function mockCheckEntries(dirContents: Record<string, string[]>) {
    return async (dirPath: string): Promise<string[]> => {
        return dirContents[dirPath] || [];
    };
}

/*********************** findPmInEntries *********************/

{
    // Windows: pnpm.cmd 存在 → 返回 'pnpm'
    const entries = ['node.exe', 'npm.cmd', 'pnpm.cmd', 'yarn.cmd'];
    const result = findPmInEntries('pnpm', entries, true);
    assertEq(result, 'pnpm', 'Windows: pnpm.cmd found → returns pnpm');
}

{
    // Windows: pnpm.exe 存在 → 返回 'pnpm'
    const entries = ['node.exe', 'npm.cmd', 'pnpm.exe'];
    const result = findPmInEntries('pnpm', entries, true);
    assertEq(result, 'pnpm', 'Windows: pnpm.exe found → returns pnpm');
}

{
    // Windows: yarn 不存在 → 返回 null
    const entries = ['node.exe', 'npm.cmd'];
    const result = findPmInEntries('yarn', entries, true);
    assertEq(result, null, 'Windows: yarn not found → returns null');
}

{
    // Unix: pnpm 存在 → 返回 'pnpm'
    const entries = ['node', 'npm', 'pnpm'];
    const result = findPmInEntries('pnpm', entries, false);
    assertEq(result, 'pnpm', 'Unix: pnpm found → returns pnpm');
}

{
    // Unix: yarn 不存在 → 返回 null
    const entries = ['node', 'npm'];
    const result = findPmInEntries('yarn', entries, false);
    assertEq(result, null, 'Unix: yarn not found → returns null');
}

{
    // Windows: npm.cmd 存在 → 返回 'npm'
    const entries = ['node.exe', 'npm.cmd'];
    const result = findPmInEntries('npm', entries, true);
    assertEq(result, 'npm', 'Windows: npm.cmd found → returns npm');
}

{
    // Unix: npm 存在 → 返回 'npm'
    const entries = ['node', 'npm', 'npx'];
    const result = findPmInEntries('npm', entries, false);
    assertEq(result, 'npm', 'Unix: npm found → returns npm');
}

/*********************** resolvePackageManager 场景 1: 当前 Node 有 PM，来源 project *********************/

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd', 'pnpm.cmd'],
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true, // Windows
    );

    assertEq(result.available, true, '场景1: 当前Node有pnpm, source=project → available=true');
    assertEq(result.commandPath, 'pnpm', '场景1: commandPath=pnpm');
    assertEq(result.reason, undefined, '场景1: reason=undefined');
}

/*********************** resolvePackageManager 场景 2: 当前 Node 无 PM，默认 Node 有 PM，来源 project *********************/

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd'], // 无 pnpm
        'C:/nvm/v20': ['node.exe', 'npm.cmd', 'pnpm.cmd'], // 有 pnpm
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, '场景2: 当前Node无pnpm, source=project → available=false');
    assertEq(result.reason, 'pm_not_installed_in_project_node', '场景2: reason=pm_not_installed_in_project_node');
}

/*********************** resolvePackageManager 场景 3: 当前 Node 无 PM，默认 Node 有 PM，来源 default *********************/

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd'], // 无 pnpm
        'C:/nvm/v20': ['node.exe', 'npm.cmd', 'pnpm.cmd'], // 有 pnpm
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'default',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, true, '场景3: 默认Node有pnpm, source=default → available=true');
    assertEq(result.commandPath, 'pnpm', '场景3: commandPath=pnpm（来自默认Node）');
    assertEq(result.reason, undefined, '场景3: reason=undefined');
}

/*********************** resolvePackageManager 场景 4: 当前和默认 Node 都无 PM *********************/

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd'], // 无 pnpm
        'C:/nvm/v20': ['node.exe', 'npm.cmd'], // 也无 pnpm
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'default',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, '场景4: 两端都无pnpm, source=default → available=false');
    assertEq(result.reason, 'pm_not_installed_in_default_node', '场景4: reason=pm_not_installed_in_default_node');
}

{
    // 同场景，source=project
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd'],
        'C:/nvm/v20': ['node.exe', 'npm.cmd'],
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, '场景4b: 两端都无pnpm, source=project → available=false');
}

/*********************** resolvePackageManager: npm 也必须真实可用 *********************/

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe'], // 没有 npm.cmd
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'npm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, 'npm 缺少入口文件时不可用');
    assertEq(result.reason, 'pm_not_installed_in_project_node', 'npm 缺失时 reason=pm_not_installed_in_project_node');
}

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe'],
        'C:/nvm/v20': ['node.exe'], // 默认 Node 也没有 npm.cmd
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'npm',
            source: 'default',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, '默认 Node 缺少 npm 入口文件时不可用');
    assertEq(result.reason, 'pm_not_installed_in_default_node', '默认 Node npm 缺失时 reason=pm_not_installed_in_default_node');
}

{
    const dirContents: Record<string, string[]> = {
        'C:/nvm/v18': ['node.exe', 'npm.cmd'],
    };

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: '',
            packageManager: 'npm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, true, 'npm 入口文件存在时可用');
    assertEq(result.commandPath, 'npm', 'npm 存在时 commandPath=npm');
}

/*********************** resolvePackageManager: 项目 Node 路径为空 *********************/

{
    const dirContents: Record<string, string[]> = {};

    const result = await resolvePackageManager(
        {
            nodePath: '',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: 'pnpm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, 'nodePath 为空, source=project → available=false');
    assertEq(result.reason, 'project_node_unavailable', 'reason=project_node_unavailable');
}

{
    const dirContents: Record<string, string[]> = {};

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: '',
            packageManager: 'pnpm',
            source: 'default',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, false, 'defaultNodePath 为空, source=default → available=false');
    assertEq(result.reason, 'default_node_unavailable', 'reason=default_node_unavailable');
}

/*********************** resolvePackageManager: Unix 平台 *********************/

{
    const dirContents: Record<string, string[]> = {
        '/home/user/.nvm/versions/node/v18.19.0/bin': ['node', 'npm', 'npx'],
        '/home/user/.nvm/versions/node/v20.11.0/bin': ['node', 'npm', 'npx', 'pnpm'],
    };

    const result1 = await resolvePackageManager(
        {
            nodePath: '/home/user/.nvm/versions/node/v18.19.0/bin',
            defaultNodePath: '/home/user/.nvm/versions/node/v20.11.0/bin',
            packageManager: 'pnpm',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        false, // Unix
    );
    assertEq(result1.available, false, 'Unix: 当前Node无pnpm, source=project → unavailable');

    const result2 = await resolvePackageManager(
        {
            nodePath: '/home/user/.nvm/versions/node/v18.19.0/bin',
            defaultNodePath: '/home/user/.nvm/versions/node/v20.11.0/bin',
            packageManager: 'pnpm',
            source: 'default',
        },
        mockCheckEntries(dirContents),
        false,
    );
    assertEq(result2.available, true, 'Unix: 默认Node有pnpm, source=default → available=true');
    assertEq(result2.commandPath, 'pnpm', 'Unix: commandPath=pnpm');
}

/*********************** resolvePackageManager: 空 PM 名称 *********************/

{
    const dirContents: Record<string, string[]> = {};

    const result = await resolvePackageManager(
        {
            nodePath: 'C:/nvm/v18',
            defaultNodePath: 'C:/nvm/v20',
            packageManager: '',
            source: 'project',
        },
        mockCheckEntries(dirContents),
        true,
    );

    assertEq(result.available, true, '空 PM 名称 → available=true（无需检查）');
}

/*********************** getPmDisabledReason *********************/

{
    const result: PackageManagerResolveResult = { available: false, reason: 'pm_not_installed_in_project_node' };
    const reason = getPmDisabledReason(result, 'v18.19.0', 'v20.11.0', 'pnpm');
    assert(reason !== null, 'getPmDisabledReason: 不可用时返回非 null');
    assertEq(reason!.key, 'project.cmdDisabledPmNotInstalled', 'reason key 正确');
    assertEq(reason!.params.pm, 'pnpm', 'reason params.pm 正确');
    assertEq(reason!.params.version, 'v18.19.0', 'reason params.version 正确');
}

{
    const result: PackageManagerResolveResult = { available: true };
    const reason = getPmDisabledReason(result, 'v18', 'v20', 'pnpm');
    assertEq(reason, null, 'getPmDisabledReason: 可用时返回 null');
}

{
    const result: PackageManagerResolveResult = { available: false, reason: 'pm_not_installed_in_default_node' };
    const reason = getPmDisabledReason(result, 'v18.19.0', 'v20.11.0', 'yarn');
    assertEq(reason!.key, 'project.cmdDisabledPmNotInstalledDefault', 'default node reason key 正确');
    assertEq(reason!.params.version, 'v20.11.0', 'default node reason 使用 defaultNodeVersion');
}

{
    const result: PackageManagerResolveResult = { available: false, reason: 'project_node_unavailable' };
    const reason = getPmDisabledReason(result, '', '', 'cnpm');
    assertEq(reason!.key, 'project.cmdDisabledNoNode', 'project_node_unavailable → cmdDisabledNoNode');
}

{
    const result: PackageManagerResolveResult = { available: false, reason: 'default_node_unavailable' };
    const reason = getPmDisabledReason(result, '', '', 'yarn');
    assertEq(reason!.key, 'project.cmdDisabledDefaultNodeUnavailable', 'default_node_unavailable → cmdDisabledDefaultNodeUnavailable');
}

/*********************** getPmAvailabilitySuffix *********************/

{
    assertEq(getPmAvailabilitySuffix(true, 'project'), 'pm_project_available', '可用+project → pm_project_available');
    assertEq(getPmAvailabilitySuffix(true, 'default'), 'pm_default_available', '可用+default → pm_default_available');
    assertEq(getPmAvailabilitySuffix(false, 'project'), 'pm_not_available', '不可用 → pm_not_available');
    assertEq(getPmAvailabilitySuffix(false, 'default'), 'pm_not_available', '不可用+default → pm_not_available');
}

console.log('✅ pmResolver: all tests passed');
