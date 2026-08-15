import React, { useState } from 'react';
import { useFees } from '@/hooks/use-admin-api';
import { useAdmin } from '@/contexts/AdminContext';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatAddress, formatNumber, formatSol } from '@/lib/utils';
import { Search, ChevronLeft, ChevronRight, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Fees() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [vaultBalances, setVaultBalances] = useState<Record<string, string>>({});
  const [loadingVaults, setLoadingVaults] = useState<Record<string, boolean>>({});
  
  const { data, isLoading } = useFees(page);
  const { apiFetch } = useAdmin();
  const { toast } = useToast();

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ description: 'Copied to clipboard', duration: 2000 });
  };

  const filteredRows = data?.rows.filter(row => {
    if (!search) return true;
    const s = search.toLowerCase();
    return row.creatorAddress.toLowerCase().includes(s) || (row.username && row.username.toLowerCase().includes(s));
  }) || [];

  const handleCheckVault = async (address: string) => {
    if (loadingVaults[address] || vaultBalances[address] !== undefined) return;
    
    setLoadingVaults(prev => ({ ...prev, [address]: true }));
    try {
      const res = await apiFetch<{ claimableLamports: string }>(`/admin/fees/creator/${address}`);
      const sol = Number(res.claimableLamports) / 1e9;
      setVaultBalances(prev => ({ ...prev, [address]: sol.toString() }));
    } catch (e: any) {
      toast({ variant: 'destructive', description: e.message || 'Failed to fetch vault balance' });
    } finally {
      setLoadingVaults(prev => ({ ...prev, [address]: false }));
    }
  };

  return (
    <div className="flex flex-col h-full gap-4 overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-shrink-0">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Creators</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-20" /> : (
              <div className="text-2xl font-bold tabular-nums">{formatNumber(data?.totals.creators || 0)}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Volume (SOL)</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-24" /> : (
              <div className="text-2xl font-bold tabular-nums">{formatSol(Number(data?.totals.volumeSol || 0))}</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Trades</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-24" /> : (
              <div className="text-2xl font-bold tabular-nums">{formatNumber(data?.totals.trades || 0)}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center justify-between mt-2 flex-shrink-0">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search username or address (client-side)..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-card font-mono text-sm"
            data-testid="input-search-fees"
          />
        </div>
      </div>

      <div className="border border-border rounded-lg bg-card flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-12 text-center">Rank</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Graduated</TableHead>
              <TableHead className="text-right">Volume (SOL)</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Last Token</TableHead>
              <TableHead className="text-right">Vault Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center">Loading...</TableCell></TableRow>
            ) : !filteredRows.length ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">No creators found</TableCell></TableRow>
            ) : (
              filteredRows.map((row, idx) => (
                <TableRow key={row.creatorAddress} className="py-1">
                  <TableCell className="text-center font-mono text-xs text-muted-foreground">
                    {(page - 1) * 50 + idx + 1}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {row.avatarUrl ? (
                        <img src={row.avatarUrl} alt="Avatar" className="w-6 h-6 rounded-sm bg-muted object-cover" />
                      ) : (
                        <div className="w-6 h-6 rounded-sm bg-muted flex items-center justify-center text-[10px] text-muted-foreground font-mono">?</div>
                      )}
                      <div className="flex flex-col">
                        <span className="font-bold text-xs">{row.username || '-'}</span>
                        <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                          {formatAddress(row.creatorAddress)}
                          <button onClick={() => copyToClipboard(row.creatorAddress)} className="hover:text-primary"><Copy className="w-3 h-3" /></button>
                          <a href={`https://solscan.io/account/${row.creatorAddress}`} target="_blank" rel="noreferrer" className="hover:text-primary"><ExternalLink className="w-3 h-3" /></a>
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular">
                    {formatNumber(row.tokenCount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular">
                    {formatNumber(row.graduatedTokens)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                    {formatSol(Number(row.totalVolumeSol))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                    {formatNumber(row.totalTrades)}
                  </TableCell>
                  <TableCell className="text-right text-[10px] text-muted-foreground whitespace-nowrap">
                    {new Date(row.lastTokenAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {vaultBalances[row.creatorAddress] !== undefined ? (
                      <span className="font-mono text-xs tabular text-green-500 font-bold">
                        {formatSol(Number(vaultBalances[row.creatorAddress]))} SOL
                      </span>
                    ) : (
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="h-7 text-xs" 
                        onClick={() => handleCheckVault(row.creatorAddress)}
                        disabled={loadingVaults[row.creatorAddress]}
                        data-testid={`check-vault-${row.creatorAddress}`}
                      >
                        {loadingVaults[row.creatorAddress] ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                        Check
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between mt-2 flex-shrink-0">
        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || isLoading}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Prev
        </Button>
        <span className="text-xs font-mono text-muted-foreground">Page {page}</span>
        <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || data.rows.length < 50 || isLoading}>
          Next <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}