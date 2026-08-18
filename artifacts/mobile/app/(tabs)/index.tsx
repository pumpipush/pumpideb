/**
 * HomeScreen — shown after sign-in.
 * Displays user profile summary and a sign-out button.
 * Serves as the base for future trading features.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import colors from '@/constants/colors';

const C = colors.light;

function Avatar({ user }: { user: { username: string; avatarUrl?: string | null } }) {
  if (user.avatarUrl) {
    return <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />;
  }
  const initials = user.username.slice(0, 2).toUpperCase();
  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarInitials}>{initials}</Text>
    </View>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.featureCard}>
      <View style={styles.featureIconWrap}>
        <Feather name={icon as keyof typeof Feather.glyphMap} size={20} color={C.primary} />
      </View>
      <View style={styles.featureText}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureDesc}>{description}</Text>
      </View>
      <View style={styles.comingBadge}>
        <Text style={styles.comingBadgeText}>Soon</Text>
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();

  const handleSignOut = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await signOut();
  };

  if (!user) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={C.primary} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 0),
          paddingBottom: insets.bottom + (Platform.OS === 'web' ? 34 : 0),
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.welcomeLabel}>Welcome back</Text>
          <Text style={styles.welcomeUsername}>@{user.username}</Text>
        </View>
        <TouchableOpacity
          onPress={handleSignOut}
          style={styles.signOutBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="log-out" size={18} color={C.mutedForeground} />
        </TouchableOpacity>
      </View>

      {/* Profile card */}
      <View style={styles.profileCard}>
        <Avatar user={user} />
        <View style={styles.profileInfo}>
          <Text style={styles.profileUsername}>{user.username}</Text>
          {user.email ? (
            <Text style={styles.profileEmail}>{user.email}</Text>
          ) : null}
          <View style={styles.authBadge}>
            <Feather
              name={user.authType === 'google' ? 'globe' : 'mail'}
              size={10}
              color={C.primary}
            />
            <Text style={styles.authBadgeText}>
              {user.authType === 'google' ? 'Google' : 'Email'} account
            </Text>
          </View>
        </View>
      </View>

      {/* Coming soon features */}
      <Text style={styles.sectionLabel}>Coming soon</Text>
      <View style={styles.featuresWrap}>
        <FeatureCard
          icon="trending-up"
          title="Token Feed"
          description="Live pump.fun & LaunchLab launches"
        />
        <FeatureCard
          icon="bar-chart-2"
          title="Trade"
          description="Buy & sell tokens from your phone"
        />
        <FeatureCard
          icon="award"
          title="Leaderboard"
          description="Top traders ranked by PnL"
        />
        <FeatureCard
          icon="bell"
          title="Alerts"
          description="Price & graduation notifications"
        />
      </View>
    </View>
  );
}

import { Platform } from 'react-native';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.background,
    paddingHorizontal: 20,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 20,
  },
  welcomeLabel: {
    fontSize: 13,
    color: C.mutedForeground,
    marginBottom: 2,
  },
  welcomeUsername: {
    fontSize: 22,
    fontWeight: '700' as const,
    color: C.foreground,
  },
  signOutBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: C.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    marginBottom: 28,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 16,
  },
  avatarFallback: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 20,
    fontWeight: '700' as const,
    color: C.primary,
  },
  profileInfo: {
    flex: 1,
    gap: 3,
  },
  profileUsername: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: C.foreground,
  },
  profileEmail: {
    fontSize: 13,
    color: C.mutedForeground,
  },
  authBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  authBadgeText: {
    fontSize: 11,
    color: C.primary,
    fontWeight: '600' as const,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600' as const,
    color: C.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  featuresWrap: {
    gap: 10,
  },
  featureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.card,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
  },
  featureIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText: {
    flex: 1,
    gap: 2,
  },
  featureTitle: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: C.foreground,
  },
  featureDesc: {
    fontSize: 12,
    color: C.mutedForeground,
  },
  comingBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: C.secondary,
    borderWidth: 1,
    borderColor: C.border,
  },
  comingBadgeText: {
    fontSize: 10,
    fontWeight: '600' as const,
    color: C.mutedForeground,
  },
});
