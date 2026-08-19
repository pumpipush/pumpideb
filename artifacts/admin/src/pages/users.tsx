import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUsers, useOverview } from '@/hooks/use-admin-api';
import { useAdmin } from '@/contexts/AdminContext';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatAddress, formatNumber } from '@/lib/utils';
import { Search, ChevronLeft, ChevronRight, Copy, ExternalLink } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Users() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [banDialogUser, setBanDialogUser] = useState<string | null>(null);
  const [banReason, setBanReason] = useState('');
  
  const { data, isLoading, isError } = useUsers(page, search);
  const { data: overviewData } = useOverview();
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

  const getAuthBadge = (type: string) => {
    if (type === 'google') return <Badge variant="blue">Google</Badge>;
    if (type === 'wallet') return <Badge variant="purple">Wallet</Badge>;
    if (type === 'email') return <Badge variant="amber">Email</Badge>;
    return <Badge variant="outline">{type}</Badge>;
  };

  const handleBan = async () => {
    if (!banDialogUser) return;
    try {
      await apiFetch(`/admin/users/${banDialogUser}/ban`, {
        method: 'POST',
        body: JSON.stringify({ reason: banReason })
      });
      toast({ description: 'User banned' });
      setBanDialogUser(null);
      setBanReason('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    } catch (e: any) {
      toast({ variant: 'destructive', description: e.message || 'Failed to ban user' });
    }
  };

  const handleUnban = async (address: string) => {
    try {
      await apiFetch(`/admin/users/${address}/ban`, {
        method: 'DELETE'
      });
      toast({ description: 'User unbanned' });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
    } catch (e: any) {
      toast({ variant: 'destructive', description: e.message || 'Failed to unban user' });
    }
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <form onSubmit={handleSearch} className="flex gap-2 w-full max-w-md items-center">
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
          {overviewData?.users && (
            <Badge variant="destructive" className="ml-2 whitespace-nowrap">
              {formatNumber(overviewData.users.banned)} Banned
            </Badge>
          )}
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
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center">Loading...</TableCell></TableRow>
            ) : isError ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-destructive">Failed to load users</TableCell></TableRow>
            ) : !data?.rows.length ? (
              <TableRow><TableCell colSpan={8} className="h-24 text-center text-muted-foreground">No users found</TableCell></TableRow>
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
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 font-mono text-xs">
                        {formatAddress(user.address)}
                        <button onClick={() => copyToClipboard(user.address)} className="text-muted-foreground hover:text-primary"><Copy className="w-3 h-3" /></button>
                        <a href={`https://solscan.io/account/${user.address}`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary"><ExternalLink className="w-3 h-3" /></a>
                      </div>
                      {user.bannedAt && (
                        <div><Badge variant="destructive" className="text-[9px] py-0">BANNED</Badge></div>
                      )}
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
                  <TableCell className="text-right">
                    {user.bannedAt ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs border-green-500/30 text-green-500 hover:bg-green-500/10 hover:text-green-500" onClick={() => handleUnban(user.address)} data-testid={`unban-${user.address}`}>
                        Unban
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="h-7 text-xs border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setBanDialogUser(user.address)} data-testid={`ban-${user.address}`}>
                        Ban
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
        <span className="text-xs font-mono text-muted-foreground">Page {page}</span>
        <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || data.rows.length < 50 || isLoading}>
          Next <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>

      <Dialog open={!!banDialogUser} onOpenChange={(open) => !open && setBanDialogUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ban User</DialogTitle>
            <DialogDescription>
              Are you sure you want to ban {banDialogUser ? formatAddress(banDialogUser) : 'this user'}? 
              They will not be able to interact with the platform.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              placeholder="Reason for ban (optional)"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              className="resize-none"
              data-testid="textarea-ban-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanDialogUser(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleBan} data-testid="btn-confirm-ban">Ban User</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
