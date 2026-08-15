import React, { useState } from 'react';
import { useOverview, useDailyCharts } from '@/hooks/use-admin-api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { formatNumber, formatSol } from '@/lib/utils';
import { Users, Coins, ArrowRightLeft, Activity, ToggleLeft } from 'lucide-react';

export default function Overview() {
  const { data: overview, isLoading: overviewLoading } = useOverview();
  const { data: charts, isLoading: chartsLoading } = useDailyCharts();
  
  const [activeSeries, setActiveSeries] = useState<'volumeSol' | 'users' | 'tokens' | 'trades'>('volumeSol');

  if (overviewLoading || !overview) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="grid grid-cols-5 gap-4">
          {[1,2,3,4,5].map(i => <div key={i} className="h-24 bg-card rounded-lg border border-border"></div>)}
        </div>
        <div className="h-96 bg-card rounded-lg border border-border"></div>
      </div>
    );
  }

  const KpiCard = ({ title, value, sub, icon: Icon }: any) => (
    <Card>
      <CardContent className="p-5 flex flex-col gap-1">
        <div className="flex items-center justify-between text-muted-foreground mb-2">
          <span className="text-xs font-medium uppercase tracking-wider">{title}</span>
          <Icon className="w-4 h-4 opacity-50" />
        </div>
        <div className="text-2xl font-semibold font-mono tabular text-foreground">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );

  const seriesConfig = {
    volumeSol: { color: 'hsl(142 76% 55%)', label: 'Volume (SOL)' },
    users: { color: 'hsl(214 100% 68%)', label: 'Users' },
    tokens: { color: 'hsl(280 65% 60%)', label: 'Tokens' },
    trades: { color: 'hsl(38 90% 55%)', label: 'Trades' },
  };

  const platformData = [
    { name: 'Pump.fun', value: overview.tokens.pump_fun },
    { name: 'Moonshot', value: overview.tokens.moonshot },
    { name: 'Raydium', value: overview.tokens.raydium_launchlab },
    { name: 'PumpSwap', value: overview.tokens.pumpswap },
    { name: 'LetsBonk', value: overview.tokens.letsbonk },
  ].filter(d => d.value > 0);
  
  const COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

  const authData = [
    { name: 'Google', value: overview.users.google },
    { name: 'Wallet', value: overview.users.wallet },
    { name: 'Email', value: overview.users.email },
  ].filter(d => d.value > 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <KpiCard title="Total Users" value={formatNumber(overview.users.total)} sub={`+${overview.users.last24h} in 24h`} icon={Users} />
        <KpiCard title="Total Tokens" value={formatNumber(overview.tokens.total)} sub={`+${overview.tokens.last24h} in 24h`} icon={Coins} />
        <KpiCard title="Total Trades" value={formatNumber(overview.trades.total)} sub={`+${overview.trades.last24h} in 24h`} icon={ArrowRightLeft} />
        <KpiCard title="24h Vol" value={`${formatSol(overview.trades.volume24hSol)} SOL`} sub={`Total: ${formatSol(overview.trades.volumeSol)} SOL`} icon={Activity} />
        <KpiCard title="SOL Price" value={overview.solPrice ? `$${overview.solPrice.toFixed(2)}` : '---'} sub="Current oracle" icon={ToggleLeft} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-3">
          <Card className="h-full flex flex-col">
            <CardHeader className="flex flex-row items-center justify-between pb-2 border-b border-border">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">30-Day Trend</CardTitle>
              <div className="flex gap-2">
                {(Object.keys(seriesConfig) as Array<keyof typeof seriesConfig>).map(key => (
                  <button
                    key={key}
                    onClick={() => setActiveSeries(key)}
                    className={`text-xs px-2 py-1 rounded-sm font-mono tabular border ${activeSeries === key ? 'bg-primary/10 border-primary/30 text-primary' : 'border-transparent text-muted-foreground hover:bg-muted'}`}
                  >
                    {seriesConfig[key].label}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="flex-1 p-0 min-h-[300px]">
              {!chartsLoading && charts && (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={charts} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={seriesConfig[activeSeries].color} stopOpacity={0.3}/>
                        <stop offset="95%" stopColor={seriesConfig[activeSeries].color} stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="date" tick={{fontSize: 10, fill: 'hsl(var(--muted-foreground))'}} tickFormatter={(v) => v.substring(5)} axisLine={false} tickLine={false} />
                    <YAxis tick={{fontSize: 10, fill: 'hsl(var(--muted-foreground))'}} tickFormatter={(v) => activeSeries === 'volumeSol' ? formatSol(v) : formatNumber(v)} axisLine={false} tickLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', fontSize: '12px', borderRadius: '4px' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                      labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                      formatter={(val: number) => [activeSeries === 'volumeSol' ? formatSol(val) : formatNumber(val), seriesConfig[activeSeries].label]}
                    />
                    <Area type="monotone" dataKey={activeSeries} stroke={seriesConfig[activeSeries].color} fillOpacity={1} fill="url(#colorValue)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>
        
        <div className="flex flex-col gap-4">
          <Card className="flex-1 flex flex-col">
            <CardHeader className="pb-0 border-b border-border">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Tokens by Platform</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex items-center justify-center p-4">
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={platformData} innerRadius={40} outerRadius={60} paddingAngle={2} dataKey="value">
                    {platformData.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', fontSize: '10px' }} itemStyle={{ color: 'hsl(var(--foreground))' }} labelStyle={{ display: 'none' }} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
            <div className="px-4 pb-4 flex flex-col gap-1">
              {platformData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[i] }}/> {d.name}</div>
                  <div className="font-mono text-foreground">{formatNumber(d.value)}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="flex-1 flex flex-col">
            <CardHeader className="pb-0 border-b border-border">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Users by Auth</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex items-center justify-center p-4">
              <ResponsiveContainer width="100%" height={120}>
                <PieChart>
                  <Pie data={authData} innerRadius={40} outerRadius={60} paddingAngle={2} dataKey="value">
                    {authData.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[(index+2) % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--popover))', borderColor: 'hsl(var(--border))', fontSize: '10px' }} itemStyle={{ color: 'hsl(var(--foreground))' }} labelStyle={{ display: 'none' }} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
            <div className="px-4 pb-4 flex flex-col gap-1">
              {authData.map((d, i) => (
                <div key={d.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[(i+2)%COLORS.length] }}/> {d.name}</div>
                  <div className="font-mono text-foreground">{formatNumber(d.value)}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
