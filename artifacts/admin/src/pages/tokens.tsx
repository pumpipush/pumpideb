import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTokens } from '@/hooks/use-admin-api';
import { useAdmin } from '@/contexts/AdminContext';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatAddress, formatNumber, formatSol } from '@/lib/utils';
import { Search, ChevronLeft, ChevronRight, Copy, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Tokens() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [platform, setPlatform] = useState('');
  const [graduated, setGraduated] = useState('');
  const [hiddenFilter, setHiddenFilter] = useState('');
  
  const { data, isLoading } = useTokens(page, search, platform, graduated, hiddenFilter);
  const { apiFetch } = useAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

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

  const handleHide = async (address: string) => {
    try {
      await apiFetch(`/admin/tokens/${address}/hide`, { method: 'POST' });
      toast({ description: 'Token hidden from public feed' });
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    } catch (e: any) {
      toast({ variant: 'destructive', description: e.message || 'Failed to hide token' });
    }
  };

  const handleUnhide = async (address: string) => {
    try {
      await apiFetch(`/admin/tokens/${address}/hide`, { method: 'DELETE' });
      toast({ description: 'Token restored to public feed' });
      queryClient.invalidateQueries({ queryKey: ['admin-tokens'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    } catch (e: any) {
      toast({ variant: 'destructive', description: e.message || 'Failed to restore token' });
    }
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <form onSubmit={handleSearch} className="flex gap-2 w-full sm:max-w-md">
          <div className="relative w-full">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search token name, symbol, address..." 
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8 bg-card font-mono text-sm"
              data-testid="input-search-tokens"
            />
          </div>
          <Button type="submit" variant="secondary">Search</Button>
        </form>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Select value={platform} onValueChange={(v) => { setPlatform(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className="w-[120px] bg-card">
              <SelectValue placeholder="Platform" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Platforms</SelectItem>
              <SelectItem value="pump_fun">Pump.fun</SelectItem>
              <SelectItem value="moonshot">Moonshot</SelectItem>
              <SelectItem value="raydium_launchlab">Raydium</SelectItem>
              <SelectItem value="pumpswap">PumpSwap</SelectItem>
              <SelectItem value="letsbonk">LetsBonk</SelectItem>
            </SelectContent>
          </Select>

          <Select value={graduated} onValueChange={(v) => { setGraduated(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className="w-[120px] bg-card">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="true">Graduated</SelectItem>
              <SelectItem value="false">Live</SelectItem>
            </SelectContent>
          </Select>

          <Select value={hiddenFilter} onValueChange={(v) => { setHiddenFilter(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className="w-[120px] bg-card">
              <SelectValue placeholder="Visibility" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="false">Visible</SelectItem>
              <SelectItem value="true">Hidden</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border border-border rounded-lg bg-card flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-12">Logo</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Platform</TableHead>
              <TableHead className="text-right">M.Cap</TableHead>
              <TableHead className="text-right">Vol (SOL)</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Holders</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={10} className="h-24 text-center">Loading...</TableCell></TableRow>
            ) : !data?.rows.length ? (
              <TableRow><TableCell colSpan={10} className="h-24 text-center text-muted-foreground">No tokens found</TableCell></TableRow>
            ) : (
              data.rows.map(token => (
                <TableRow key={token.id} className="py-1">
                  <TableCell>
                    {token.image_url ? (
                      <img src={token.image_url} alt={token.symbol} className="w-6 h-6 rounded-sm bg-muted object-cover" />
                    ) : (
                      <div className="w-6 h-6 rounded-sm bg-muted flex items-center justify-center text-[10px] text-muted-foreground font-mono">?</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs">{token.name} <span className="text-muted-foreground font-normal">${token.symbol}</span></span>
                        {token.hidden && <Badge variant="secondary" className="text-[9px] py-0 h-4">HIDDEN</Badge>}
                      </div>
                      <div className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                        {formatAddress(token.address)}
                        <button onClick={() => copyToClipboard(token.address)} className="hover:text-primary"><Copy className="w-3 h-3" /></button>
                        <a href={`https://solscan.io/token/${token.address}`} target="_blank" rel="noreferrer" className="hover:text-primary"><ExternalLink className="w-3 h-3" /></a>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">{getPlatformLabel(token.platform)}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular">
                    ${formatNumber(Number(token.market_cap_usd))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                    {formatSol(Number(token.volume_eth))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                    {formatNumber(token.trade_count)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular text-muted-foreground">
                    {formatNumber(token.holder_count)}
                  </TableCell>
                  <TableCell className="text-center">
                    {token.graduated ? <Badge variant="success">Graduated</Badge> : <Badge variant="secondary">Live</Badge>}
                  </TableCell>
                  <TableCell className="text-right text-[10px] text-muted-foreground whitespace-nowrap">
                    {new Date(token.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {token.hidden ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs border-green-500/30 text-green-500 hover:bg-green-500/10 hover:text-green-500" onClick={() => handleUnhide(token.address)} data-testid={`show-${token.address}`}>
                        <Eye className="w-3 h-3 mr-1" /> Show
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => handleHide(token.address)} data-testid={`hide-${token.address}`}>
                        <EyeOff className="w-3 h-3 mr-1" /> Hide
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
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
