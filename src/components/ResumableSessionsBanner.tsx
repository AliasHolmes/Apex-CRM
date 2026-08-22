import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PlayCircle, Clock, Database, RefreshCw, Trash2, CheckSquare, Square, ChevronDown, ChevronUp } from 'lucide-react';

export type ResumableSession = {
  id: string;
  prompt: string;
  status: string;
  requestedLimit: number;
  checkpoint?: {
    round: number;
    stage: string;
    acceptedLeadsCount: number;
    updatedAt: string;
  } | null;
  startedAt?: string;
};

export interface ResumableSessionsBannerProps {
  onResumeSession: (session: ResumableSession) => void;
  activeSessionId?: string | null;
}

export function ResumableSessionsBanner({
  onResumeSession,
  activeSessionId
}: ResumableSessionsBannerProps) {
  const [resumableSessions, setResumableSessions] = useState<ResumableSession[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const fetchResumable = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/mining-sessions/resumable');
      if (!res.ok) return;
      const data = await res.json();
      const raw = Array.isArray(data.sessions) ? data.sessions : [];
      const parsed: ResumableSession[] = raw.map((s: any) => {
        let cp = null;
        if (s.checkpoint_json) {
          try {
            const parsedCp = typeof s.checkpoint_json === 'string' ? JSON.parse(s.checkpoint_json) : s.checkpoint_json;
            cp = {
              round: parsedCp.round || 1,
              stage: parsedCp.stage || 'enrich',
              acceptedLeadsCount: Array.isArray(parsedCp.acceptedLeads) ? parsedCp.acceptedLeads.length : 0,
              updatedAt: parsedCp.updatedAt || s.startedAt
            };
          } catch {}
        }
        return {
          id: s.id,
          prompt: s.prompt,
          status: s.status,
          requestedLimit: s.requested_limit || s.requestedLimit || 10,
          checkpoint: cp,
          startedAt: s.startedAt || s.started_at
        };
      });
      setResumableSessions(parsed.filter(s => s.id !== activeSessionId));
    } catch {
      // silently ignore transient network failures
    } finally {
      setLoading(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    void fetchResumable();
    const interval = setInterval(() => void fetchResumable(), 15000);
    return () => clearInterval(interval);
  }, [fetchResumable]);

  const handleResume = async (session: ResumableSession) => {
    setResumingId(session.id);
    try {
      await onResumeSession(session);
      setResumableSessions(prev => prev.filter(s => s.id !== session.id));
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
    } finally {
      setResumingId(null);
    }
  };

  const handleDeleteOne = async (sessionId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    setResumableSessions(prev => prev.filter(s => s.id !== sessionId));
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });

    try {
      await fetch(`/api/mining-sessions/${sessionId}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete mining session:', err);
      void fetchResumable();
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0 || isDeleting) return;
    const idsToDelete = Array.from(selectedIds);
    setIsDeleting(true);
    setResumableSessions(prev => prev.filter(s => !selectedIds.has(s.id)));
    setSelectedIds(new Set());

    try {
      await fetch('/api/mining-sessions/resumable', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: idsToDelete })
      });
    } catch (err) {
      console.error('Failed to delete selected sessions:', err);
      void fetchResumable();
    } finally {
      setIsDeleting(false);
    }
  };

  const handleClearAll = async () => {
    if (resumableSessions.length === 0 || isDeleting) return;
    setIsDeleting(true);
    setResumableSessions([]);
    setSelectedIds(new Set());

    try {
      await fetch('/api/mining-sessions/resumable', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch (err) {
      console.error('Failed to clear all interrupted sessions:', err);
      void fetchResumable();
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleSelectOne = (sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === resumableSessions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(resumableSessions.map(s => s.id)));
    }
  };

  if (resumableSessions.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t border-slate-800/80 space-y-3">
      {/* Header with bulk action controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-slate-950/60 p-2.5 rounded-lg border border-slate-800/80">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center gap-1.5 text-xs font-semibold text-amber-400 hover:text-amber-300 transition-colors"
          >
            <PlayCircle className="h-4 w-4 text-amber-500" />
            <span>Interrupted Searches ({resumableSessions.length})</span>
            {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>

          <button
            type="button"
            onClick={toggleSelectAll}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground ml-3 transition-colors"
          >
            {selectedIds.size === resumableSessions.length ? (
              <CheckSquare className="h-3.5 w-3.5 text-amber-400" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            <span>Select All</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleDeleteSelected()}
              disabled={isDeleting}
              className="h-7 text-xs border-rose-500/30 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Delete Selected ({selectedIds.size})
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleClearAll()}
            disabled={isDeleting}
            className="h-7 text-xs text-muted-foreground hover:text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Clear All
          </Button>
        </div>
      </div>

      {/* Collapsible Session List */}
      {!collapsed && (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {resumableSessions.map((session) => {
            const isSelected = selectedIds.has(session.id);
            return (
              <Card
                key={session.id}
                className={`border transition-all duration-150 ${
                  isSelected
                    ? 'border-amber-500/50 bg-amber-500/10 shadow-sm'
                    : 'border-amber-500/20 bg-amber-500/5 hover:border-amber-500/30'
                }`}
              >
                <CardContent className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => toggleSelectOne(session.id)}
                      className="mt-0.5 text-muted-foreground hover:text-amber-400 transition-colors shrink-0"
                    >
                      {isSelected ? (
                        <CheckSquare className="h-4 w-4 text-amber-400" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </button>

                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-xs text-foreground truncate max-w-md">
                          "{session.prompt}"
                        </span>
                        <Badge variant="outline" className="text-xs bg-background border-amber-500/30 text-amber-700 dark:text-amber-300">
                          Interrupted
                        </Badge>
                        {session.checkpoint && (
                          <Badge variant="secondary" className="text-xs">
                            Round {session.checkpoint.round} Checkpoint
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {session.checkpoint?.acceptedLeadsCount !== undefined && (
                          <span className="flex items-center gap-1">
                            <Database className="h-3.5 w-3.5" />
                            {session.checkpoint.acceptedLeadsCount} leads saved
                          </span>
                        )}
                        {session.startedAt && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" />
                            {new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <span>Target: {session.requestedLimit}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                    <Button
                      size="sm"
                      variant="default"
                      className="bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5 h-7 text-xs font-medium"
                      disabled={resumingId === session.id}
                      onClick={() => void handleResume(session)}
                    >
                      {resumingId === session.id ? (
                        <>
                          <RefreshCw className="h-3 w-3 animate-spin" />
                          Resuming...
                        </>
                      ) : (
                        <>
                          <PlayCircle className="h-3 w-3" />
                          Resume Session
                        </>
                      )}
                    </Button>

                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10"
                      onClick={(e) => void handleDeleteOne(session.id, e)}
                      title="Delete interrupted session"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Delete session</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
