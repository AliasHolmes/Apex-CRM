import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PIPELINE_STAGES } from '@/lib/pipeline';
import type { LeadStage } from '@/types';

interface PipelineFunnelChartProps {
  stageCounts: Readonly<Record<LeadStage, number>>;
  totalLeads: number;
  onSelectStage?: (stage: LeadStage) => void;
}

interface Datum {
  id: LeadStage;
  label: string;
  count: number;
  color: string;
}

function ChartTooltip({ active, payload, totalLeads }: {
  active?: boolean;
  payload?: Array<{ payload: Datum }>;
  totalLeads: number;
}) {
  if (!active || !payload?.length) return null;
  const { label, count } = payload[0].payload;
  const share = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-bold">{label}</p>
      <p className="mt-0.5 text-muted-foreground">{count.toLocaleString()} prospects ({share}%)</p>
    </div>
  );
}

/** Horizontal funnel of prospects per stage, colored with the shared stage ramp. */
export function PipelineFunnelChart({ stageCounts, totalLeads, onSelectStage }: PipelineFunnelChartProps) {
  const data: Datum[] = PIPELINE_STAGES.map((stage, index) => ({
    id: stage.id,
    label: stage.shortLabel,
    count: stageCounts[stage.id] ?? 0,
    color: `hsl(var(--stage-${index + 1}))`,
  }));

  return (
    <div>
      <div
        className="h-[22rem] w-full"
        role="img"
        aria-label={`Prospects per pipeline stage: ${data.map((item) => `${item.label} ${item.count}`).join(', ')}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 32, bottom: 4, left: 0 }} barCategoryGap={8}>
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis type="category" dataKey="label" width={112} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ className: 'recharts-tooltip-cursor' }}
              content={<ChartTooltip totalLeads={totalLeads} />}
            />
            <Bar
              dataKey="count"
              radius={[0, 6, 6, 0]}
              minPointSize={3}
              label={{ position: 'right', className: 'recharts-bar-label' }}
              onClick={(entry) => {
                const stage = (entry as unknown as { id?: LeadStage }).id;
                if (stage && onSelectStage) onSelectStage(stage);
              }}
              style={{ cursor: onSelectStage ? 'pointer' : 'default' }}
              isAnimationActive={false}
            >
              {data.map((item) => (
                <Cell key={item.id} style={{ fill: item.color }} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>Prospects per pipeline stage</caption>
        <thead>
          <tr><th scope="col">Stage</th><th scope="col">Prospects</th></tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={item.id}><th scope="row">{item.label}</th><td>{item.count}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
