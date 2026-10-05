import { useState } from 'react';
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';
import type { ProspectView } from '@/lib/prospectViews';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SavedViewsMenuProps {
  views: readonly ProspectView[];
  activeViewId: string | null;
  onApply: (view: ProspectView) => void;
  onDelete: (viewId: string) => void;
  onSave: (name: string) => void;
}

export function SavedViewsMenu({ views, activeViewId, onApply, onDelete, onSave }: SavedViewsMenuProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const activeView = views.find((view) => view.id === activeViewId) ?? null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName('');
    setDialogOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="gap-1.5">
            <Bookmark aria-hidden="true" className="h-4 w-4" />
            {activeView ? activeView.name : 'Views'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {views.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Save the current filters, sort, and columns to come back to them in one click.
            </p>
          )}
          {views.map((view) => (
            <DropdownMenuItem
              key={view.id}
              onSelect={() => onApply(view)}
              className="justify-between gap-2"
            >
              <span className={`truncate ${view.id === activeViewId ? 'font-bold text-primary' : ''}`}>{view.name}</span>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(view.id);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Delete view ${view.name}`}
              >
                <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
            <BookmarkPlus aria-hidden="true" />
            Save current view...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Save this view</DialogTitle>
              <DialogDescription>
                Saves your filters, sort order, density, and visible columns in this browser.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="view-name">View name</Label>
              <Input
                id="view-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. High intent, needs review"
                maxLength={60}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!name.trim()}>Save view</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
