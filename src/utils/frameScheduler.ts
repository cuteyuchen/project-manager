/**
 * 将多次同帧内的更新合并到下一 animation frame，并始终只应用最新值。
 * 用于 ResizeObserver 回调等「同一 delivery cycle 内不能同步改布局」的场景。
 */
export function createFrameScheduler<T>(
  run: (value: T) => void,
  requestFrame: (cb: () => void) => number,
  cancelFrame: (handle: number) => void,
) {
  let handle: number | null = null;
  let queued = false;
  let latest: T | undefined;

  return {
    /** 记录最新值；若当前帧已有调度则复用，不重复排队。 */
    schedule(value: T): void {
      latest = value;
      queued = true;
      if (handle !== null) return;
      handle = requestFrame(() => {
        handle = null;
        if (!queued) return;
        queued = false;
        const value = latest as T;
        latest = undefined;
        run(value);
      });
    },
    /** 取消尚未执行的调度并丢弃待应用值（组件卸载时调用）。 */
    cancel(): void {
      if (handle !== null) {
        cancelFrame(handle);
        handle = null;
      }
      queued = false;
      latest = undefined;
    },
    isPending(): boolean {
      return handle !== null;
    },
  };
}
