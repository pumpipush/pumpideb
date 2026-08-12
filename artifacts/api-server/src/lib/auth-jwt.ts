import jwt from "jsonwebtoken";

const SECRET = process.env.SESSION_SECRET ?? "dev-secret-change-me";
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
