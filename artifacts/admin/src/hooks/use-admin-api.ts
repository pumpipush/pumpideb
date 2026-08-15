import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAdmin } from '@/contexts/AdminContext';

export interface OverviewData {
  users: { total: number; banned: number; google: number; wallet: number; email: number; linked: number; last24h: number; last7d: number };
  tokens: { total: number; hidden: number; graduated: number; pump_fun: number; pumpswap: number; raydium_launchlab: number; moonshot: number; letsbonk: number; last24h: number; last7d: number };
  trades: { total: number; buys: number; sells: number; last24h: number; volumeSol: number; volume24hSol: number };
  solPrice: number | null;
}

export interface DailyChartData {
  date: string;
  users: number;
  tokens: number;
  trades: number;
  volumeSol: number;
}

export interface UserRow {
  address: string;
  username: string | null;
  email: string | null;
  authType: string;
  linkedWallet: boolean;
  createdAt: string;
  avatarUrl: string | null;
  bannedAt: string | null;
  banReason: string | null;
}

export interface TokenRow {
  id: string;
  address: string;
  name: string;
  symbol: string;
  platform: string;
  graduated: boolean;
  hidden: boolean;
  market_cap_usd: string;
  price_usd: string;
  volume_eth: string;
  trade_count: number;
  holder_count: number;
  creator_address: string;
  created_at: string;
  image_url: string;
}

export interface TradeRow {
  id: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  traderAddress: string;
  isBuy: boolean;
  ethAmount: string;
  platform: string;
  txHash: string;
  timestamp: string;
}

export interface DexMarketCapStatsRow {
  platform: string;
  total: number;
  has_mc_usd: number;
  correct_mc_eth: number;
  bad_mc_eth: number;
  avg_implied_sol_price: number | null;
}

export function useOverview() {
  const { apiFetch, secret } = useAdmin();
  return useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => apiFetch<OverviewData>('/admin/overview'),
    enabled: !!secret,
  });
}

export function useDailyCharts() {
  const { apiFetch, secret } = useAdmin();
  return useQuery({
    queryKey: ['admin-charts-daily'],
    queryFn: () => apiFetch<DailyChartData[]>('/admin/charts/daily'),
    enabled: !!secret,
  });
}

export function useUsers(page: number, search: string) {
  const { apiFetch, secret } = useAdmin();
  const limit = 50;
  const offset = (page - 1) * limit;
  return useQuery({
    queryKey: ['admin-users', page, search],
    queryFn: () => apiFetch<{ total: number; rows: UserRow[] }>(`/admin/users?limit=${limit}&offset=${offset}&search=${encodeURIComponent(search)}`),
    enabled: !!secret,
  });
}

export function useTokens(page: number, search: string, platform: string, graduated: string, hidden: string = '') {
  const { apiFetch, secret } = useAdmin();
  const limit = 50;
  const offset = (page - 1) * limit;
  return useQuery({
    queryKey: ['admin-tokens', page, search, platform, graduated, hidden],
    queryFn: () => apiFetch<{ total: number; rows: TokenRow[] }>(`/admin/tokens?limit=${limit}&offset=${offset}&search=${encodeURIComponent(search)}&platform=${platform}&graduated=${graduated}&hidden=${hidden}`),
    enabled: !!secret,
  });
}

export function useTrades(page: number) {
  const { apiFetch, secret } = useAdmin();
  const limit = 50;
  const offset = (page - 1) * limit;
  return useQuery({
    queryKey: ['admin-trades', page],
    queryFn: () => apiFetch<{ total: number; rows: TradeRow[] }>(`/admin/trades?limit=${limit}&offset=${offset}`),
    enabled: !!secret,
    refetchInterval: 10000,
  });
}

export interface FeeLeaderboardRow {
  creatorAddress: string;
  username: string | null;
  avatarUrl: string | null;
  tokenCount: number;
  totalVolumeSol: string;
  totalTrades: number;
  graduatedTokens: number;
  lastTokenAt: string;
}

export interface FeeLeaderboardData {
  totals: { creators: number; volumeSol: string; trades: number };
  rows: FeeLeaderboardRow[];
}

export function useFees(page: number) {
  const { apiFetch, secret } = useAdmin();
  const limit = 50;
  const offset = (page - 1) * limit;
  return useQuery({
    queryKey: ['admin-fees', page],
    queryFn: () => apiFetch<FeeLeaderboardData>(`/admin/fees?limit=${limit}&offset=${offset}`),
    enabled: !!secret,
  });
}

export function useDexMarketCapStats() {
  const { apiFetch, secret } = useAdmin();
  return useQuery({
    queryKey: ['admin-dex-stats'],
    queryFn: () => apiFetch<{ stats: DexMarketCapStatsRow[] }>('/admin/dex-market-cap-stats'),
    enabled: !!secret,
  });
}

export function useFixDexMarketCaps() {
  const { apiFetch } = useAdmin();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; rowsUpdated: number; solPriceUsed: number }>('/admin/fix-dex-market-caps', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-dex-stats'] });
    },
  });
}
