/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Award, Briefcase, Clock, Percent, TrendingUp, Users } from 'lucide-react';
import type { Lead, LeadStage } from '../types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { PIPELINE_STAGES } from '@/lib/pipeline';

interface CrmOverviewProps {
  leads: Lead[];
}

function normalizedQualificationScore(lead: Lead): number | null {
  const score = lead.qualificationScore ?? lead.predictiveScore ?? lead.compositeScore;
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) return null;
  return score <= 10 ? score * 10 : score;
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Top tier';
  if (score >= 60) return 'Qualified';
  if (score >= 40) return 'Developing';
  return score > 0 ? 'Low priority' : 'Unrated';
}

export default function CrmOverview({ leads }: CrmOverviewProps) {
  const analytics = useMemo(() => {
    const stageCounts = Object.fromEntries(
      PIPELINE_STAGES.map((stage) => [stage.id, 0]),
    ) as Record<LeadStage, number>;
    const industries = new Map<string, number>();
    let qualificationTotal = 0;
    let qualificationCount = 0;

    for (const lead of leads) {
      stageCounts[lead.stage] = (stageCounts[lead.stage] ?? 0) + 1;
      const industry = lead.profile.industry || 'Uncategorized';
      industries.set(industry, (industries.get(industry) ?? 0) + 1);

      const score = normalizedQualificationScore(lead);
      if (score !== null) {
        qualificationTotal += score;
        qualificationCount += 1;
      }
    }

    const recentLeads = [...leads]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 4);

    return {
      stageCounts,
      averageQualification: qualificationCount > 0
        ? qualificationTotal / qualificationCount
        : 0,
      topIndustries: [...industries.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 4),
      recentLeads,
    };
  }, [leads]);

  const totalLeads = leads.length;
  const convertedCount = analytics.stageCounts.CONVERTED;
  const conversionRate = totalLeads > 0
    ? Math.round((convertedCount / totalLeads) * 100)
    : 0;
  const averageQualification = Math.round(analytics.averageQualification * 10) / 10;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Users className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Total prospects</span>
              <h3 className="mt-1 text-2xl font-bold text-foreground">{totalLeads}</h3>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
              <Percent className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Conversion rate</span>
              <h3 className="mt-1 text-2xl font-bold text-foreground">{conversionRate}%</h3>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
              <Award className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Average qualification</span>
              <h3 className="mt-1 text-2xl font-bold text-foreground">{averageQualification}%</h3>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
              <TrendingUp className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <span className="block text-xs font-semibold text-muted-foreground">Lead quality</span>
              <Badge variant="outline" className="mt-2 text-xs font-semibold">
                {scoreLabel(averageQualification)}
              </Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="flex flex-col">
          <CardContent className="flex h-full flex-col p-6">
            <div>
              <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
                Pipeline distribution
              </h3>
              <p className="mb-5 text-sm text-muted-foreground">Every prospect, across every CRM stage.</p>
            </div>

            <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {PIPELINE_STAGES.map((stage) => {
                const count = analytics.stageCounts[stage.id] ?? 0;
                const percentage = totalLeads > 0 ? (count / totalLeads) * 100 : 0;
                return (
                  <div key={stage.id} className="space-y-1.5">
                    <div className="flex justify-between gap-3 text-xs font-medium text-foreground">
                      <span>{stage.shortLabel}</span>
                      <span className="whitespace-nowrap text-muted-foreground">
                        {count} ({Math.round(percentage)}%)
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`h-full rounded-full ${stage.dotClassName} motion-reduce:transition-none`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardContent className="flex h-full flex-col p-6">
            <div>
              <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Briefcase className="h-4 w-4 text-primary" aria-hidden="true" />
                Top industries
              </h3>
              <p className="mb-5 text-sm text-muted-foreground">The largest segments in your current prospect list.</p>
            </div>

            <div className="space-y-3">
              {analytics.topIndustries.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Add prospects to see industry trends.</p>
              ) : analytics.topIndustries.map(([industry, count], index) => (
                <div key={industry} className="flex items-center justify-between border-b py-2 last:border-0">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Badge variant="outline" className="flex h-6 w-6 shrink-0 items-center justify-center p-0 text-xs">
                      {index + 1}
                    </Badge>
                    <span className="truncate text-sm font-medium text-foreground">{industry}</span>
                  </div>
                  <Badge variant="secondary" className="text-xs">{count}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardContent className="flex h-full flex-col p-6">
            <div>
              <h3 className="mb-1 flex items-center gap-2 text-sm font-bold text-foreground">
                <Clock className="h-4 w-4 text-primary" aria-hidden="true" />
                Recently added prospects
              </h3>
              <p className="mb-5 text-sm text-muted-foreground">The newest records saved to the CRM.</p>
            </div>

            <div className="space-y-3.5">
              {analytics.recentLeads.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Your newest prospects will appear here.</p>
              ) : analytics.recentLeads.map((lead) => (
                <div key={lead.id} className="flex items-start gap-2.5 text-sm">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{lead.profile.fullName}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {lead.profile.industry || 'Uncategorized'} - {new Date(lead.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
