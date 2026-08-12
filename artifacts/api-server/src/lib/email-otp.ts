import { randomInt } from "crypto";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const store = new Map<string, { code: string; expiresAt: number }>();

export function generateOTP(email: string): string {
  const code = String(randomInt(100_000, 999_999));
  store.set(email.toLowerCase(), { code, expiresAt: Date.now() + OTP_TTL_MS });
  return code;
}

export function verifyOTP(email: string, code: string): boolean {
  const entry = store.get(email.toLowerCase());
  if (!entry || entry.expiresAt < Date.now()) return false;
  if (entry.code !== code.trim()) return false;
  store.delete(email.toLowerCase()); // single-use
  return true;
}

export async function sendOTPEmail(to: string, code: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev mode: log to console so the flow can be tested without Resend
    console.log(`[email-otp] ⚡ OTP for ${to}: ${code}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Pumpi <auth@pumpi.app>",
      to,
      subject: `${code} is your Pumpi sign-in code`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0c1220;color:#fff;border-radius:16px;">
          <img src="https://pumpi.app/pumpi-logo.png" alt="Pumpi" style="height:28px;margin-bottom:24px;" />
          <h2 style="margin:0 0 8px;font-size:20px;">Your sign-in code</h2>
          <p style="color:#999;margin:0 0 24px;font-size:14px;">Enter this code in Pumpi to continue. It expires in 10 minutes.</p>
          <div style="font-size:40px;font-weight:700;letter-spacing:12px;text-align:center;padding:24px;background:#1a2535;border-radius:12px;color:#fff;">
            ${code}
          </div>
          <p style="color:#666;font-size:12px;margin-top:24px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend error ${res.status}: ${text}`);
  }
}
