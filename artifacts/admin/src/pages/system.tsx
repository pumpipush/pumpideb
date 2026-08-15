import React from 'react';
import { useDexMarketCapStats, useFixDexMarketCaps } from '@/hooks/use-admin-api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber } from '@/lib/utils';
import { Wrench, AlertTriangle, CheckCircle2, Server } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function System() {
  const { data, isLoading } = useDexMarketCapStats();
  const fixMutation = useFixDexMarketCaps();
  const { toast } = useToast();

  const handleFixCaps = () => {
    if (window.confirm('This will trigger a recalculation of market caps for all graduated DEX tokens. Proceed?')) {
      fixMutation.mutate(undefined, {
        onSuccess: (res) => {
          toast({
            title: 'Operation Complete',
            description: `Updated ${res.rowsUpdated} records using SOL price $${res.solPriceUsed.toFixed(2)}`,
          });
        },
        onError: (err) => {
          toast({
            title: 'Operation Failed',
            description: err instanceof Error ? err.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      });
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-lg flex items-center gap-2"><Server className="w-5 h-5 text-primary" /> System Information</CardTitle>
          <CardDescription>Backend endpoints and configuration</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-2 gap-4 text-sm font-mono">
            <div>
              <span className="text-muted-foreground">API Base:</span> 
              <div className="mt-1 px-3 py-2 bg-muted rounded-md">/api</div>
            </div>
            <div>
              <span className="text-muted-foreground">Environment:</span> 
              <div className="mt-1 px-3 py-2 bg-muted rounded-md flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-primary brand-glow"></div> Production
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/20">
        <CardHeader className="border-b border-border pb-4 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2"><Wrench className="w-5 h-5 text-destructive" /> Maintenance Tasks</CardTitle>
            <CardDescription>Direct database operations</CardDescription>
          </div>
          <Button 
            variant="destructive" 
            onClick={handleFixCaps}
            disabled={fixMutation.isPending}
          >
            {fixMutation.isPending ? 'Processing...' : 'Fix DEX Market Caps'}
          </Button>
        </CardHeader>
        <CardContent className="pt-4 p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead className="text-right">Total Tokens</TableHead>
                <TableHead className="text-right">Has USD MC</TableHead>
                <TableHead className="text-right text-primary">Valid ETH MC</TableHead>
                <TableHead className="text-right text-destructive">Bad ETH MC (0)</TableHead>
                <TableHead className="text-right">Avg Implied SOL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading stats...</TableCell></TableRow>
              ) : !data?.stats.length ? (
                <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No data available</TableCell></TableRow>
              ) : (
                data.stats.map(stat => (
                  <TableRow key={stat.platform}>
                    <TableCell className="font-mono text-xs">{stat.platform}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(stat.total)}</TableCell>
                    <TableCell className="text-right tabular">{formatNumber(stat.has_mc_usd)}</TableCell>
                    <TableCell className="text-right tabular text-primary flex justify-end items-center gap-1">
                      {formatNumber(stat.correct_mc_eth)} {stat.correct_mc_eth > 0 && <CheckCircle2 className="w-3 h-3" />}
                    </TableCell>
                    <TableCell className="text-right tabular font-bold text-destructive">
                      {stat.bad_mc_eth > 0 && <AlertTriangle className="w-3 h-3 inline mr-1" />}
                      {formatNumber(stat.bad_mc_eth)}
                    </TableCell>
                    <TableCell className="text-right tabular font-mono text-xs text-muted-foreground">
                      {stat.avg_implied_sol_price ? `$${stat.avg_implied_sol_price.toFixed(2)}` : '-'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
