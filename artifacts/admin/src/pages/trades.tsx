import React, { useState, useEffect } from 'react';
import { useTrades } from '@/hooks/use-admin-api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatAddress, formatNumber, formatSol } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Copy, ExternalLink, Activity } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Trades() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isFetching, isError } = useTrades(page);
  const { toast } = useToast();
  
  // Highlight new trades briefly
  const [prevDataId, setPrevDataId] = useState<string | null>(null);
  useEffect(() => {
    if (data?.rows[0] && prevDataId !== data.rows[0].id && page === 1) {
      setPrevDataId(data.rows[0].id);
    }
  }, [data, page, prevDataId]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: 'Copied to clipboard', duration: 2000 });
  };

  const getPlatformLabel = (p: string) => {
    const map: Record<string, string> = {
      pump_fun: 'Pump.fun',
      pumpswap: 'PumpSwap',
      raydium_launchlab: 'Raydium',
      moonshot: 'Moonshot',
      letsbonk: 'LetsBonk'
    };
    return map[p] || p;
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
          Live Feed
          {isFetching && <Activity className="w-3 h-3 text-primary animate-pulse" />}
        </h2>
        {data && (
          <div className="text-sm text-muted-foreground font-mono">
            Auto-refreshing 10s
          </div>
        )}
      </div>

      <div className="border border-border rounded-lg bg-card flex-1 overflow-auto shadow-inner shadow-black/20">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
            <TableRow>
              <TableHead className="w-[100px]">Time</TableHead>
              <TableHead>Token</TableHead>
              <TableHead className="text-center w-[80px]">Side</TableHead>
              <TableHead className="text-right">Amount (SOL)</TableHead>
              <TableHead className="text-center">Platform</TableHead>
              <TableHead>Trader</TableHead>
              <TableHead className="text-right">Tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center">Loading...</TableCell></TableRow>
            ) : isError ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center text-destructive">Failed to load trades</TableCell></TableRow>
            ) : !data?.rows.length ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No trades found</TableCell></TableRow>
            ) : (
              data.rows.map(trade => {
                const isBuy = trade.isBuy;
                return (
                  <TableRow 
                    key={trade.id} 
                    className={`py-0.5 border-l-2 ${isBuy ? 'border-l-[var(--buy-color)]' : 'border-l-[var(--sell-color)]'}`}
                  >
                    <TableCell className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                      {new Date(trade.timestamp).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="font-bold text-xs">{trade.tokenSymbol}</span>
                        <a href={`https://solscan.io/token/${trade.tokenAddress}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary"><ExternalLink className="w-3 h-3" /></a>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${isBuy ? 'bg-[var(--buy-color)]/20 text-[var(--buy-color)]' : 'bg-[var(--sell-color)]/20 text-[var(--sell-color)]'}`}>
                        {isBuy ? 'Buy' : 'Sell'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular text-foreground">
                      {formatSol(parseFloat(trade.ethAmount ?? "0"))}
                    </TableCell>
                    <TableCell className="text-center">
                      <span className="text-[10px] text-muted-foreground">{getPlatformLabel(trade.platform)}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                        {formatAddress(trade.traderAddress)}
                        <button onClick={() => copyToClipboard(trade.traderAddress)} className="hover:text-primary"><Copy className="w-3 h-3" /></button>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                       <a href={`https://solscan.io/tx/${trade.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary">
                        {formatAddress(trade.txHash)} <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-auto pt-2">
        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || isLoading}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
        </Button>
        <span className="text-xs font-mono text-muted-foreground">
          Page {page} {data ? `(${formatNumber(data.total)} total)` : ''}
        </span>
        <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || data.rows.length < 50 || isLoading}>
          Next <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
