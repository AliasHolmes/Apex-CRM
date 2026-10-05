import { useMemo, useState } from 'react';
import { ListFilter, Plus, Search, X } from 'lucide-react';
import { PIPELINE_STAGES, getPipelineStageMeta } from '@/lib/pipeline';
import {
  getNextActionLabel,
  getReviewStatusLabel,
  NEXT_ACTION_OPTIONS,
  REVIEW_STATUS_OPTIONS,
} from '@/lib/prospectWorkflow';
import {
  EMPTY_PROSPECT_FILTERS,
  countActiveFilters,
  type ProspectFilters,
} from '@/lib/prospectViews';
import type { LeadStage, NextAction, ReviewStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type FilterField = 'stage' | 'review' | 'nextAction' | 'location' | 'industry' | 'signal';

const FIELD_LABELS: Record<FilterField, string> = {
  stage: 'Stage',
  review: 'Review status',
  nextAction: 'Next action',
  location: 'Location',
  industry: 'Industry',
  signal: 'Buying signal',
};

const FIELD_ORDER: readonly FilterField[] = ['stage', 'review', 'nextAction', 'location', 'industry', 'signal'];

interface ProspectFilterBarProps {
  filters: ProspectFilters;
  onChange: (updates: Partial<ProspectFilters>) => void;
  locationOptions: readonly string[];
  industryOptions: readonly string[];
  resultCount: number;
  totalCount: number;
}

function describeFilterValue(field: FilterField, filters: ProspectFilters): string {
  switch (field) {
    case 'stage':
      return filters.stage === 'All' ? '' : getPipelineStageMeta(filters.stage as LeadStage).shortLabel;
    case 'review':
      return filters.review === 'All' ? '' : getReviewStatusLabel(filters.review as ReviewStatus);
    case 'nextAction':
      return filters.nextAction === 'All' ? '' : getNextActionLabel(filters.nextAction as NextAction);
    case 'location':
      return filters.location === 'All' ? '' : filters.location;
    case 'industry':
      return filters.industry === 'All' ? '' : filters.industry;
    case 'signal':
      return filters.signal === 'WHY_NOW' ? 'Has a why-now signal' : '';
  }
}

export function ProspectFilterBar({
  filters,
  onChange,
  locationOptions,
  industryOptions,
  resultCount,
  totalCount,
}: ProspectFilterBarProps) {
  const [open, setOpen] = useState(false);
  const [draftField, setDraftField] = useState<FilterField>('stage');
  const [draftValue, setDraftValue] = useState('');

  const activeFields = FIELD_ORDER.filter((field) => describeFilterValue(field, filters) !== '');
  const activeCount = countActiveFilters(filters);

  const valueOptions = useMemo<Array<{ value: string; label: string }>>(() => {
    switch (draftField) {
      case 'stage':
        return PIPELINE_STAGES.map((stage) => ({ value: stage.id, label: stage.shortLabel }));
      case 'review':
        return REVIEW_STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
      case 'nextAction':
        return NEXT_ACTION_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
      case 'location':
        return locationOptions.map((value) => ({ value, label: value }));
      case 'industry':
        return industryOptions.map((value) => ({ value, label: value }));
      case 'signal':
        return [{ value: 'WHY_NOW', label: 'Has a why-now signal' }];
    }
  }, [draftField, industryOptions, locationOptions]);

  const applyDraft = () => {
    if (!draftValue) return;
    onChange({ [draftField]: draftValue } as Partial<ProspectFilters>);
    setDraftValue('');
    setOpen(false);
  };

  const clearField = (field: FilterField) => {
    onChange({ [field]: 'All' } as Partial<ProspectFilters>);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative w-full md:w-96">
          <label htmlFor="prospect-search" className="sr-only">Search prospects</label>
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            id="prospect-search"
            type="text"
            value={filters.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder="Search people, companies, criteria, or uncertainties..."
            className="pl-9"
          />
        </div>

        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) {
              const firstUnused = FIELD_ORDER.find((field) => !activeFields.includes(field)) ?? 'stage';
              setDraftField(firstUnused);
              setDraftValue('');
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              <ListFilter aria-hidden="true" className="h-4 w-4" />
              Add filter
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="filter-field">Filter by</Label>
              <Select
                value={draftField}
                onValueChange={(value) => {
                  setDraftField(value as FilterField);
                  setDraftValue('');
                }}
              >
                <SelectTrigger id="filter-field"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_ORDER.map((field) => (
                    <SelectItem key={field} value={field}>{FIELD_LABELS[field]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-value">Is</Label>
              <Select value={draftValue} onValueChange={setDraftValue} disabled={valueOptions.length === 0}>
                <SelectTrigger id="filter-value">
                  <SelectValue placeholder={valueOptions.length === 0 ? 'No values yet' : 'Choose a value'} />
                </SelectTrigger>
                <SelectContent>
                  {valueOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" className="w-full" onClick={applyDraft} disabled={!draftValue}>
              <Plus aria-hidden="true" className="mr-1.5 h-4 w-4" />
              Apply filter
            </Button>
          </PopoverContent>
        </Popover>

        <p className="text-xs text-muted-foreground md:ml-auto" role="status" aria-live="polite">
          {activeCount > 0
            ? `${resultCount.toLocaleString()} of ${totalCount.toLocaleString()} prospects`
            : `${totalCount.toLocaleString()} prospects`}
        </p>
      </div>

      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Active filters">
          {filters.search.trim() && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-1 pl-3 pr-1.5 text-xs font-semibold text-primary">
              Search: {filters.search.trim()}
              <button
                type="button"
                onClick={() => onChange({ search: '' })}
                className="rounded-full p-0.5 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Clear search filter"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          )}
          {activeFields.map((field) => (
            <span
              key={field}
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-1 pl-3 pr-1.5 text-xs font-semibold text-primary"
            >
              {FIELD_LABELS[field]}: {describeFilterValue(field, filters)}
              <button
                type="button"
                onClick={() => clearField(field)}
                className="rounded-full p-0.5 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Remove ${FIELD_LABELS[field]} filter`}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            onClick={() => onChange({ ...EMPTY_PROSPECT_FILTERS })}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
