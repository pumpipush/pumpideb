/**
 * Follow/follower API client — hand-written (not orval-generated).
 * Follows the same pattern as the generated api.ts.
 */
import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import type {
  MutationFunction,
  QueryFunction,
  QueryKey,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
} from "@tanstack/react-query";

import type {
  FollowListResponse,
  FollowStatusResponse,
} from "./api.schemas";
import { customFetch } from "../custom-fetch";
import type { ErrorType } from "../custom-fetch";

// ── follow status ────────────────────────────────────────────────────────────

export const getFollowStatusUrl = (address: string, viewer: string) =>
  `/api/profiles/${address}/follow-status?viewer=${encodeURIComponent(viewer)}`;

export const getFollowStatus = async (
  address: string,
  viewer: string,
  options?: Parameters<typeof customFetch>[1],
  signal?: AbortSignal,
): Promise<FollowStatusResponse> =>
  customFetch<FollowStatusResponse>(getFollowStatusUrl(address, viewer), { ...options, method: "GET", signal });

export const getGetFollowStatusQueryKey = (address: string, viewer: string) =>
  [`/api/profiles/${address}/follow-status`, viewer] as const;

export const useGetFollowStatus = <
  TData = Awaited<ReturnType<typeof getFollowStatus>>,
  TError = ErrorType<unknown>,
>(
  address: string,
  viewer: string,
  options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getFollowStatus>>, TError, TData>;
    request?: Parameters<typeof customFetch>[1];
  },
): UseQueryResult<TData, TError> & { queryKey: QueryKey } => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getGetFollowStatusQueryKey(address, viewer);
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getFollowStatus>>> = ({ signal }) =>
    getFollowStatus(address, viewer, requestOptions, signal);
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: !!address && !!viewer,
    ...queryOptions,
  }) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  query.queryKey = queryKey;
  return query;
};

// ── auth type ────────────────────────────────────────────────────────────────

/**
 * Discriminated union for follow/unfollow auth.
 *   bearer — social/email users: pass the JWT as a Bearer token header
 *   wallet — wallet-only users: pass a server-issued signed nonce in the body
 */
export type FollowAuth =
  | { type: "bearer"; token: string }
  | { type: "wallet"; walletAddress: string; signature: string; message: string };

// ── follow ───────────────────────────────────────────────────────────────────

export const followProfile = async (
  address: string,
  auth: FollowAuth,
  options?: Parameters<typeof customFetch>[1],
): Promise<{ isFollowing: boolean; followersCount: number }> => {
  if (auth.type === "bearer") {
    return customFetch(`/api/profiles/${address}/follow`, {
      ...options,
      method: "POST",
      headers: { ...(options?.headers as Record<string, string>), Authorization: `Bearer ${auth.token}` },
    });
  }
  // Wallet — signature auth fields go in the POST body
  return customFetch(`/api/profiles/${address}/follow`, {
    ...options,
    method: "POST",
    body: JSON.stringify({ walletAddress: auth.walletAddress, signature: auth.signature, message: auth.message }),
  });
};

export const unfollowProfile = async (
  address: string,
  auth: FollowAuth,
  options?: Parameters<typeof customFetch>[1],
): Promise<{ isFollowing: boolean; followersCount: number }> => {
  if (auth.type === "bearer") {
    return customFetch(`/api/profiles/${address}/follow`, {
      ...options,
      method: "DELETE",
      headers: { ...(options?.headers as Record<string, string>), Authorization: `Bearer ${auth.token}` },
    });
  }
  // Wallet — signature auth fields go in the DELETE body
  return customFetch(`/api/profiles/${address}/follow`, {
    ...options,
    method: "DELETE",
    body: JSON.stringify({ walletAddress: auth.walletAddress, signature: auth.signature, message: auth.message }),
  });
};

// ── followers list ───────────────────────────────────────────────────────────

export type GetFollowListParams = {
  viewer?: string;
  limit?: number;
  offset?: number;
};

export const getFollowersUrl = (address: string, params: GetFollowListParams = {}) => {
  const qs = new URLSearchParams();
  if (params.viewer) qs.set("viewer", params.viewer);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const s = qs.toString();
  return `/api/profiles/${address}/followers${s ? `?${s}` : ""}`;
};

export const getFollowingUrl = (address: string, params: GetFollowListParams = {}) => {
  const qs = new URLSearchParams();
  if (params.viewer) qs.set("viewer", params.viewer);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const s = qs.toString();
  return `/api/profiles/${address}/following${s ? `?${s}` : ""}`;
};

export const getFollowers = async (
  address: string,
  params: GetFollowListParams = {},
  options?: Parameters<typeof customFetch>[1],
  signal?: AbortSignal,
): Promise<FollowListResponse> =>
  customFetch<FollowListResponse>(getFollowersUrl(address, params), { ...options, method: "GET", signal });

export const getFollowing = async (
  address: string,
  params: GetFollowListParams = {},
  options?: Parameters<typeof customFetch>[1],
  signal?: AbortSignal,
): Promise<FollowListResponse> =>
  customFetch<FollowListResponse>(getFollowingUrl(address, params), { ...options, method: "GET", signal });

export const getGetFollowersQueryKey = (address: string, params?: GetFollowListParams) =>
  [`/api/profiles/${address}/followers`, params] as const;

export const getGetFollowingQueryKey = (address: string, params?: GetFollowListParams) =>
  [`/api/profiles/${address}/following`, params] as const;

export const useGetFollowers = <
  TData = Awaited<ReturnType<typeof getFollowers>>,
  TError = ErrorType<unknown>,
>(
  address: string,
  params?: GetFollowListParams,
  options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getFollowers>>, TError, TData>;
    request?: Parameters<typeof customFetch>[1];
  },
): UseQueryResult<TData, TError> & { queryKey: QueryKey } => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getGetFollowersQueryKey(address, params);
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getFollowers>>> = ({ signal }) =>
    getFollowers(address, params, requestOptions, signal);
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: !!address,
    ...queryOptions,
  }) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  query.queryKey = queryKey;
  return query;
};

export const useGetFollowing = <
  TData = Awaited<ReturnType<typeof getFollowing>>,
  TError = ErrorType<unknown>,
>(
  address: string,
  params?: GetFollowListParams,
  options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getFollowing>>, TError, TData>;
    request?: Parameters<typeof customFetch>[1];
  },
): UseQueryResult<TData, TError> & { queryKey: QueryKey } => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getGetFollowingQueryKey(address, params);
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getFollowing>>> = ({ signal }) =>
    getFollowing(address, params, requestOptions, signal);
  const query = useQuery({
    queryKey,
    queryFn,
    enabled: !!address,
    ...queryOptions,
  }) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  query.queryKey = queryKey;
  return query;
};

// ── follow mutation hook ─────────────────────────────────────────────────────

export type FollowMutationVariables = {
  targetAddress: string;
  auth: FollowAuth;
  action: "follow" | "unfollow";
};

export const useFollowMutation = <TError = ErrorType<unknown>, TContext = unknown>(
  options?: { mutation?: UseMutationOptions<{ isFollowing: boolean; followersCount: number }, TError, FollowMutationVariables, TContext> },
): UseMutationResult<{ isFollowing: boolean; followersCount: number }, TError, FollowMutationVariables, TContext> => {
  const mutationFn: MutationFunction<{ isFollowing: boolean; followersCount: number }, FollowMutationVariables> =
    ({ targetAddress, auth, action }) =>
      action === "follow"
        ? followProfile(targetAddress, auth)
        : unfollowProfile(targetAddress, auth);
  return useMutation({ mutationFn, ...options?.mutation });
};
