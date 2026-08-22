import React, { useEffect, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PlayCircle, Clock, Database, RefreshCw, XCircle } from 'lucide-react';

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
  onDismissSession?: (sessionId: string) => void;
  activeSessionId?: string | null;
}

export function ResumableSessionsBanner({
  onResumeSession,
  onDismissSession,
  activeSessionId
}: ResumableSessionsBannerProps) {
  const [resumableSessions, setResumableSessions] = useState<ResumableSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

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
    } finally {
      setResumingId(null);
    }
  };

  if (resumableSessions.length === 0) return null;

  return (
    <div className="space-y-2 mb-4">
      {resumableSessions.map((session) => (
        <Card key={session.id} className="border-amber-500/30 bg-amber-500/5 shadow-sm">
          <CardContent className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="p-1.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-md mt-0.5 shrink-0">
                <PlayCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-foreground truncate max-w-md">
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
                className="bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5 h-8 text-xs font-medium"
                disabled={resumingId === session.id}
                onClick={() => void handleResume(session)}
              >
                {resumingId === session.id ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Resuming...
                  </>
                ) : (
                  <>
                    <PlayCircle className="h-3.5 w-3.5" />
                    Resume Session
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
