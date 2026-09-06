// @license Apache-2.0

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TabErrorBoundaryProps {
  tabName: string;
  children: ReactNode;
  onReset?: () => void;
}

interface TabErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey: number;
}

export class TabErrorBoundary extends Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  public state: TabErrorBoundaryState = {
    hasError: false,
    error: null,
    resetKey: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<TabErrorBoundaryState> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[TabErrorBoundary] Error caught in "${this.props.tabName}" tab:`, error, errorInfo);
  }

  public handleReset = () => {
    this.setState((prev) => ({ hasError: false, error: null, resetKey: prev.resetKey + 1 }));
    this.props.onReset?.();
  };

  public render() {
    if (this.state.hasError) {
      const errorMessage =
        this.state.error?.message || `An error occurred while rendering ${this.props.tabName}.`;

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="mx-auto my-6 max-w-2xl rounded-xl border border-rose-500/30 bg-slate-900/90 p-6 text-slate-100 shadow-xl backdrop-blur-sm"
        >
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-rose-500/20 p-2.5 text-rose-400 shrink-0">
              <AlertTriangle className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-rose-300">
                Failed to render {this.props.tabName}
              </h3>
              <p className="mt-2 text-xs font-mono break-words rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-slate-300 select-all">
                {errorMessage}
              </p>
              <div className="mt-4 flex items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={this.handleReset}
                  className="inline-flex items-center gap-2 border-rose-500/40 text-rose-200 hover:bg-rose-500/10 hover:text-white"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Retry Tab
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}

export default TabErrorBoundary;
