import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAdmin } from '@/contexts/AdminContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, BarChart, Bar,
} from 'recharts';
import { Eye, Users, Globe, ArrowUpRight, Monitor, Smartphone, Tablet, MousePointerClick } from 'lucide-react';
import { formatNumber } from '@/lib/utils';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalyticsOverview {
  views: number;
  visitors: number;
  uniqueIPs: number;
  sessions: number;
  bounceRate: number;
  avgPages: number;
}
interface DailyRow    { bucket: string; views: number; visitors: number }
interface PageRow     { path: string;  views: number; pct: number }
interface RefRow      { source: string; visits: number; pct: number }
interface BreakRow    { name: string; value: number }
interface DevicesData { devices: BreakRow[]; browsers: BreakRow[]; os: BreakRow[] }
interface RecentRow   {
  id: number; ts: string; path: string; referrer: string | null;
  ip: string; browser: string; os: string; device: string;
  session_id: string; user_address: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RANGES = ['1d', '7d', '30d', '90d'] as const;
type Range = typeof RANGES[number];
const RANGE_LABELS: Record<Range, string> = { '1d': '24h', '7d': '7 days', '30d': '30 days', '90d': '90 days' };

const COLORS = [
  'hsl(142 76% 55%)',
  'hsl(214 100% 68%)',
  'hsl(280 65% 60%)',
  'hsl(38 90% 55%)',
  'hsl(0 72% 60%)',
  'hsl(190 80% 55%)',
];

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useAnalytics(range: Range) {
  const { apiFetch, secret } = useAdmin();
  const opts = { enabled: !!secret, staleTime: 60_000 };
  const q = `?range=${range}`;

  const overview   = useQuery({ queryKey: ['analytics-overview',   range], queryFn: () => apiFetch<AnalyticsOverview>(`/admin/analytics${q}`),            ...opts });
  const daily      = useQuery({ queryKey: ['analytics-daily',      range], queryFn: () => apiFetch<DailyRow[]>(`/admin/analytics/daily${q}`),             ...opts });
  const pages      = useQuery({ queryKey: ['analytics-pages',      range], queryFn: () => apiFetch<{ total: number; rows: PageRow[] }>(`/admin/analytics/pages${q}&limit=20`), ...opts });
  const referrers  = useQuery({ queryKey: ['analytics-referrers',  range], queryFn: () => apiFetch<{ total: number; rows: RefRow[] }>(`/admin/analytics/referrers${q}&limit=20`), ...opts });
  const devices    = useQuery({ queryKey: ['analytics-devices',    range], queryFn: () => apiFetch<DevicesData>(`/admin/analytics/devices${q}`),           ...opts });
  const recent     = useQuery({ queryKey: ['analytics-recent'],            queryFn: () => apiFetch<RecentRow[]>('/admin/analytics/recent?limit=50'),        enabled: !!secret, staleTime: 15_000, refetchInterval: 15_000 });

  return { overview, daily, pages, referrers, devices, recent };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({ title, value, sub, icon: Icon, accent }: {
  title: string; value: string; sub?: string; icon: React.ElementType; accent?: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
          <div className={cn("p-1.5 rounded-md", accent ?? "bg-primary/10")}>
            <Icon className="w-3.5 h-3.5 text-primary" />
          </div>
        </div>
        <div className="text-2xl font-semibold font-mono tabular text-foreground">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function DonutCard({ title, data }: { title: string; data: BreakRow[] }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2 border-b border-border">
        <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 p-4 flex flex-col gap-2">
        <ResponsiveContainer width="100%" height={120}>
          <PieChart>
            <Pie data={data} innerRadius={36} outerRadius={54} paddingAngle={2} dataKey="value" strokeWidth={0}>
              {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', fontSize: 11, borderRadius: 6 }}
              itemStyle={{ color: 'hsl(var(--foreground))' }}
              labelStyle={{ display: 'none' }}
              formatter={(v: number) => [`${Math.round((v / total) * 100)}%  (${formatNumber(v)})`]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1.5 mt-1">
          {data.slice(0, 6).map((d, i) => (
            <div key={d.name} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-muted-foreground min-w-0">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                <span className="truncate">{d.name}</span>
              </div>
              <span className="font-mono text-foreground ml-2 flex-shrink-0">{Math.round((d.value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ProgressRow({ label, value, total, rank }: { label: string; value: number; total: number; rank: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
      <span className="text-xs font-mono text-muted-foreground w-5 text-center">{rank}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-foreground truncate max-w-[180px] md:max-w-[280px]">{label}</span>
          <span className="text-xs font-mono text-muted-foreground ml-2 flex-shrink-0">{formatNumber(value)}</span>
        </div>
        <div className="h-1 bg-muted rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      </div>
      <span className="text-xs font-mono text-muted-foreground w-10 text-right flex-shrink-0">{Math.round(pct)}%</span>
    </div>
  );
}

function DeviceIcon({ device }: { device: string }) {
  if (device === 'Mobile') return <Smartphone className="w-3 h-3" />;
  if (device === 'Tablet') return <Tablet className="w-3 h-3" />;
  return <Monitor className="w-3 h-3" />;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Analytics() {
  const [range, setRange] = useState<Range>('7d');
  const { overview, daily, pages, referrers, devices, recent } = useAnalytics(range);

  const ov = overview.data;
  const loading = overview.isLoading;

  return (
    <div className="space-y-6">

      {/* Range selector */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground uppercase tracking-wider mr-1">Period</span>
        {RANGES.map(r => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
              range === r
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {loading ? [1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-28" />) : <>
          <KpiCard title="Page Views"    value={formatNumber(ov?.views    ?? 0)} icon={Eye}             />
          <KpiCard title="Visitors"      value={formatNumber(ov?.visitors  ?? 0)} sub="Unique sessions" icon={Users}           />
          <KpiCard title="Unique IPs"    value={formatNumber(ov?.uniqueIPs ?? 0)} icon={Globe}           />
          <KpiCard title="Sessions"      value={formatNumber(ov?.sessions  ?? 0)} icon={MousePointerClick} />
          <KpiCard title="Bounce Rate"   value={`${ov?.bounceRate ?? 0}%`}       sub="Single-page sessions" icon={ArrowUpRight} />
          <KpiCard title="Avg Pages"     value={`${ov?.avgPages ?? 0}`}          sub="Per session"       icon={Eye}            />
        </>}
      </div>

      {/* Time series chart */}
      <Card>
        <CardHeader className="border-b border-border pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Views & Visitors — {RANGE_LABELS[range]}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0" style={{ height: 240 }}>
          {daily.isLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily.data ?? []} margin={{ top: 16, right: 24, left: 0, bottom: 8 }}>
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={formatNumber} width={40} />
                <Tooltip
                  contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', fontSize: 12, borderRadius: 6 }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                  labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
                <Line type="monotone" dataKey="views"    name="Views"    stroke={COLORS[0]} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="visitors" name="Visitors" stroke={COLORS[1]} strokeWidth={2} dot={false} strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Top pages + Top referrers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Top Pages</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {pages.isLoading
              ? [1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 mb-2" />)
              : (pages.data?.rows ?? []).map((r, i) => (
                  <ProgressRow key={r.path} rank={i + 1} label={r.path} value={r.views} total={pages.data?.total ?? 1} />
                ))
            }
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b border-border pb-3">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Traffic Sources</CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            {referrers.isLoading
              ? [1,2,3,4,5].map(i => <Skeleton key={i} className="h-10 mb-2" />)
              : (referrers.data?.rows ?? []).map((r, i) => (
                  <ProgressRow key={r.source} rank={i + 1} label={r.source} value={r.visits} total={referrers.data?.total ?? 1} />
                ))
            }
          </CardContent>
        </Card>
      </div>

      {/* Device / Browser / OS donuts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {devices.isLoading
          ? [1,2,3].map(i => <Skeleton key={i} className="h-64" />)
          : <>
              <DonutCard title="Devices"  data={devices.data?.devices  ?? []} />
              <DonutCard title="Browsers" data={devices.data?.browsers ?? []} />
              <DonutCard title="OS"       data={devices.data?.os       ?? []} />
            </>
        }
      </div>

      {/* Recent visitors */}
      <Card>
        <CardHeader className="border-b border-border pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent Visitors</CardTitle>
          <span className="text-xs text-muted-foreground">Live · refreshes every 15s</span>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                {['IP Address', 'Path', 'Source', 'Browser', 'OS', 'Device', 'Time'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 font-medium uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.isLoading
                ? [1,2,3,4,5].map(i => (
                    <tr key={i} className="border-b border-border/50">
                      {[1,2,3,4,5,6,7].map(j => <td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>)}
                    </tr>
                  ))
                : (recent.data ?? []).map(row => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-2.5">
                        <code className="font-mono text-xs text-foreground/80 bg-muted px-1.5 py-0.5 rounded">
                          {row.ip || '—'}
                        </code>
                      </td>
                      <td className="px-4 py-2.5 max-w-[160px]">
                        <span className="truncate block text-foreground font-medium" title={row.path}>{row.path}</span>
                      </td>
                      <td className="px-4 py-2.5 max-w-[140px]">
                        <span className="truncate block text-muted-foreground" title={row.referrer ?? 'Direct'}>{row.referrer || 'Direct'}</span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.browser}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{row.os}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <DeviceIcon device={row.device} />
                          {row.device}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{timeAgo(row.ts)}</td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
          {!recent.isLoading && (recent.data ?? []).length === 0 && (
            <div className="text-center py-10 text-muted-foreground text-sm">No visitors recorded yet</div>
          )}
        </div>
      </Card>
    </div>
  );
}
