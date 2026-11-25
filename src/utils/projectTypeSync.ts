import type { Project, ProjectModuleKind } from '../types';
import type { ProjectInfo } from '../api/types';
import {
  buildJavaPresetCommands,
  ensureJavaCommands,
  ensureNodeInstallCommand,
  isWindowsPlatform,
} from './projectCommands';
import { getDefaultProjectQuickCommands, resolveProjectQuickCommands } from './projectQuickCommands';

/***********************项目特征快照*********************/
/**
 * 项目配置的「可检测特征」。
 *
 * 项目添加时只扫描一次清单文件，之后目录内容变化（clone / pull / 切换分支）不会
 * 自动反映到项目上：空目录加进来是 other，拉下前端代码后仍然没有脚本菜单。
 * 这里把扫描结果收敛成可比较的快照，供定时探测判断是否需要提示用户更新。
 */
export interface ProjectSnapshot {
  type: Project['type'];
  /** 仅 node 项目：package.json 的 scripts 名称（已排序） */
  scripts: string[];
  /** 仅 node 项目：lockfile 推断出的包管理器 */
  packageManager?: Project['packageManager'];
  /** 仅 java 项目 */
  buildTool?: 'maven' | 'gradle';
  hasWrapper: boolean;
  springBootModule?: string;
}

/** 后端 projectType 是字符串，统一收敛到前端支持的三类 */
export function normalizeProjectType(projectType: string): Project['type'] {
  if (projectType === 'node') return 'node';
  if (projectType === 'java') return 'java';
  return 'other';
}

function normalizeScripts(scripts: string[] | undefined): string[] {
  return [...(scripts ?? [])].sort();
}

export function createSnapshotFromScan(info: ProjectInfo): ProjectSnapshot {
  const type = normalizeProjectType(info.projectType);
  return {
    type,
    scripts: type === 'node' ? normalizeScripts(info.scripts) : [],
    // undefined 表示仓库里没有 lockfile、无法判断，不能当成「应该用 npm」
    packageManager: type === 'node' ? info.packageManager : undefined,
    buildTool: type === 'java' ? info.buildTool : undefined,
    hasWrapper: type === 'java' ? !!info.hasWrapper : false,
    springBootModule: type === 'java' ? info.springBootModule : undefined,
  };
}

export function createSnapshotFromProject(
  project: Pick<Project, 'type' | 'scripts' | 'packageManager' | 'buildTool' | 'hasWrapper' | 'springBootModule'>,
): ProjectSnapshot {
  const type = normalizeProjectType(project.type);
  return {
    type,
    scripts: type === 'node' ? normalizeScripts(project.scripts) : [],
    packageManager: type === 'node' ? project.packageManager : undefined,
    buildTool: type === 'java' ? project.buildTool : undefined,
    hasWrapper: type === 'java' ? !!project.hasWrapper : false,
    springBootModule: type === 'java' ? project.springBootModule : undefined,
  };
}

/**
 * 快照签名：用于「同一变化只提示一次」的去重。
 *
 * 只包含会触发提示的维度；不含 path / 名称，避免改名后被当成新变化。
 */
export function projectSnapshotSignature(snapshot: ProjectSnapshot): string {
  return JSON.stringify([
    snapshot.type,
    snapshot.scripts,
    snapshot.packageManager ?? '',
    snapshot.buildTool ?? '',
    snapshot.hasWrapper ? 1 : 0,
    snapshot.springBootModule ?? '',
  ]);
}

/***********************差异判断*********************/

export interface ProjectSnapshotDiff {
  previous: ProjectSnapshot;
  next: ProjectSnapshot;
  typeChanged: boolean;
  scriptsAdded: string[];
  scriptsRemoved: string[];
  packageManagerChanged: boolean;
  hasChanges: boolean;
}

/**
 * 对比磁盘现状与项目已存配置。
 *
 * 只在**用户可感知**的维度上判定变化：
 * - 类型变化（other → node/java 是「拉下代码后不认识项目」的核心场景）
 * - npm scripts 增删（命令菜单/快捷命令会缺项）
 * - 包管理器变化（lockfile 换了，安装命令要跟着换）
 *
 * Java 的 wrapper / spring-boot 模块信息由启动时的 refreshJavaBuildInfo 自动补齐，
 * 不在这里打扰用户。
 */
export function diffProjectSnapshot(
  project: Pick<Project, 'type' | 'scripts' | 'packageManager' | 'buildTool' | 'hasWrapper' | 'springBootModule'>,
  info: ProjectInfo,
): ProjectSnapshotDiff | null {
  const previous = createSnapshotFromProject(project);
  const next = createSnapshotFromScan(info);

  const typeChanged = previous.type !== next.type;
  const scriptsAdded = next.scripts.filter(script => !previous.scripts.includes(script));
  const scriptsRemoved = previous.scripts.filter(script => !next.scripts.includes(script));
  // 扫描不到 lockfile 时不推翻用户手动选的包管理器
  const packageManagerChanged = next.type === 'node'
    && previous.type === 'node'
    && !!next.packageManager
    && previous.packageManager !== next.packageManager;
  const hasChanges = typeChanged
    || scriptsAdded.length > 0
    || scriptsRemoved.length > 0
    || packageManagerChanged;

  if (!hasChanges) return null;

  return {
    previous,
    next,
    typeChanged,
    scriptsAdded,
    scriptsRemoved,
    packageManagerChanged,
    hasChanges,
  };
}

/***********************应用检测结果*********************/

export interface ApplyProjectSnapshotOptions {
  /** 「安装依赖」内置命令的显示名（跟随当前语言） */
  installCommandName: string;
  isWindows?: boolean;
}

function moduleKindForProjectType(type: Project['type']): ProjectModuleKind {
  if (type === 'node') return 'node';
  if (type === 'java') return 'backend';
  return 'unknown';
}

/**
 * 合并可见脚本白名单。
 *
 * `visibleScripts` 的既有语义：空数组 = 全部可见，非空 = 白名单。
 * 更新时保留用户隐藏旧脚本的选择，新出现的脚本默认可见。
 */
function mergeVisibleScripts(
  project: Pick<Project, 'scripts' | 'visibleScripts'>,
  nextScripts: string[],
): string[] {
  const previousVisible = project.visibleScripts;
  if (!previousVisible?.length) return [];

  const previousScripts = new Set(project.scripts ?? []);
  return nextScripts.filter(script => previousVisible.includes(script) || !previousScripts.has(script));
}

/**
 * 用最新扫描结果更新项目配置。
 *
 * 只动「由清单文件推导」的字段，用户资产（自定义命令、备注、标签、分组、
 * Node 绑定等）全部保留；类型切换时会清掉不属于新类型的内置预设命令，
 * 避免留下一排点了必然报错的按钮。
 */
export function applyProjectSnapshot(
  project: Project,
  info: ProjectInfo,
  options: ApplyProjectSnapshotOptions,
): Project {
  const next = createSnapshotFromScan(info);
  const isWindows = options.isWindows ?? isWindowsPlatform();
  const previousType = project.type;

  const customCommands = (project.customCommands ?? []).filter((command) => {
    if (next.type === 'java') return command.builtinId !== 'install_dependencies';
    if (next.type === 'node') return !command.builtinId?.startsWith('java_');
    return !command.builtinId;
  });

  const visibleScripts = next.type === 'node' ? mergeVisibleScripts(project, next.scripts) : [];

  let updated: Project = {
    ...project,
    type: next.type,
    scripts: next.type === 'node' ? next.scripts : [],
    visibleScripts,
    packageManager: next.type === 'node' ? (next.packageManager ?? project.packageManager ?? 'npm') : undefined,
    buildTool: next.type === 'java' ? next.buildTool : undefined,
    hasWrapper: next.type === 'java' ? next.hasWrapper : undefined,
    springBootModule: next.type === 'java' ? next.springBootModule : undefined,
    customCommands,
  };

  // moduleKind 只存在于扫描出来的子项目；一级项目保持无徽章
  if (previousType !== next.type && project.moduleKind) {
    updated.moduleKind = moduleKindForProjectType(next.type);
  }

  if (next.type === 'node') {
    updated = ensureNodeInstallCommand(updated, options.installCommandName);
  } else if (next.type === 'java') {
    // 从 other / node 切到 java 时项目还没有任何 Java 预设命令，
    // 先补齐整套预设，再交给 ensureJavaCommands 做 wrapper / 模块校正
    const hasJavaPreset = (updated.customCommands ?? []).some(
      command => command.builtinId?.startsWith('java_'),
    );
    if (!hasJavaPreset && next.buildTool) {
      updated = {
        ...updated,
        customCommands: [
          ...(updated.customCommands ?? []),
          ...buildJavaPresetCommands(
            next.buildTool,
            next.hasWrapper,
            isWindows,
            () => crypto.randomUUID(),
            next.springBootModule,
          ),
        ],
      };
    }
    updated = ensureJavaCommands(updated, options.installCommandName, isWindows);
  }

  // 类型/脚本变化后，指向已消失命令的快捷入口要一并裁掉；
  // 原快捷命令全部失效时回退到默认挑选，避免一级页空出一块
  const resolvedQuickCommands = resolveProjectQuickCommands(updated);
  updated.quickCommands = resolvedQuickCommands.length === 0 && project.quickCommands?.length
    ? getDefaultProjectQuickCommands(updated)
    : resolvedQuickCommands;

  return updated;
}
