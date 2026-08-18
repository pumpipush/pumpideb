/**
 * SignInScreen — email OTP + Google sign-in for Pumpi Mobile.
 *
 * Flow:
 *  1. User enters email → "Send code" → OTP arrives in email
 *  2. User enters 6-digit code → verified → JWT stored → navigates home
 *
 * Google sign-in uses expo-auth-session with the implicit (token) response type
 * so the resulting access_token can be passed directly to POST /api/auth/google.
 * Requires the Expo redirect URI to be added to the Google Cloud Console
 * Authorized redirect URIs (see follow-up task).
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { ResponseType } from 'expo-auth-session';
import { useRouter } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import colors from '@/constants/colors';

// Required for expo-auth-session to work correctly with web browser dismissal
WebBrowser.maybeCompleteAuthSession();

const C = colors.light;
const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;

// Google OAuth discovery document endpoint
const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

// ── Google Sign-In Button ──────────────────────────────────────────────────

function GoogleButton({
  onAccessToken,
  disabled,
}: {
  onAccessToken: (token: string) => void;
  disabled: boolean;
}) {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'mobile' });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID ?? '',
      responseType: ResponseType.Token,
      scopes: ['openid', 'profile', 'email'],
      redirectUri,
    },
    GOOGLE_DISCOVERY,
  );

  useEffect(() => {
    if (response?.type === 'success' && response.params?.access_token) {
      onAccessToken(response.params.access_token);
    }
  }, [response]);

  return (
    <TouchableOpacity
      style={[styles.googleBtn, disabled && styles.btnDisabled]}
      onPress={() => promptAsync()}
      disabled={disabled || !request}
      activeOpacity={0.8}
    >
      {/* Google "G" SVG rendered as colored squares — no native SVG needed */}
      <View style={styles.googleIcon}>
        <View style={[styles.googleSquare, { backgroundColor: '#4285F4', top: 0, left: 0 }]} />
        <View style={[styles.googleSquare, { backgroundColor: '#34A853', top: 0, right: 0 }]} />
        <View style={[styles.googleSquare, { backgroundColor: '#FBBC05', bottom: 0, left: 0 }]} />
        <View style={[styles.googleSquare, { backgroundColor: '#EA4335', bottom: 0, right: 0 }]} />
      </View>
      <Text style={styles.googleBtnText}>Continue with Google</Text>
    </TouchableOpacity>
  );
}

// ── Main Screen ────────────────────────────────────────────────────────────

type EmailView = 'input' | 'otp';

export default function SignInScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { sendEmailOTP, verifyEmailOTP, signInWithGoogle } = useAuth();

  const [emailView, setEmailView] = useState<EmailView>('input');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Email OTP handlers ─────────────────────────────────────────────────

  const handleSendCode = async () => {
    const trimmed = email.trim();
    if (!trimmed || loading) return;
    setLoading('email');
    setError(null);
    try {
      await sendEmailOTP(trimmed);
      setEmailView('otp');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send code');
    } finally {
      setLoading(null);
    }
  };

  const handleVerify = async () => {
    if (otp.length < 6 || loading) return;
    setLoading('otp');
    setError(null);
    try {
      await verifyEmailOTP(email.trim(), otp.trim());
      // AuthContext updated → _layout.tsx will redirect to (tabs)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid or expired code');
    } finally {
      setLoading(null);
    }
  };

  // ── Google handler ─────────────────────────────────────────────────────

  const handleGoogleToken = async (accessToken: string) => {
    setLoading('google');
    setError(null);
    try {
      await signInWithGoogle(accessToken);
      // Routing handled by _layout.tsx when user state updates
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in failed');
    } finally {
      setLoading(null);
    }
  };

  // ── UI ─────────────────────────────────────────────────────────────────

  const isLoading = loading !== null;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo */}
        <View style={styles.logoWrap}>
          <Image
            source={require('../assets/images/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
        </View>

        {/* Header */}
        <Text style={styles.heading}>Welcome to Pumpi</Text>
        <Text style={styles.subheading}>Sign in to start trading</Text>

        {/* Card */}
        <View style={styles.card}>

          {/* Google */}
          {GOOGLE_CLIENT_ID ? (
            <GoogleButton
              onAccessToken={handleGoogleToken}
              disabled={isLoading}
            />
          ) : null}

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>or sign in with email</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Email step */}
          {emailView === 'input' && (
            <View style={styles.row}>
              <View style={styles.inputWrap}>
                <Feather name="mail" size={16} color={C.mutedForeground} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Email address"
                  placeholderTextColor={C.mutedForeground}
                  value={email}
                  onChangeText={setEmail}
                  onSubmitEditing={handleSendCode}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoading}
                  returnKeyType="send"
                />
              </View>
              <TouchableOpacity
                style={[styles.actionBtn, (!email.trim() || isLoading) && styles.btnDisabled]}
                onPress={handleSendCode}
                disabled={!email.trim() || isLoading}
                activeOpacity={0.8}
              >
                {loading === 'email' ? (
                  <ActivityIndicator size="small" color={C.foreground} />
                ) : (
                  <Text style={styles.actionBtnText}>Send code</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* OTP step */}
          {emailView === 'otp' && (
            <View style={styles.otpWrap}>
              <View style={styles.otpHeader}>
                <TouchableOpacity
                  onPress={() => { setEmailView('input'); setOtp(''); setError(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Feather name="arrow-left" size={16} color={C.mutedForeground} />
                </TouchableOpacity>
                <Text style={styles.otpHint}>
                  Code sent to{' '}
                  <Text style={styles.otpEmail}>{email}</Text>
                </Text>
              </View>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.otpInput, { flex: 1 }]}
                  placeholder="6-digit code"
                  placeholderTextColor={C.mutedForeground}
                  value={otp}
                  onChangeText={(t) => setOtp(t.replace(/\D/g, '').slice(0, 6))}
                  onSubmitEditing={handleVerify}
                  keyboardType="number-pad"
                  editable={!isLoading}
                  returnKeyType="done"
                  maxLength={6}
                />
                <TouchableOpacity
                  style={[styles.verifyBtn, (otp.length < 6 || isLoading) && styles.btnDisabled]}
                  onPress={handleVerify}
                  disabled={otp.length < 6 || isLoading}
                  activeOpacity={0.8}
                >
                  {loading === 'otp' ? (
                    <ActivityIndicator size="small" color="#000" />
                  ) : (
                    <Text style={styles.verifyBtnText}>Verify</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Error */}
          {error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : null}
        </View>

        {/* Terms */}
        <Text style={styles.terms}>
          By continuing you agree to our{' '}
          <Text style={styles.termsLink}>Terms of Service</Text>
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.background,
  },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  logoWrap: {
    width: 72,
    height: 72,
    borderRadius: 20,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    overflow: 'hidden',
  },
  logo: {
    width: 56,
    height: 56,
  },
  heading: {
    fontSize: 26,
    fontWeight: '700' as const,
    color: C.foreground,
    marginBottom: 6,
    textAlign: 'center',
  },
  subheading: {
    fontSize: 14,
    color: C.mutedForeground,
    marginBottom: 32,
    textAlign: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: C.card,
    borderRadius: C.radius,
    borderWidth: 1,
    borderColor: C.border,
    padding: 20,
    gap: 14,
  },
  googleBtn: {
    height: 48,
    borderRadius: C.radius - 2,
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  googleIcon: {
    width: 18,
    height: 18,
    position: 'relative',
  },
  googleSquare: {
    width: 8,
    height: 8,
    position: 'absolute',
    borderRadius: 1,
  },
  googleBtnText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: '#1a1a1a',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: C.border,
  },
  dividerText: {
    fontSize: 11,
    color: C.mutedForeground,
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  inputWrap: {
    flex: 1,
    height: 46,
    borderRadius: C.radius - 2,
    backgroundColor: C.secondary,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIcon: {
    marginLeft: 12,
    marginRight: 8,
  },
  input: {
    flex: 1,
    height: 46,
    fontSize: 14,
    color: C.foreground,
    paddingHorizontal: 12,
    borderRadius: C.radius - 2,
    backgroundColor: C.secondary,
    borderWidth: 1,
    borderColor: C.border,
  },
  otpInput: {
    fontSize: 20,
    letterSpacing: 6,
    fontWeight: '600' as const,
    textAlign: 'center',
  },
  actionBtn: {
    height: 46,
    paddingHorizontal: 16,
    borderRadius: C.radius - 2,
    backgroundColor: C.secondary,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: C.foreground,
  },
  verifyBtn: {
    height: 46,
    paddingHorizontal: 18,
    borderRadius: C.radius - 2,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyBtnText: {
    fontSize: 13,
    fontWeight: '700' as const,
    color: C.primaryForeground,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  otpWrap: {
    gap: 10,
  },
  otpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  otpHint: {
    fontSize: 12,
    color: C.mutedForeground,
  },
  otpEmail: {
    color: 'rgba(255,255,255,0.7)',
  },
  errorText: {
    fontSize: 12,
    color: '#ef4444',
    textAlign: 'center',
  },
  terms: {
    fontSize: 11,
    color: C.mutedForeground,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 16,
  },
  termsLink: {
    color: 'rgba(255,255,255,0.6)',
    textDecorationLine: 'underline',
  },
});
