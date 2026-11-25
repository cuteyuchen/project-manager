/***********************项目目录内容变化通知*********************/
/**
 * 项目目录内容发生变化的轻量广播。
 *
 * Git 拉取/合并/切分支完成后，工作区文件可能多出一个 package.json，
 * 项目类型检测需要立刻重跑，而不是等下一次轮询。这里用窗口事件解耦
 * git store 与检测 composable，避免 store 直接依赖 Vue 组件层。
 */
export const PROJECT_FILES_CHANGED_EVENT = 'project-files-changed';

export interface ProjectFilesChangedDetail {
  /** 发生变化的目录；省略表示「全部项目都需要重新检测」 */
  path?: string;
}

export function notifyProjectFilesChanged(path?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ProjectFilesChangedDetail>(PROJECT_FILES_CHANGED_EVENT, {
    detail: { path },
  }));
}
