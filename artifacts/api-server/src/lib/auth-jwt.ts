import jwt from "jsonwebtoken";

const rawSecret = process.env.SESSION_SECRET;

// Fail fast in production rather than silently signing tokens with a publicly
// known fallback key — any attacker could forge valid JWTs.
if (!rawSecret && process.env.NODE_ENV === "production") {
  throw new Error(
    "[auth-jwt] SESSION_SECRET environment variable is required in production. " +
    "Set it to a long random string (e.g. openssl rand -hex 64)."
  );
}

const SECRET = rawSecret ?? "dev-secret-change-me";
const EXPIRES_IN = "7d";

export interface AuthPayload {
  sub: string;           // profile address (wallet address or UUID for social users)
  authType: "wallet" | "google" | "email";
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}
