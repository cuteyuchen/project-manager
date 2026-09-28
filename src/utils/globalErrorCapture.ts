import {
  createErrorRateLimiter,
  errorFingerprint,
  recordCapturedError,
} from './errorDetails';

export type GlobalErrorSource = 'vue' | 'window.error' | 'unhandledrejection';

export interface GlobalErrorCaptureController {
  capture(error: unknown, source: GlobalErrorSource): void;
  stop(): void;
}

/**
 * 浏览器 ResizeObserver delivery 通知的规范化文案。
 * 这些不是应用异常，而是观察器在同一 delivery cycle 内无法继续派发时的标准提示。
 */
const RESIZE_OBSERVER_DELIVERY_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded',
]);

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? '');
}

/**
 * 仅识别浏览器发出的 ResizeObserver delivery notification，
 * 且只在 window.error 来源上生效。
 *
 * 用精确文案匹配，避免把包含 “ResizeObserver” 字样的真实业务异常误吞
 * （例如 `ResizeObserver failed to initialize`）。
 */
export function isResizeObserverDeliveryError(
  error: unknown,
  source: GlobalErrorSource,
): boolean {
  if (source !== 'window.error') return false;
  const message = readErrorMessage(error).trim();
  return RESIZE_OBSERVER_DELIVERY_MESSAGES.has(message);
}

export function installGlobalErrorCapture(
  report: (error: unknown, source: GlobalErrorSource) => void,
): GlobalErrorCaptureController {
  const limiter = createErrorRateLimiter();

  function capture(error: unknown, source: GlobalErrorSource): void {
    // 浏览器 RO delivery 通知：不上报 UI、不占限流、不覆盖 latestCapturedError。
    // 开发期仅留 debug 日志，便于排查布局反馈，但不打扰用户。
    if (isResizeObserverDeliveryError(error, source)) {
      console.debug(`[GlobalError:${source}]`, error);
      return;
    }
    if (!limiter.shouldReport(errorFingerprint(error))) return;
    recordCapturedError(error);
    console.error(`[GlobalError:${source}]`, error);
    try {
      report(error, source);
    } catch (reportError) {
      console.error('[GlobalError:reporter]', reportError);
    }
  }

  const handleWindowError = (event: ErrorEvent) => {
    capture(event.error || event.message, 'window.error');
  };
  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    capture(event.reason, 'unhandledrejection');
  };

  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);

  function stop(): void {
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleUnhandledRejection);
  }

  return { capture, stop };
}
