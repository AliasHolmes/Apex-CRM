/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import {
  Award,
  Briefcase,
  CircleCheck,
  Clock,
  Flame,
  Inbox,
  Percent,
  Radar,
  SendHorizontal,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserPlus2,
  UserRoundCheck,
  Users,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import type { Lead, LeadStage } from '../types';
import type { LeadContextStats } from '../context/LeadContext';
import type { DashboardTab } from '@/lib/navigation';
import type { ProspectFilters } from '@/lib/prospectViews';
import { getMatchScore } from '@/lib/matchScore';
import { bucketAddsByDay, countStrongMatches, countTodayItems, weekOverWeek } from '@/lib/overviewStats';
import { PIPELINE_STAGES } from '@/lib/pipeline';
import { formatRelativeTime } from '@/lib/relativeTime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { IconChip } from '@/components/icons';
import { PageHeader } from '@/components/PageHeader';
import { PipelineFunnelChart } from '@/components/overview/PipelineFunnelChart';
import { Sparkline } from '@/components/overview/Sparkline';

interface CrmOverviewProps {
  leads: Lead[];
  stats?: LeadContextStats;
  onNavigate: (tab: DashboardTab) => void;
  onOpenLead: (leadId: string) => void;
  onViewProspects: (filters: Partial<ProspectFilters>) => void;
  onAddProspect: () => void;
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Top tier';
  if (score >= 60) return 'Qualified';
  if (score >= 40) return 'Developing';
  return score > 0 ? 'Low priority' : 'Unrated';
}

interface TodayTileProps {
  icon: LucideIcon;
  tone: 'warning' | 'brand' | 'info' | 'success';
  count: number;
  label: string;
  hint: string;
  onSelect: () => void;
}

function TodayTile({ icon, tone, count, label, hint, onSelect }: TodayTileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={count === 0}
      className="group flex w-full items-center gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-card motion-reduce:transition-none"
    >
      <IconChip icon={icon} tone={tone} size="lg" />
      <span className="min-w-0">
        <span className="block text-2xl font-extrabold leading-none text-foreground">{count.toLocaleString()}</span>
        <span className="mt-1 block truncate text-sm font-semibold text-foreground">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{count === 0 ? 'Nothing waiting' : hint}</span>
      </span>
    </button>
  );
}

function TrendBadge({ changePercent, thisWeek }: { changePercent: number | null; thisWeek: number }) {
  if (changePercent === null) {
    return (
      <span className="text-xs text-muted-foreground">
        {thisWeek > 0 ? `${thisWeek.toLocaleString()} added this week` : 'No new prospects this week'}
      </span>
    );
  }
  const positive = changePercent >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${positive ? 'text-success' : 'text-danger'}`}>
      <TrendIcon aria-hidden="true" className="h-3.5 w-3.5" />
      {positive ? '+' : ''}{changePercent}% vs last week
      <span className="font-normal text-muted-foreground">({thisWeek.toLocaleString()} added)</span>
    </span>
  );
}

const ONBOARDING_STEPS: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: 'discover', title: 'Discover people', description: 'Describe who you want to reach and review the evidence.', icon: Radar },
  { id: 'add', title: 'Add prospects', description: 'Save the ones worth pursuing, or add a contact you already know.', icon: UserPlus2 },
  { id: 'enrich', title: 'Review and enrich', description: 'Confirm fit and verify public profile details.', icon: UserRoundCheck },
  { id: 'outreach', title: 'Reach out', description: 'Draft personalized messages from the evidence you collected.', icon: SendHorizontal },
];

export default function CrmOverview({
  leads,
  stats,
  onNavigate,
  onOpenLead,
  onViewProspects,
  onAddProspect,
}: CrmOverviewProps) {
  const analytics = useMemo(() => {
    const stageCounts = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage.id, 0]),
    ) as Record<LeadStage, number>;
    const industries = new Map<string, number>();
    let qualificationTotal = 0;
    let qualificationCount = 0;

    for (const lead of leads) {
      stageCounts[lead.stage] = (stageCounts[lead.stage] ?? 0) + 1;
      const industry = lead.profile.industry?.trim() || 'Uncategorized';
      industries.set(industry, (industries.get(industry) ?? 0) + 1);

      const score = getMatchScore(lead);
      if (score !== null) {
        qualificationTotal += score;
        qualificationCount += 1;
      }
    }

    const recentLeads = [...leads]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 5);

    return {
      stageCounts,
      averageQualification: qualificationCount > 0 ? qualificationTotal / qualificationCount : 0,
      topIndustries: [...industries.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5),
      recentLeads,
      dailyAdds: bucketAddsByDay(leads, 14),
      weekly: weekOverWeek(leads),
      today: countTodayItems(leads),
      strongMatches: countStrongMatches(leads),
    };
  }, [leads]);

  const totalLeads = stats ? stats.total : leads.length;
  const stageCounts = stats?.stageCounts ?? analytics.stageCounts;
  const conversionRate = stats
    ? stats.conversionRate
    : (totalLeads > 0 ? Math.round(((stageCounts['CONVERTED'] ?? 0) / totalLeads) * 100) : 0);
  const averageQualification = stats
    ? Math.round(stats.averageQualification * 10) / 10
    : Math.round(analytics.averageQualification * 10) / 10;
  const strongShare = leads.length > 0 ? Math.round((analytics.strongMatches / leads.length) * 100) : 0;

  if (totalLeads === 0 && leads.length === 0) {
    return (
      <div>
        <PageHeader
          id="overview-heading"
          title="Welcome to Apex CRM"
          description="Four steps from a blank workspace to your first outreach message."
        />
        <ol className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ONBOARDING_STEPS.map((step, index) => (
            <li key={step.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-5">
                  <div className="flex items-center justify-between">
                    <IconChip icon={step.icon} tone="brand" size="lg" />
                    <span className="text-xs font-bold text-muted-foreground">Step {index + 1}</span>
                  </div>
                  <h3 className="text-base font-bold text-foreground">{step.title}</h3>
                  <p className="flex-1 text-sm text-muted-foreground">{step.description}</p>
                  {step.id === 'discover' && <Button size="sm" onClick={() => onNavigate('workspace')}>Start discovering</Button>}
                  {step.id === 'add' && <Button size="sm" variant="outline" onClick={onAddProspect}>Add a prospect</Button>}
                  {step.id === 'enrich' && <Button size="sm" variant="outline" onClick={() => onNavigate('inventory')}>Open prospects</Button>}
                  {step.id === 'outreach' && <Button size="sm" variant="outline" onClick={() => onNavigate('outreach')}>Open outreach</Button>}
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        id="overview-heading"
        title="Overview"
        description="Where your pipeline stands and what to do next."
      />

      <section aria-labelledby="overview-today-heading" className="space-y-3">
        <h3 id="overview-today-heading" className="flex items-center gap-2 text-sm font-bold text-foreground">
          <Sparkles aria-hidden="true" className="h-4 w-4 text-primary" />
          Today
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <TodayTile
            icon={Flame}
            tone="warning"
            count={analytics.today.whyNow}
            label="Why-now signals"
            hint="Recent activity worth acting on"
            onSelect={() => onViewProspects({ signal: 'WHY_NOW' })}
          />
          <TodayTile
            icon={Inbox}
            tone="brand"
            count={analytics.today.unreviewed}
            label="Waiting for review"
            hint="Decide keep, maybe, or reject"
            onSelect={() => onViewProspects({ review: 'UNREVIEWED' })}
          />
          <TodayTile
            icon={SendHorizontal}
            tone="info"
            count={analytics.today.readyToMessage}
            label="Ready to message"
            hint="Next action is Message"
            onSelect={() => onViewProspects({ nextAction: 'MESSAGE' })}
          />
          <TodayTile
            icon={WandSparkles}
            tone="success"
            count={analytics.today.readyToConnect}
            label="Ready to connect"
            hint="Next action is Connect"
            onSelect={() => onViewProspects({ nextAction: 'CONNECT' })}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-4">
              <IconChip icon={Users} tone="brand" size="lg" />
              <div>
                <span className="block text-xs font-semibold text-muted-foreground">Total prospects</span>
                <p className="mt-1 text-2xl font-bold text-foreground">{totalLeads.toLocaleString()}</p>
              </div>
            </div>
            <Sparkline values={analytics.dailyAdds} label="Prospects added per day over the last 14 days" />
            <TrendBadge changePercent={analytics.weekly.changePercent} thisWeek={analytics.weekly.thisWeek} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-4">
              <IconChip icon={Award} tone="info" size="lg" />
              <div>
                <span className="block text-xs font-semibold text-muted-foreground">Strong matches</span>
                <p className="mt-1 text-2xl font-bold text-foreground">{analytics.strongMatches.toLocaleString()}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {strongShare}% of prospects score 80 or higher.
            </p>
            <Button type="button" variant="soft" size="xs" onClick={() => onViewProspects({})}>
              Browse prospects
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-4">
              <IconChip icon={CircleCheck} tone="success" size="lg" />
              <div>
                <span className="block text-xs font-semibold text-muted-foreground">Average qualification</span>
                <p className="mt-1 text-2xl font-bold text-foreground">{averageQualification}%</p>
              </div>
            </div>
            <Badge variant="outline" className="text-xs font-semibold">{scoreLabel(averageQualification)}</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-center gap-4">
              <IconChip icon={Percent} tone="warning" size="lg" />
              <div>
                <span className="block text-xs font-semibold text-muted-foreground">Conversion rate</span>
                <p className="mt-1 text-2xl font-bold text-foreground">{conversionRate}%</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {(stageCounts['CONVERTED'] ?? 0).toLocaleString()} converted of {totalLeads.toLocaleString()}.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                  <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
                  Pipeline funnel
                </h3>
                <p className="text-sm text-muted-foreground">Every prospect, across every CRM stage. Select a bar to open that stage.</p>
              </div>
              <Button type="button" variant="ghost" size="xs" onClick={() => onNavigate('pipeline')}>
                Open pipeline
              </Button>
            </div>
            <PipelineFunnelChart
              stageCounts={stageCounts}
              totalLeads={totalLeads}
              onSelectStage={(stage) => onViewProspects({ stage })}
            />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardContent className="p-6">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Briefcase className="h-4 w-4 text-primary" aria-hidden="true" />
                Top industries
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">The largest segments in your list.</p>
              <ul className="space-y-1">
                {analytics.topIndustries.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">Add prospects to see industry trends.</li>
                ) : analytics.topIndustries.map(([industry, count], index) => (
                  <li key={industry}>
                    <button
                      type="button"
                      disabled={industry === 'Uncategorized'}
                      onClick={() => onViewProspects({ industry })}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent motion-reduce:transition-none"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Badge variant="outline" className="flex h-6 w-6 shrink-0 items-center justify-center p-0 text-xs">{index + 1}</Badge>
                        <span className="truncate text-sm font-medium text-foreground">{industry}</span>
                      </span>
                      <Badge variant="secondary" className="text-xs">{count.toLocaleString()}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
                Recently added
              </h3>
              <p className="mb-4 text-sm text-muted-foreground">The newest records saved to the CRM.</p>
              <ul className="space-y-1">
                {analytics.recentLeads.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">Your newest prospects will appear here.</li>
                ) : analytics.recentLeads.map((lead) => (
                  <li key={lead.id}>
                    <button
                      type="button"
                      onClick={() => onOpenLead(lead.id)}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    >
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-foreground">{lead.profile.fullName}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {lead.profile.industry || 'Uncategorized'} - {formatRelativeTime(lead.createdAt) || 'recently'}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
