import React, { useState } from 'react';
import { useUsers } from '@/hooks/use-admin-api';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatAddress, formatNumber } from '@/lib/utils';
import { Search, ChevronLeft, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Users() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const { data, isLoading } = useUsers(page, search);
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

  const getAuthBadge = (type: string) => {
    if (type === 'google') return <Badge variant="blue">Google</Badge>;
    if (type === 'wallet') return <Badge variant="purple">Wallet</Badge>;
    if (type === 'email') return <Badge variant="amber">Email</Badge>;
    return <Badge variant="outline">{type}</Badge>;
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <form onSubmit={handleSearch} className="flex gap-2 w-full max-w-md">
          <div className="relative w-full">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search address, username, email..." 
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-8 bg-card font-mono text-sm"
              data-testid="input-search-users"
            />
          </div>
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        {data && (
          <div className="text-sm text-muted-foreground font-mono">
            {formatNumber(data.total)} records
          </div>
        )}
      </div>

      <div className="border border-border rounded-lg bg-card flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10">
            <TableRow>
              <TableHead className="w-12">Avatar</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead>Linked</TableHead>
              <TableHead className="text-right">Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center">Loading...</TableCell></TableRow>
            ) : !data?.rows.length ? (
              <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No users found</TableCell></TableRow>
            ) : (
              data.rows.map(user => (
                <TableRow key={user.address} className="py-1">
                  <TableCell>
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="Avatar" className="w-6 h-6 rounded-sm bg-muted" />
                    ) : (
                      <div className="w-6 h-6 rounded-sm bg-muted flex items-center justify-center text-[10px] text-muted-foreground font-mono">?</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      {formatAddress(user.address)}
                      <button onClick={() => copyToClipboard(user.address)} className="text-muted-foreground hover:text-primary"><Copy className="w-3 h-3" /></button>
                      <a href={`https://solscan.io/account/${user.address}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary"><ExternalLink className="w-3 h-3" /></a>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{user.username || '-'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{user.email || '-'}</TableCell>
                  <TableCell>{getAuthBadge(user.authType)}</TableCell>
                  <TableCell>
                    {user.linkedWallet && <Badge variant="success">Yes</Badge>}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(user.createdAt).toLocaleDateString()}
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
        <span className="text-xs font-mono text-muted-foreground">Page {page}</span>
        <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || data.rows.length < 50 || isLoading}>
          Next <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );
}
