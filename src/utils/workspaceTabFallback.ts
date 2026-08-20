/***********************工作区右侧页签的可用性与回退*********************/

/**
 * 右侧工作区页签。
 *
 * 与 `stores/project.ts` 的 `WorkspaceTab`、`ProjectWorkspace.vue` 的 `WorkTab`
 * 字面量一致（三处重复定义待统一）。
 */
export type WorkspaceTab = 'console' | 'git' | 'files' | 'memo' | 'env';

/** 判定页签可用性所需的能力快照，全部来自 ProjectWorkspace 的 computed */
export interface WorkspaceTabCapabilities {
  /** 当前没有活动叶子项目（项目被删等瞬时空状态） */
  leafTabsDisabled: boolean;
  /** 有可运行的脚本或自定义命令 */
  hasRunnableCommands: boolean;
  /** 有前端环境配置组 */
  hasFrontendEnv: boolean;
}

/**
 * 该页签在当前能力下能否渲染。
 *
 * 「命令」入口带 `v-if="hasRunnableCommands"`、「环境」入口带 `v-if="hasFrontendEnv"`，
 * 条件不满足时整个按钮不存在，停在上面等于停在一个看不见的页签上。
 * 「Git」「文件」「备忘录」无条件渲染，只在没有活动叶子时才受限。
 */
export function isWorkspaceTabAvailable(
  tab: WorkspaceTab,
  capabilities: WorkspaceTabCapabilities,
): boolean {
  // 没有活动叶子时，绑定叶子的三个页签都渲染不出内容
  if (capabilities.leafTabsDisabled && (tab === 'console' || tab === 'git' || tab === 'env')) {
    return false;
  }
  if (tab === 'console') return capabilities.hasRunnableCommands;
  if (tab === 'env') return capabilities.hasFrontendEnv;
  return true;
}

/**
 * 页签仍可用时原样返回，不可用时给出回退目标。
 *
 * 这是「当前页签失效该退到哪」的**唯一**判据：切换子项目时用它保住用户已选的页签，
 * 能力变化时也用它做兜底纠正，避免两处各写一份规则而漂移。
 *
 * 回退目标：没有活动叶子只能退到「文件」；否则退到「Git」——它无条件渲染，
 * 且比「文件」更常用；退到「文件」会把默认页签的判断又冲掉。
 */
export function resolveWorkspaceTabFallback(
  tab: WorkspaceTab,
  capabilities: WorkspaceTabCapabilities,
): WorkspaceTab {
  if (isWorkspaceTabAvailable(tab, capabilities)) return tab;
  if (capabilities.leafTabsDisabled) return 'files';
  return 'git';
}
