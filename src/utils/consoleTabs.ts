/***********************控制台页签选中规则*********************/

export interface ActiveConsoleTabInput {
  /** 当前选中的页签（命令 key），可能为空 */
  activeTab: string | null;
  /** 当前已打开的页签 */
  openTabs: readonly string[];
  /** 仍在运行的页签 */
  runningTabs: readonly string[];
  /** 本次新启动且仍在运行的页签 */
  startedTab?: string | null;
  /** 当前页签是否还有对应会话（会话被清理后页签会变成空壳） */
  activeTabHasSession?: boolean;
}

/**
 * 决定控制台应该显示哪个命令页签。
 *
 * 关键约束：当前页签的会话**已经结束**时也必须留在原地。
 * 原先只要当前页签不在「运行中」集合里就切走，于是 `npm run build` 一结束，
 * 界面就跳到另一个仍在运行的 dev 窗口，用户根本看不到构建结果和退出码。
 * 只有当前页签失效（被关闭 / 会话被清理）或用户刚启动了新命令时才切换。
 */
export function resolveActiveConsoleTab(input: ActiveConsoleTabInput): string | null {
  const {
    activeTab,
    openTabs,
    runningTabs,
    startedTab = null,
    activeTabHasSession = true,
  } = input;
  const lastOpenTab = openTabs[openTabs.length - 1] ?? null;

  // 刚启动的命令优先：用户点了运行，期待立刻看到它的输出
  if (startedTab) return startedTab;

  const activeIsOpen = activeTab !== null && openTabs.includes(activeTab);

  // 会话还在（运行中或刚结束）就保持当前页签，不因其他命令仍在运行而跳走
  if (activeIsOpen && activeTabHasSession) return activeTab;

  // 当前页签已失效：优先落到仍在运行的页签，其次是最新打开的页签
  const lastRunningTab = runningTabs[runningTabs.length - 1];
  if (lastRunningTab) return lastRunningTab;
  if (activeIsOpen) return activeTab;
  return lastOpenTab;
}
