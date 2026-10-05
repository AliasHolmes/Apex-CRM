import { useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { Lead } from '@/types';
import { getPipelineStageMeta } from '@/lib/pipeline';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

interface HeaderSearchProps {
  leads: readonly Lead[];
  onOpenLead: (leadId: string) => void;
}

const MAX_RESULTS = 8;
const MIN_QUERY_LENGTH = 2;

function searchLeads(leads: readonly Lead[], query: string): Lead[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < MIN_QUERY_LENGTH) return [];
  const startsWithName: Lead[] = [];
  const contains: Lead[] = [];
  for (const lead of leads) {
    const name = (lead.profile?.fullName ?? '').toLocaleLowerCase();
    const haystack = `${name} ${(lead.profile?.currentCompany ?? '').toLocaleLowerCase()} ${(lead.profile?.currentTitle ?? '').toLocaleLowerCase()}`;
    if (!haystack.includes(needle)) continue;
    (name.startsWith(needle) ? startsWithName : contains).push(lead);
    if (startsWithName.length >= MAX_RESULTS) break;
  }
  return [...startsWithName, ...contains].slice(0, MAX_RESULTS);
}

/** Header search: find a prospect by name, company, or title and open it in the lead drawer. */
export function HeaderSearch({ leads, onOpenLead }: HeaderSearchProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchLeads(leads, deferredQuery), [deferredQuery, leads]);
  const showPanel = open && query.trim().length >= MIN_QUERY_LENGTH;

  const choose = (lead: Lead) => {
    onOpenLead(lead.id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <Popover open={showPanel} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative hidden w-52 md:block lg:w-40 xl:w-72">
          <label htmlFor={`${listId}-input`} className="sr-only">Search prospects</label>
          <Search aria-hidden="true" className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            id={`${listId}-input`}
            type="search"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showPanel && results.length > 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(results.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter' && results[activeIndex]) {
                event.preventDefault();
                choose(results[activeIndex]);
              } else if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
            placeholder="Find a prospect..."
            className="h-9 pl-9"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-72 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target === inputRef.current) event.preventDefault();
        }}
      >
        {results.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground" role="status">No prospects match &quot;{query.trim()}&quot;.</p>
        ) : (
          <ul id={listId} role="listbox" aria-label="Matching prospects">
            {results.map((lead, index) => (
              <li
                key={lead.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(lead)}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 ${index === activeIndex ? 'bg-accent text-accent-foreground' : ''}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{lead.profile.fullName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[lead.profile.currentTitle, lead.profile.currentCompany].filter(Boolean).join(' at ') || 'No role on file'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{getPipelineStageMeta(lead.stage).shortLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
