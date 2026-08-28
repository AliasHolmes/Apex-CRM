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
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastContextType {
  /** The message currently visible. Kept for compatibility with existing consumers. */
  toast: string | null;
  triggerToast: (msg: string, type?: ToastType) => void;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const ToastStateContext = createContext<string | null>(null);
const ToastDispatchContext = createContext<((msg: string, type?: ToastType) => void) | undefined>(undefined);

const toastStyles: Record<ToastType, { container: string; icon: typeof Info }> = {
  success: {
    container: 'border-emerald-500/40 bg-emerald-950/95 text-emerald-50',
    icon: CheckCircle2
  },
  error: {
    container: 'border-rose-500/40 bg-rose-950/95 text-rose-50',
    icon: AlertCircle
  },
  info: {
    container: 'border-sky-500/40 bg-slate-900/95 text-slate-100',
    icon: Info
  }
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toastQueue, setToastQueue] = useState<ToastItem[]>([]);
  const nextToastId = useRef(0);
  const activeToast = toastQueue[0] ?? null;

  const dismissToast = useCallback((id: number) => {
    setToastQueue(currentQueue => currentQueue.filter(item => item.id !== id));
  }, []);

  const triggerToast = useCallback((msg: string, type: ToastType = 'info') => {
    const message = msg.trim();
    if (!message) return;

    nextToastId.current += 1;
    setToastQueue(currentQueue => [
      ...currentQueue,
      { id: nextToastId.current, message, type }
    ]);
  }, []);

  useEffect(() => {
    if (!activeToast) return;

    const duration = activeToast.type === 'error' ? 5000 : 3500;
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
          className="pointer-events-none fixed inset-x-4 top-20 z-[9999] flex justify-end sm:left-auto sm:right-4 sm:w-[min(24rem,calc(100vw-2rem))]"
          aria-live={activeToast?.type === 'error' ? 'assertive' : 'polite'}
          aria-atomic="true"
        >
          {activeToast && activeStyle && (
            <div
              role={activeToast.type === 'error' ? 'alert' : 'status'}
              className={`pointer-events-auto flex w-full items-start gap-3 rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none ${activeStyle.container}`}
            >
              <ToastIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-5">{activeToast.message}</p>
                {toastQueue.length > 1 && (
                  <p className="mt-1 text-xs opacity-70">
                    {toastQueue.length - 1} more notification{toastQueue.length === 2 ? '' : 's'} queued
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(activeToast.id)}
                className="-mr-1 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
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
