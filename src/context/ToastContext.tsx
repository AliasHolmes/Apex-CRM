import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Optional inline action such as Undo. Selecting it dismisses the toast. */
  action?: ToastAction;
  /** Override the default display time in milliseconds. */
  durationMs?: number;
}

export interface ToastContextType {
  /** The message currently visible. Kept for compatibility with existing consumers. */
  toast: string | null;
  triggerToast: (msg: string, type?: ToastType, options?: ToastOptions) => void;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
  durationMs?: number;
}

type ToastDispatch = (msg: string, type?: ToastType, options?: ToastOptions) => void;

const ToastStateContext = createContext<string | null>(null);
const ToastDispatchContext = createContext<ToastDispatch | undefined>(undefined);

const toastStyles: Record<ToastType, { container: string; iconClassName: string; icon: typeof Info }> = {
  success: {
    container: 'border-success/40',
    iconClassName: 'text-success',
    icon: CircleCheck
  },
  error: {
    container: 'border-danger/50',
    iconClassName: 'text-danger',
    icon: CircleAlert
  },
  info: {
    container: 'border-info/40',
    iconClassName: 'text-info',
    icon: Info
  }
};

const DEFAULT_DURATION_MS: Record<ToastType, number> = {
  success: 3500,
  info: 3500,
  error: 5000,
};
const ACTION_TOAST_MIN_DURATION_MS = 7000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toastQueue, setToastQueue] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);
  const activeToast = toastQueue[0] ?? null;

  const dismissToast = useCallback((id: number) => {
    setToastQueue(currentQueue => currentQueue.filter(item => item.id !== id));
  }, []);

  const triggerToast = useCallback<ToastDispatch>((msg, type = 'info', options) => {
    const message = msg.trim();
    if (!message) return;

    nextToastId.current += 1;
    setToastQueue(currentQueue => [
      ...currentQueue,
      { id: nextToastId.current, message, type, action: options?.action, durationMs: options?.durationMs }
    ]);
  }, []);

  useEffect(() => {
    if (!activeToast) return;

    const duration = activeToast.durationMs
      ?? (activeToast.action
        ? Math.max(DEFAULT_DURATION_MS[activeToast.type], ACTION_TOAST_MIN_DURATION_MS)
        : DEFAULT_DURATION_MS[activeToast.type]);
    const timeoutId = window.setTimeout(() => {
      setToastQueue(currentQueue => (
        currentQueue[0]?.id === activeToast.id
          ? currentQueue.slice(1)
          : currentQueue.filter(item => item.id !== activeToast.id)
      ));
    }, duration);

    return () => window.clearTimeout(timeoutId);
  }, [activeToast]);

  const activeStyle = activeToast ? toastStyles[activeToast.type] : null;
  const ToastIcon = activeStyle?.icon ?? Info;

  return (
    <ToastDispatchContext.Provider value={triggerToast}>
      <ToastStateContext.Provider value={activeToast?.message ?? null}>
        {children}
        <div
          className="pointer-events-none fixed inset-x-4 top-20 z-[9999] flex justify-end sm:left-auto sm:right-4 sm:w-[min(26rem,calc(100vw-2rem))]"
          aria-live={activeToast?.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {activeToast && activeStyle && (
            <div
              role={activeToast.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-surface-elevated px-4 py-3 text-foreground shadow-2xl animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none ${activeStyle.container}`}
            >
              <ToastIcon className={`mt-0.5 h-5 w-5 shrink-0 ${activeStyle.iconClassName}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5">{activeToast.message}</p>
                {toastQueue.length > 1 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {toastQueue.length - 1} more notification{toastQueue.length === 2 ? '' : 's'} queued
                  </p>
                )}
              </div>
              {activeToast.action && (
                <button
                  type="button"
                  onClick={() => {
                    activeToast.action?.onClick();
                    dismissToast(activeToast.id);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {activeToast.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismissToast(activeToast.id)}
                className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Dismiss notification"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      </ToastStateContext.Provider>
    </ToastDispatchContext.Provider>
  );
}

export function useToast() {
  const triggerToast = useContext(ToastDispatchContext);
  const toast = useContext(ToastStateContext);
  if (triggerToast === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return useMemo(() => ({ toast, triggerToast }), [toast, triggerToast]);
}

export function useToastDispatch() {
  const triggerToast = useContext(ToastDispatchContext);
  if (triggerToast === undefined) {
    throw new Error('useToastDispatch must be used within a ToastProvider');
  }
  return triggerToast;
}
