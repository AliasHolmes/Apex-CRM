/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { 
  Users, 
  Percent, 
  Compass, 
  TrendingUp, 
  Award,
  Clock,
  Briefcase,
  AlertTriangle
} from 'lucide-react';
import { Lead } from '../types';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface CrmOverviewProps {
  leads: Lead[];
}

export default function CrmOverview({ leads }: CrmOverviewProps) {
  const totalLeads = leads.length;
  
  // Calculate pipeline distributions
  const newlyScrapedCount = leads.filter(l => l.stage === 'SCRAPED').length;
  const contactedCount = leads.filter(l => l.stage === 'SEQUENCE ACTIVE').length;
  const interestedCount = leads.filter(l => l.stage === 'MEETING BOOKED' || l.stage === 'REPLIED').length;
  const convertedCount = leads.filter(l => l.stage === 'CONVERTED').length;

  // Conversion rate percentage
  const conversionRate = totalLeads > 0 ? Math.round((convertedCount / totalLeads) * 100) : 0;

  // Average qualification score rating
  const scorableLeads = leads.filter(l => typeof l.compositeScore === 'number' && l.compositeScore > 0);
  const avgQualificationScore = scorableLeads.length > 0 
    ? (scorableLeads.reduce((acc, curr) => acc + (curr.compositeScore || 0), 0) / scorableLeads.length).toFixed(1)
    : 0;

  // Industry segmentation counts
  const industriesMap: Record<string, number> = {};
  leads.forEach(l => {
    const ind = l.profile.industry || 'Tech';
    industriesMap[ind] = (industriesMap[ind] || 0) + 1;
  });
  
  const industriesSorted = Object.entries(industriesMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  // Get score label quality
  const getScoreLabel = (score: number | string) => {
    const num = Number(score);
    if (isNaN(num)) return 'Unrated';
    if (num >= 80) return 'Top Tier (Hot)';
    if (num >= 60) return 'Qualified (Warm)';
    if (num >= 40) return 'Developing (Cool)';
    return 'Low Priority';
  };

  return (
    <div className="space-y-6">
      
      {/* 4-Column Metric Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        
        {/* Total Leads Card */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 bg-primary/10 text-primary rounded-xl flex items-center justify-center">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest block">Total Prospect Leads</span>
              <h4 className="text-2xl font-extrabold text-foreground mt-1">{totalLeads}</h4>
            </div>
          </CardContent>
        </Card>

        {/* Conversion Rate Card */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 bg-emerald-500/10 text-emerald-500 rounded-xl flex items-center justify-center">
              <Percent className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest block">Pipeline Conversion</span>
              <h4 className="text-2xl font-extrabold text-foreground mt-1">{conversionRate}%</h4>
            </div>
          </CardContent>
        </Card>

        {/* Avg Qualification Score Card */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 bg-blue-500/10 text-blue-500 rounded-xl flex items-center justify-center">
              <Award className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest block">Average Qualification</span>
              <h4 className="text-2xl font-extrabold text-foreground mt-1">{avgQualificationScore || '0'}%</h4>
            </div>
          </CardContent>
        </Card>

        {/* Lead Velocity Trend Card */}
        <Card>
          <CardContent className="p-5 flex items-center gap-4">
            <div className="h-12 w-12 bg-cyan-500/10 text-cyan-500 rounded-xl flex items-center justify-center">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-extrabold text-muted-foreground uppercase tracking-widest block">Conversion Quality</span>
              <Badge variant="outline" className="mt-2 text-xs font-bold">{getScoreLabel(avgQualificationScore)}</Badge>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* Analytics Distributions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Pipeline stage tracker graph */}
        <Card className="flex flex-col justify-between">
          <CardContent className="p-6 h-full flex flex-col justify-between">
            <div>
              <h4 className="font-extrabold text-foreground text-sm flex items-center gap-2 mb-1">
                <Clock className="w-4.5 h-4.5 text-primary" />
                Pipeline Volume Distribution
              </h4>
              <p className="text-xs text-muted-foreground mb-5">Current lead allocation statuses within your outbound pipe.</p>
            </div>

            <div className="space-y-4">
              {[
                { label: 'Newly Scraped Queue', count: newlyScrapedCount, color: 'bg-indigo-400' },
                { label: 'Outreach Sent Campaign', count: contactedCount, color: 'bg-cyan-500' },
                { label: 'In Discussion Deal', count: interestedCount, color: 'bg-blue-500' },
                { label: 'Successfully Converted', count: convertedCount, color: 'bg-emerald-500' },
              ].map((st, i) => {
                const pct = totalLeads > 0 ? (st.count / totalLeads) * 100 : 0;
                return (
                  <div key={i} className="space-y-1">
                    <div className="flex justify-between text-xs font-semibold text-foreground">
                      <span>{st.label}</span>
                      <span className="text-muted-foreground">{st.count} leads ({Math.round(pct)}%)</span>
                    </div>
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                      <div className={`h-full ${st.color} transition-all duration-500`} style={{ width: `${pct}%` }}></div>
                     </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Key Industry Sectors Segment */}
        <Card className="flex flex-col justify-between">
          <CardContent className="p-6 h-full flex flex-col justify-between">
            <div>
              <h4 className="font-extrabold text-foreground text-sm flex items-center gap-2 mb-1">
                <Briefcase className="w-4.5 h-4.5 text-primary" />
                Top Industry Segment targets
              </h4>
              <p className="text-xs text-muted-foreground mb-5">Leading industry fields from Tavily-backed LinkedIn search.</p>
            </div>

            <div className="space-y-4">
              {leads.length === 0 ? (
                <p className="text-xs text-muted-foreground italic text-center py-8">Gather profiles to populate industry segmentation metrics.</p>
              ) : (
                industriesSorted.map(([industry, count], i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1 border-b last:border-0 pb-2">
                    <div className="flex items-center gap-2.5">
                      <Badge variant="outline" className="w-5 h-5 flex items-center justify-center p-0 font-bold text-[10px]">
                        {i + 1}
                      </Badge>
                      <span className="font-semibold text-foreground">{industry}</span>
                    </div>
                    <Badge variant="secondary" className="font-bold text-[10px]">
                      {count} profile{count > 1 ? 's' : ''}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Outbound Activity Log */}
        <Card className="flex flex-col justify-between">
          <CardContent className="p-6 h-full flex flex-col justify-between">
            <div>
              <h4 className="font-extrabold text-foreground text-sm flex items-center gap-2 mb-1">
                <Clock className="w-4.5 h-4.5 text-primary" />
                Outbound Activity Log
              </h4>
              <p className="text-xs text-muted-foreground mb-5">Latest records log audits for lead harvesting and structuring activity pipelines.</p>
            </div>

            <div className="space-y-3.5 max-h-[170px] overflow-y-auto pr-1 custom-scrollbar">
              {totalLeads === 0 ? (
                <p className="text-xs text-muted-foreground italic text-center py-6">Database is empty. Log output will load upon search/scraping tasks execution.</p>
              ) : (
                leads.slice(0, 4).map((l, i) => (
                  <div key={i} className="flex items-start gap-2.5 text-xs">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5 animate-pulse" />
                    <div>
                      <span className="font-semibold text-foreground hover:text-primary transition-colors">Harvested {l.profile.fullName}</span>
                      <span className="text-[10px] text-muted-foreground block mt-0.5">
                        Structured under {l.profile.industry || 'Tech'} - {new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

      </div>

    </div>
  );
}
