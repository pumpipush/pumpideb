/**
 * FollowListModal — shows followers or following for a profile.
 *
 * Props:
 *   open          — controlled visibility
 *   onOpenChange  — close handler
 *   mode          — "followers" | "following"
 *   address       — profile address being viewed
 *   viewerAddress — optional; current user's address (for isFollowedByViewer)
 *   getFollowAuth — optional async callback that returns a FollowAuth token
 *                   (called on demand when a follow button is clicked)
 */

import { createPortal } from "react-dom";
import { useState, useCallback } from "react";
import {
  useGetFollowers,
  useGetFollowing,
  getGetFollowersQueryKey,
  getGetFollowingQueryKey,
  followProfile,
  unfollowProfile,
} from "@workspace/api-client-react";
import type { FollowListItem, FollowAuth } from "@workspace/api-client-react";
import { diceBearUrl, formatAddress } from "@/lib/utils";
import { X, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";

interface FollowListModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "followers" | "following";
  address: string;
  viewerAddress?: string;
  /** Async callback that returns auth for follow/unfollow; called on demand. */
  getFollowAuth?: () => Promise<FollowAuth | null>;
}

function FollowListItem({
  item,
  viewerAddress,
  getFollowAuth,
  onClose,
}: {
  item: FollowListItem;
  viewerAddress?: string;
  getFollowAuth?: () => Promise<FollowAuth | null>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [following, setFollowing] = useState(item.isFollowedByViewer);
  const [loading, setLoading] = useState(false);

  const isOwnProfile = viewerAddress && viewerAddress === item.address;
  const canFollow = !!getFollowAuth && !!viewerAddress && !isOwnProfile;

  const handleToggle = useCallback(async () => {
    if (!getFollowAuth || loading) return;
    setLoading(true);
    const wasFollowing = following;
    setFollowing(!wasFollowing); // optimistic
    try {
      const auth = await getFollowAuth();
      if (!auth) throw new Error("Not authenticated");
      if (wasFollowing) {
        await unfollowProfile(item.address, auth);
      } else {
        await followProfile(item.address, auth);
      }
      // Invalidate profile query so counts refresh
      void qc.invalidateQueries({ queryKey: [`/api/profiles/${item.address}`] });
    } catch {
      setFollowing(wasFollowing); // revert
    } finally {
      setLoading(false);
    }
  }, [getFollowAuth, following, item.address, loading, qc]);

  const displayUsername = item.username.startsWith("user_")
    ? formatAddress(item.address)
    : `@${item.username}`;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-white/[0.06] last:border-0">
      <Link href={`/profile/${item.username}`} onClick={onClose}>
        <img
          src={item.avatarUrl || diceBearUrl(item.address)}
          alt={item.username}
          className="w-10 h-10 rounded-full object-cover shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
          style={{ imageRendering: "pixelated" }}
        />
      </Link>
      <div className="flex-1 min-w-0">
        <Link href={`/profile/${item.username}`} onClick={onClose}>
          <p className="text-sm font-semibold truncate cursor-pointer hover:text-primary transition-colors">
            {displayUsername}
          </p>
        </Link>
        <p className="text-xs text-muted-foreground/60">
          {item.followersCount} {item.followersCount === 1 ? "follower" : "followers"}
        </p>
      </div>
      {canFollow && (
        <button
          onClick={() => void handleToggle()}
          disabled={loading}
          className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all disabled:opacity-50 ${
            following
              ? "border border-white/20 text-muted-foreground hover:border-red-500/40 hover:text-red-400"
              : "bg-primary text-primary-foreground hover:bg-primary/90"
          }`}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : following ? "Following" : "Follow"}
        </button>
      )}
    </div>
  );
}

export function FollowListModal({
  open,
  onOpenChange,
  mode,
  address,
  viewerAddress,
  getFollowAuth,
}: FollowListModalProps) {
  const [tab, setTab] = useState<"followers" | "following">(mode);

  const params = viewerAddress ? { viewer: viewerAddress, limit: 50 } : { limit: 50 };

  const { data: followersData, isLoading: followersLoading } = useGetFollowers(
    address,
    params,
    { query: { enabled: open && tab === "followers", queryKey: getGetFollowersQueryKey(address, params) } },
  );

  const { data: followingData, isLoading: followingLoading } = useGetFollowing(
    address,
    params,
    { query: { enabled: open && tab === "following", queryKey: getGetFollowingQueryKey(address, params) } },
  );

  const activeData = tab === "followers" ? followersData : followingData;
  const isLoading = tab === "followers" ? followersLoading : followingLoading;

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />

      {/* Sheet */}
      <div
        className="relative z-10 w-full max-w-md mx-auto rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: "rgba(14,14,18,0.97)",
          border: "1px solid rgba(255,255,255,0.10)",
          backdropFilter: "blur(24px)",
          maxHeight: "80vh",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-white/[0.07] shrink-0">
          <div className="flex gap-1 p-1 rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }}>
            {(["followers", "following"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  tab === t
                    ? "bg-white/10 text-foreground"
                    : "text-muted-foreground/60 hover:text-muted-foreground"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground/40" />
            </div>
          ) : !activeData || activeData.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-muted-foreground/50">
                {tab === "followers" ? "No followers yet" : "Not following anyone yet"}
              </p>
            </div>
          ) : (
            <>
              {activeData.items.map((item) => (
                <FollowListItem
                  key={item.address}
                  item={item}
                  viewerAddress={viewerAddress}
                  getFollowAuth={getFollowAuth}
                  onClose={() => onOpenChange(false)}
                />
              ))}
              {activeData.total > activeData.items.length && (
                <p className="text-center text-xs text-muted-foreground/40 py-3">
                  Showing {activeData.items.length} of {activeData.total}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
