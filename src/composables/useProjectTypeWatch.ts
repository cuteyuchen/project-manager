import { h, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';
import type { ProjectInfo } from '../api/types';
import { useProjectStore } from '../stores/project';
import type { Project } from '../types';
import {
  applyProjectSnapshot,
  createSnapshotFromScan,
  diffProjectSnapshot,
  projectSnapshotSignature,
  type ProjectSnapshotDiff,
} from '../utils/projectTypeSync';
import {
  PROJECT_FILES_CHANGED_EVENT,
  type ProjectFilesChangedDetail,
} from '../utils/projectFilesChanged';

/***********************配置*********************/

const ACK_STORAGE_KEY = 'project-type-watch-ack-v1';

/** 同一变化被用户处理过（确认或忽略）后不再重复弹窗，直到出现新的变化 */
type AcknowledgedMap = Record<string, { path: string; signature: string }>;

function loadAcknowledged(): AcknowledgedMap {
  try {
    const raw = localStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AcknowledgedMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface UseProjectTypeWatchOptions {
  /** 轮询间隔；目录变化没有系统级通知，靠低频探测兜底 */
  intervalMs?: number;
  /** 启动后首次检测的延迟，避开首屏加载 */
  initialDelayMs?: number;
}

/**
 * 监听项目目录内容变化，发现项目类型 / 脚本与当前配置不一致时弹窗确认。
 *
 * 触发来源（合并去重，任一命中即检测）：
 * 1. 低频定时轮询 —— 覆盖在外部终端 / IDE 里 pull、clone 的情况；
 * 2. 窗口重新获得焦点 / 页面重新可见 —— 用户拉完代码切回来立即检测；
 * 3. Git 拉取、合并、切分支完成的事件 —— 软件内操作零延迟。
 *
 * 检测只比对清单文件推导出的字段，不写磁盘；用户确认后才更新项目配置。
 */
export function useProjectTypeWatch(options: UseProjectTypeWatchOptions = {}) {
  const intervalMs = options.intervalMs ?? 15_000;
  const initialDelayMs = options.initialDelayMs ?? 3_000;

  const store = useProjectStore();
  const { t } = useI18n();

  const acknowledged = loadAcknowledged();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let initialTimeout: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let scanning = false;
  let prompting = false;

  function persistAcknowledged(): void {
    // 已删除的项目不必再占位
    const liveIds = new Set(store.projects.map(project => project.id));
    for (const id of Object.keys(acknowledged)) {
      if (!liveIds.has(id)) delete acknowledged[id];
    }
    try {
      localStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(acknowledged));
    } catch {
      // 隐私模式/配额不足时降级为仅本会话生效
    }
  }

  function remember(project: Project, signature: string): void {
    acknowledged[project.id] = { path: project.path, signature };
    persistAcknowledged();
  }

  function isAcknowledged(project: Project, signature: string): boolean {
    const entry = acknowledged[project.id];
    return !!entry && entry.path === project.path && entry.signature === signature;
  }

  function projectTypeLabel(type: Project['type']): string {
    if (type === 'node') return t('project.typeWatch.typeNode');
    if (type === 'java') return t('project.typeWatch.typeJava');
    return t('project.typeWatch.typeOther');
  }

  function buildPromptMessage(project: Project, diff: ProjectSnapshotDiff) {
    const lines: string[] = [];
    if (diff.typeChanged) {
      lines.push(t('project.typeWatch.typeChanged', {
        from: projectTypeLabel(diff.previous.type),
        to: projectTypeLabel(diff.next.type),
      }));
    }
    if (diff.scriptsAdded.length > 0) {
      lines.push(t('project.typeWatch.scriptsAdded', { scripts: diff.scriptsAdded.join(', ') }));
    }
    // 类型切换时移除脚本是必然结果，列出来只是噪声；同类型下的脚本减少才值得说明
    if (!diff.typeChanged && diff.scriptsRemoved.length > 0) {
      lines.push(t('project.typeWatch.scriptsRemoved', { scripts: diff.scriptsRemoved.join(', ') }));
    }
    if (diff.packageManagerChanged) {
      lines.push(t('project.typeWatch.packageManagerChanged', {
        from: diff.previous.packageManager ?? 'npm',
        to: diff.next.packageManager ?? 'npm',
      }));
    }

    return h('div', { style: 'line-height: 1.7;' }, [
      h('div', t('project.typeWatch.message', { name: project.name })),
      h(
        'ul',
        { style: 'margin: 8px 0 8px 18px; padding: 0; list-style: disc;' },
        lines.map(line => h('li', line)),
      ),
      h(
        'div',
        { style: 'color: var(--el-text-color-secondary); font-size: 12px;' },
        t('project.typeWatch.hint'),
      ),
    ]);
  }

  async function promptForUpdate(
    project: Project,
    info: ProjectInfo,
    diff: ProjectSnapshotDiff,
    signature: string,
  ): Promise<void> {
    prompting = true;
    try {
      const confirmed = await ElMessageBox.confirm(
        buildPromptMessage(project, diff),
        t('project.typeWatch.title'),
        {
          type: 'info',
          confirmButtonText: t('project.typeWatch.confirm'),
          cancelButtonText: t('project.typeWatch.dismiss'),
          closeOnClickModal: false,
          distinguishCancelAndClose: true,
        },
      ).then(() => true).catch(() => false);

      // 弹窗期间项目可能已被编辑/删除，以 store 中的最新对象为准
      const latest = store.projects.find(candidate => candidate.id === project.id);
      if (!latest) return;

      if (!confirmed) {
        remember(latest, signature);
        return;
      }

      const updated = applyProjectSnapshot(latest, info, {
        installCommandName: t('project.installDependencies'),
      });
      store.updateProject(updated);
      remember(updated, signature);
      ElMessage.success(t('project.typeWatch.updated', { name: updated.name }));
      // 拉下代码后 .env / vite 代理等也可能刚出现，顺带刷新
      void store.scanFrontendEnvForProject(updated.id).catch(() => undefined);
    } catch (error) {
      // 应用更新失败时保持原配置，下一轮检测会再次提示
      console.error('Failed to apply detected project configuration', error);
    } finally {
      prompting = false;
    }
  }

  /**
   * 是否已有打开的确认框。
   *
   * 只看 DOM 存在会被已关闭但未卸载的节点误判，导致检测永久让路，
   * 所以再确认外层遮罩是可见的。
   */
  function hasOpenMessageBox(): boolean {
    if (typeof document === 'undefined') return false;
    return Array.from(document.querySelectorAll('.el-message-box')).some((box) => {
      const overlay = box.closest('.el-overlay');
      return !overlay || getComputedStyle(overlay).display !== 'none';
    });
  }

  /**
   * 扫描项目并处理第一个需要确认的变化。
   *
   * 一次只处理一个：连续弹多个框会让用户不知道先点哪个；其余变化
   * 留到下一轮，签名去重保证不会重复打扰。
   */
  async function scanTargets(onlyPath?: string): Promise<void> {
    if (scanning || prompting) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // 已有确认框时让路，避免弹窗叠弹窗
    if (hasOpenMessageBox()) return;

    scanning = true;
    try {
      const changedPath = onlyPath ? normalizePath(onlyPath) : '';
      const targets = store.projects.filter((project) => {
        if (!changedPath) return true;
        const projectPath = normalizePath(project.path);
        return projectPath === changedPath || projectPath.startsWith(`${changedPath}/`);
      });

      for (const project of targets) {
        if (prompting) return;
        // 正在跑命令的项目不动配置：类型切换会影响运行会话的环境展示
        if (store.runningProjectCount[project.id]) continue;

        const current = store.projects.find(candidate => candidate.id === project.id);
        if (!current) continue;

        let info: ProjectInfo;
        try {
          info = await api.scanProject(current.path);
        } catch {
          // 目录暂不可用（外置盘未挂载等）时跳过，下一轮再试
          continue;
        }

        const diff = diffProjectSnapshot(current, info);
        if (!diff) {
          // 内容已回到与配置一致，清掉旧签名，避免下次真变化被挡
          if (acknowledged[current.id]) {
            delete acknowledged[current.id];
            persistAcknowledged();
          }
          continue;
        }

        const signature = projectSnapshotSignature(createSnapshotFromScan(info));
        if (isAcknowledged(current, signature)) continue;

        await promptForUpdate(current, info, diff, signature);
        return;
      }
    } finally {
      scanning = false;
    }
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') void scanTargets();
  }

  function handleWindowFocus(): void {
    void scanTargets();
  }

  function handleFilesChanged(event: Event): void {
    const detail = (event as CustomEvent<ProjectFilesChangedDetail>).detail;
    void scanTargets(detail?.path);
  }

  function start(): void {
    if (started) return;
    started = true;
    initialTimeout = setTimeout(() => {
      initialTimeout = null;
      void scanTargets();
    }, initialDelayMs);
    intervalId = setInterval(() => {
      void scanTargets();
    }, intervalMs);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener(PROJECT_FILES_CHANGED_EVENT, handleFilesChanged);
  }

  function stop(): void {
    if (initialTimeout) {
      clearTimeout(initialTimeout);
      initialTimeout = null;
    }
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleWindowFocus);
    window.removeEventListener(PROJECT_FILES_CHANGED_EVENT, handleFilesChanged);
    started = false;
  }

  onBeforeUnmount(stop);

  return {
    start,
    stop,
    /** 立即检测一次（可选只检测某个目录及其子项目） */
    checkNow: scanTargets,
  };
}
