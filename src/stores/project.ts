import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api';
import type { Project, ProjectGroup } from '../types';
import type { PackageManagerResolveResult } from '../api/types';
import { useNodeStore } from './node';
import { useSettingsStore } from './settings';
import { useUsageStore } from './usage';
import { getCustomCommandDisplayNameByLocale } from '../utils/projectCommands';
import { resolveNodePathFromVersion, resolveProjectNodePath, isExplicitNodeVersion } from '../utils/nodeRuntime';
import { normalizeNvmVersion } from '../utils/nvm';
import { scanFrontendEnvProject } from '../utils/frontendEnvSwitcher';
import { normalizeProjectTags } from '../utils/projectTags';
import { createProjectId } from '../utils/projectId';
import { ElMessage } from 'element-plus';

type WorkspaceTab = 'console' | 'git' | 'files' | 'memo' | 'env';

export const useProjectStore = defineStore('project', () => {
  const projects = ref<Project[]>([]);
  const projectGroups = ref<ProjectGroup[]>([]);
  const runningStatus = ref<Record<string, boolean>>({});
  const runningProjectCount = ref<Record<string, number>>({});
  const logs = ref<Record<string, string[]>>({});
  // activeProjectId 语义为「当前叶子/子项目」：命令运行、git、环境切换绑定它（ConsoleView/GitView 读取此值）
  const activeProjectId = ref<string | null>(null);
  // activeRootId 语义为「当前钻取进入的一级项目」：文件、备忘录绑定它
  const activeRootId = ref<string | null>(null);
  // 外部（如全局搜索）请求打开的根项目工作区；Dashboard 挂载或 watch 时消费并置空
  const pendingWorkspaceRootId = ref<string | null>(null);
  const requestedRightTab = ref<WorkspaceTab | null>(null);
  const requestedRightTabToken = ref(0);

  // Load from local storage removed in favor of persistence.ts

  // Log buffering mechanism to optimize rendering performance
  const logBuffer: Record<string, string[]> = {};
  let logFlushTimer: number | null = null;

  function getProjectIdFromRunId(runId: string) {
    const separatorIndex = runId.indexOf(':');
    return separatorIndex === -1 ? runId : runId.slice(0, separatorIndex);
  }

  function setRunningState(runId: string, nextRunning: boolean) {
    const prevRunning = !!runningStatus.value[runId];
    if (prevRunning === nextRunning) return;

    runningStatus.value[runId] = nextRunning;

    const projectId = getProjectIdFromRunId(runId);
    const currentCount = runningProjectCount.value[projectId] || 0;
    const nextCount = nextRunning ? currentCount + 1 : Math.max(0, currentCount - 1);

    if (nextCount === 0) {
      delete runningProjectCount.value[projectId];
    } else {
      runningProjectCount.value[projectId] = nextCount;
    }
  }

  function flushLogs() {
    for (const id in logBuffer) {
      if (logBuffer[id].length > 0) {
        if (!logs.value[id]) logs.value[id] = [];
        // Use spread to push multiple items at once, reducing reactivity triggers
        logs.value[id].push(...logBuffer[id]);

        // Keep logs within limit (e.g., 2000 lines to allow scrolling back a bit, ConsoleView shows 500)
        if (logs.value[id].length > 2000) {
          logs.value[id] = logs.value[id].slice(-2000);
        }

        logBuffer[id] = [];
      }
    }
    logFlushTimer = null;
  }

  // Setup listeners
  api.onProjectOutput(({ id, data }) => {
    if (!logBuffer[id]) logBuffer[id] = [];
    logBuffer[id].push(data);

    if (!logFlushTimer) {
      // Use requestAnimationFrame for smooth UI updates, or setTimeout for throttling
      // requestAnimationFrame might pause in background tabs, but that's usually fine
      logFlushTimer = requestAnimationFrame(flushLogs);
    }
  });

  api.onProjectExit(({ id }) => {
    setRunningState(id, false);
    // Ensure any buffered logs are flushed first
    if (logBuffer[id] && logBuffer[id].length > 0) {
      if (!logs.value[id]) logs.value[id] = [];
      logs.value[id].push(...logBuffer[id]);
      logBuffer[id] = [];
    }
    if (!logs.value[id]) logs.value[id] = [];
    logs.value[id].push('[Process exited]');
  });

  function addProject(project: Project) {
    projects.value.unshift(project);
    try { useUsageStore().markAdded(project.id); } catch {}
    void scanFrontendEnvForProject(project.id).catch((error) => {
      console.error(`Failed to scan frontend env for added project ${project.name}`, error);
    });
  }

  function updateProject(project: Project) {
    const index = projects.value.findIndex((p) => p.id === project.id);
    if (index !== -1) {
      projects.value[index] = project;
    }
  }

  function removeProject(id: string) {
    // 级联删除：收集自身 + 所有后代项目 id 一并移除
    const idsToRemove = collectDescendantIds(id);
    idsToRemove.add(id);
    projects.value = projects.value.filter((p) => !idsToRemove.has(p.id));
    if (activeProjectId.value && idsToRemove.has(activeProjectId.value)) activeProjectId.value = null;
    if (activeRootId.value && idsToRemove.has(activeRootId.value)) activeRootId.value = null;
    try { useUsageStore().cleanupRemovedProjects(projects.value.map(p => p.id)); } catch {}
  }

  /***********************项目嵌套（多级）辅助*********************/

  /** 获取指定父项目的直接子项目（按 sortOrder 升序） */
  function getChildren(parentId: string): Project[] {
    return projects.value
      .filter((p) => p.parentId === parentId)
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
  }

  /** 获取所有一级项目（无 parentId 的根项目） */
  function getRootProjects(): Project[] {
    return projects.value.filter((p) => !p.parentId);
  }

  /** 是否存在直接子项目 */
  function hasChildren(id: string): boolean {
    return projects.value.some((p) => p.parentId === id);
  }

  /** 计算项目深度：一级项目为 1，其子为 2，以此类推（含循环保护） */
  function getProjectDepth(id: string): number {
    let depth = 1;
    const seen = new Set<string>();
    let current = projects.value.find((p) => p.id === id);
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      depth += 1;
      const parentId: string = current.parentId;
      current = projects.value.find((p) => p.id === parentId);
    }
    return depth;
  }

  /** 向上回溯到最顶层的根项目 id（含循环保护）；找不到时返回入参本身 */
  function getRootProjectId(id: string): string {
    const seen = new Set<string>();
    let current = projects.value.find((p) => p.id === id);
    if (!current) return id;
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = projects.value.find((p) => p.id === current!.parentId);
      if (!parent) break;
      current = parent;
    }
    return current.id;
  }

  /** 递归收集某项目的所有后代 id（不含自身） */
  function collectDescendantIds(id: string): Set<string> {
    const result = new Set<string>();
    const walk = (parentId: string) => {
      for (const p of projects.value) {
        if (p.parentId === parentId && !result.has(p.id)) {
          result.add(p.id);
          walk(p.id);
        }
      }
    };
    walk(id);
    return result;
  }

  /** 批量创建子项目（挂到指定父项目下），跳过路径重复的项 */
  function addSubProjects(parentId: string, children: Omit<Project, 'id' | 'parentId'>[]): Project[] {
    const existingPaths = new Set(projects.value.map((p) => p.path));
    const created: Project[] = [];
    let order = getChildren(parentId).length;
    for (const child of children) {
      if (existingPaths.has(child.path)) continue;
      const newProject: Project = {
        ...child,
        id: createProjectId(),
        parentId,
        sortOrder: order++,
      };
      projects.value.push(newProject);
      existingPaths.add(newProject.path);
      created.push(newProject);
      try { useUsageStore().markAdded(newProject.id); } catch {}
      void scanFrontendEnvForProject(newProject.id).catch((error) => {
        console.error(`Failed to scan frontend env for added sub project ${newProject.name}`, error);
      });
    }
    // 更新父项目扫描时间戳
    const parent = projects.value.find((p) => p.id === parentId);
    if (parent) parent.subScannedAt = Date.now();
    return created;
  }

  /***********************收藏*********************/

  function favoriteProject(id: string) {
    const project = projects.value.find((p) => p.id === id);
    if (project) project.favorite = true;
  }

  function unfavoriteProject(id: string) {
    const project = projects.value.find((p) => p.id === id);
    if (project) project.favorite = false;
  }

  function toggleFavorite(id: string) {
    const project = projects.value.find((p) => p.id === id);
    if (project) project.favorite = !project.favorite;
  }

  function requestRightTab(tab: WorkspaceTab) {
    requestedRightTab.value = tab;
    requestedRightTabToken.value += 1;
  }

  /**
   * 解析项目的包管理器可用性。
   * 返回解析结果（包含 available、commandPath、reason）。
   * 供 ProjectListItem 等组件在渲染时调用，用于判断是否禁用命令按钮。
   */
  async function resolvePmForProject(project: Project): Promise<PackageManagerResolveResult> {
    if (project.type !== 'node' || !project.packageManager) {
      return { available: true };
    }

    const nodeStore = useNodeStore();
    if (!nodeStore.versions.length) {
      await nodeStore.loadNvmNodes();
    }

    const nodePath = resolveProjectNodePath(project, nodeStore.versions);
    let defaultNodePath = '';
    try {
      defaultNodePath = await api.getSystemNodePath();
    } catch (_) {}

    const source = project.packageManagerSource || 'project';

    try {
      return await api.resolvePackageManager(nodePath, defaultNodePath, project.packageManager, source);
    } catch (_) {
      return { available: false, reason: 'unknown' };
    }
  }

  async function runProject(project: Project, script: string) {
    const runId = `${project.id}:${script}`;

    if (runningStatus.value[runId]) return;

    const nodeStore = useNodeStore();

    // Ensure node versions are loaded
    if (project.type === 'node') {
      await nodeStore.loadNvmNodes();
    }

    let nodePath = resolveProjectNodePath(project, nodeStore.versions);

    // If a specific version is configured but not installed, auto-install it
    if (!nodePath && isExplicitNodeVersion(project.nodeVersion)) {
      const version = normalizeNvmVersion(project.nodeVersion!)!;
      try {
        ElMessage.info({ message: `正在自动安装 Node ${version}...`, duration: 3000 });
        await nodeStore.installNode(version);
        ElMessage.success({ message: `Node ${version} 自动安装完成`, duration: 3000 });
        nodePath = resolveProjectNodePath(project, nodeStore.versions);
      } catch (installError) {
        ElMessage.error(`Node ${version} 自动安装失败: ${String(installError)}`);
        console.error('Failed to auto-install node version for project run', installError);
      }
    }

    if (!nodePath && project.type === 'node') {
      try {
        const info: any = await api.scanProject(project.path);
        nodePath = resolveNodePathFromVersion(info.nvmVersion, nodeStore.versions);
        if (nodePath && info.nvmVersion) {
          project.nodeVersion = info.nvmVersion;
        }
      } catch (error) {
        console.warn('Failed to rescan project node version before running project', error);
      }
    }

    // 解析包管理器可用性
    let pmCommandPath: string | undefined;
    let pmNodePath: string | undefined;
    if (project.type === 'node' && project.packageManager) {
      const pmResult = await resolvePmForProject(project);
      if (!pmResult.available) {
        // 构建禁用原因日志
        ElMessage.error(`命令不可用：${pmResult.reason || '包管理器不可用'}`);
        return;
      }
      pmCommandPath = pmResult.commandPath;

      // 当来源为 default 时，需要将默认 Node 目录传给后端加入 PATH
      const source = project.packageManagerSource || 'project';
      if (source === 'default') {
        try {
          const defaultNodePath = await api.getSystemNodePath();
          if (defaultNodePath) {
            pmNodePath = defaultNodePath;
          }
        } catch (_) {}
      }
    }

    try {
      logs.value[runId] = [];

      activeProjectId.value = project.id;
      requestRightTab('console');
      setRunningState(runId, true);
      try { useUsageStore().recordUsage(project.id); } catch {}

      logs.value[runId].push(`[Runner] Starting script: ${script}`);
      logs.value[runId].push(`[Runner] Project: ${project.name}`);
      logs.value[runId].push(`[Runner] Package Manager: ${project.packageManager || 'npm'}`);
      logs.value[runId].push(`[Runner] Node Version: ${project.nodeVersion || 'Default'}`);
      logs.value[runId].push(`[Runner] Node Path: ${nodePath || 'System Default'}`);
      if (pmCommandPath) {
        logs.value[runId].push(`[Runner] PM Command Path: ${pmCommandPath}`);
      }

      await api.runProjectCommand(
        runId,
        project.path,
        script,
        project.packageManager || 'npm',
        nodePath,
        pmCommandPath,
        pmNodePath
      );
    } catch (e) {
      console.error(e);
      setRunningState(runId, false);
      logs.value[runId].push(`Error starting project: ${e}`);
    }
  }

  async function runCustomCommand(project: Project, commandId: string) {
    const cmd = project.customCommands?.find((c) => c.id === commandId);
    if (!cmd) return;
    const settingsStore = useSettingsStore();

    const runId = `${project.id}:${cmd.id}`;

    if (runningStatus.value[runId]) return;

    // Node 项目只要 PM 不可用，项目内所有命令都禁用
    if (project.type === 'node' && project.packageManager) {
      const pmResult = await resolvePmForProject(project);
      if (!pmResult.available) {
        ElMessage.error(`命令不可用：${pmResult.reason || '包管理器不可用'}`);
        return;
      }
    }

    try {
      logs.value[runId] = [];
      activeProjectId.value = project.id;
      requestRightTab('console');
      setRunningState(runId, true);
      try { useUsageStore().recordUsage(project.id); } catch {}

      logs.value[runId].push(
        `[Runner] Starting custom command: ${getCustomCommandDisplayNameByLocale(cmd, settingsStore.settings.locale)}`
      );
      logs.value[runId].push(`[Runner] Command: ${cmd.command}`);
      logs.value[runId].push(`[Runner] Project: ${project.name}`);

      await api.runCustomCommand(runId, project.path, cmd.command);
    } catch (e) {
      console.error(e);
      setRunningState(runId, false);
      logs.value[runId].push(`Error starting command: ${e}`);
    }
  }

  async function stopProject(project: Project, script: string) {
    const runId = `${project.id}:${script}`;
    try {
      await api.stopProjectCommand(runId);
    } catch (e) {
      console.error(e);
    }
  }

  function clearLog(runId: string) {
    logs.value[runId] = [];
  }

  async function refreshAll() {
    const updates = await Promise.all(
      projects.value.map(async (p) => {
        try {
          await api.readDir(p.path);
        } catch {
          return p;
        }

        const [info, frontendEnvGroups] = await Promise.all([
          api.scanProject(p.path).catch((error) => {
            console.error(`Failed to refresh project ${p.name}`, error);
            return null;
          }),
          scanFrontendEnvProject(p.path, api).catch((error) => {
            console.error(`Failed to refresh frontend env for project ${p.name}`, error);
            return undefined;
          }),
        ]);

        const nextProject: Project = {
          ...p,
          frontendEnvGroups: frontendEnvGroups || p.frontendEnvGroups || [],
          frontendEnvScannedAt: frontendEnvGroups ? Date.now() : p.frontendEnvScannedAt,
        };

        if (info && p.type === 'node') {
          return { ...nextProject, scripts: info.scripts || [] };
        }

        return nextProject;
      })
    );
    projects.value = updates;
  }

  /***********************前端环境扫描*********************/

  async function scanFrontendEnvForProject(projectId: string) {
    const index = projects.value.findIndex((p) => p.id === projectId);
    if (index === -1) {
      return [];
    }

    const project = projects.value[index];
    const groups = await scanFrontendEnvProject(project.path, api);
    projects.value[index] = {
      ...project,
      frontendEnvGroups: groups,
      frontendEnvScannedAt: Date.now(),
    };

    return groups;
  }

  async function scanFrontendEnvForAll() {
    await Promise.all(
      projects.value.map((project) =>
        scanFrontendEnvForProject(project.id).catch((error) => {
          console.error(`Failed to scan frontend env for project ${project.name}`, error);
          return [];
        }),
      ),
    );
  }

  function pinProject(id: string) {
    const project = projects.value.find((p) => p.id === id);
    if (!project) return;
    // Bump all existing pinned projects down by 1
    for (const p of projects.value) {
      if (p.pinned && p.id !== id) {
        p.pinOrder = (p.pinOrder ?? 0) + 1;
      }
    }
    project.pinned = true;
    project.pinOrder = 0; // Top position
  }

  function unpinProject(id: string) {
    const project = projects.value.find((p) => p.id === id);
    if (!project) return;
    project.pinned = false;
    project.pinOrder = undefined;
  }

  /***********************批量选择状态*********************/

  /** 批量模式：仅在 UI 主动开启时使用，不影响普通选中项目 */
  const batchMode = ref(false);
  const selectedIds = ref<Set<string>>(new Set());

  function enterBatchMode(initialIds: string[] = []) {
    batchMode.value = true;
    selectedIds.value = new Set(initialIds);
  }

  function exitBatchMode() {
    batchMode.value = false;
    selectedIds.value = new Set();
  }

  function toggleSelect(id: string) {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
  }

  function selectAllVisible(ids: string[]) {
    selectedIds.value = new Set(ids);
  }

  function clearSelection() {
    selectedIds.value = new Set();
  }

  /** 对一组项目并发应用 partial 更新；遇失败不抛，返回失败 id 集合 */
  async function batchUpdate(ids: string[], patch: Partial<Project>): Promise<{ updated: string[]; failed: string[] }> {
    const targets = ids
      .map((id) => projects.value.find((p) => p.id === id))
      .filter((p): p is Project => !!p);
    const updated: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      targets.map(async (p) => {
        try {
          Object.assign(p, patch);
          updated.push(p.id);
        } catch (e) {
          console.error('batchUpdate failed for', p.id, e);
          failed.push(p.id);
        }
      })
    );
    return { updated, failed };
  }

  /** 批量添加/删除标签（add=true 添加，否则移除） */
  async function batchSetTags(ids: string[], tags: string[], add: boolean): Promise<void> {
    const normalizedTags = normalizeProjectTags(tags);
    const targets = ids
      .map((id) => projects.value.find((p) => p.id === id))
      .filter((p): p is Project => !!p);
    for (const p of targets) {
      const set = new Set(p.tags ?? []);
      for (const t of normalizedTags) {
        if (add) set.add(t);
        else set.delete(t);
      }
      p.tags = normalizeProjectTags(Array.from(set));
    }
  }

  /** 批量删除项目 */
  async function batchRemove(ids: string[]): Promise<void> {
    for (const id of ids) {
      removeProject(id);
    }
  }

  /***********************项目分组管理*********************/

  /** 新增分组 */
  function addProjectGroup(group: Omit<ProjectGroup, 'id'>) {
    projectGroups.value.push({
      id: crypto.randomUUID(),
      ...group,
    });
  }

  /** 更新分组（合并 patch） */
  function updateProjectGroup(id: string, patch: Partial<Omit<ProjectGroup, 'id'>>) {
    const group = projectGroups.value.find((g) => g.id === id);
    if (!group) return;
    Object.assign(group, patch);
  }

  /** 删除分组，并把该分组下的项目 groupId 清空（不删除项目） */
  function removeProjectGroup(id: string) {
    projectGroups.value = projectGroups.value.filter((g) => g.id !== id);
    for (const p of projects.value) {
      if (p.groupId === id) {
        p.groupId = undefined;
      }
    }
  }

  /** 切换分组折叠状态 */
  function toggleProjectGroupCollapsed(id: string) {
    const group = projectGroups.value.find((g) => g.id === id);
    if (!group) return;
    group.collapsed = !group.collapsed;
  }

  return {
    projects,
    projectGroups,
    runningStatus,
    runningProjectCount,
    logs,
    activeProjectId,
    activeRootId,
    pendingWorkspaceRootId,
    requestedRightTab,
    requestedRightTabToken,
    addProject,
    updateProject,
    removeProject,
    getChildren,
    getRootProjects,
    hasChildren,
    getProjectDepth,
    getRootProjectId,
    collectDescendantIds,
    addSubProjects,
    favoriteProject,
    unfavoriteProject,
    toggleFavorite,
    requestRightTab,
    runProject,
    runCustomCommand,
    stopProject,
    resolvePmForProject,
    clearLog,
    refreshAll,
    scanFrontendEnvForProject,
    scanFrontendEnvForAll,
    pinProject,
    unpinProject,
    addProjectGroup,
    updateProjectGroup,
    removeProjectGroup,
    toggleProjectGroupCollapsed,
    batchMode,
    selectedIds,
    enterBatchMode,
    exitBatchMode,
    toggleSelect,
    selectAllVisible,
    clearSelection,
    batchUpdate,
    batchSetTags,
    batchRemove,
  };
});
