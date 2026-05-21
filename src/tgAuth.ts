// -----------------------------------------------------------------------------
// Telegram Mini App initData verification.
//
// Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// The bot token is used to derive a secret key via HMAC-SHA256("WebAppData",
// botToken). The data-check-string is then verified against the `hash` field
// in initData.
// -----------------------------------------------------------------------------

import { createHmac } from "node:crypto";

export interface TgUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

export type VerifyResult =
  | { ok: true; user: TgUser; authDate: number }
  | { ok: false; reason: string };

/**
 * Verify Telegram Mini App initData and extract the user.
 *
 * @param initData  The raw `window.Telegram.WebApp.initData` string.
 * @param botToken  The bot's token (kept server-side only).
 * @param maxAgeMs  Maximum age of the auth date in ms. Default 24 h.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): VerifyResult {
  if (!initData) return { ok: false, reason: "empty initData" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed initData" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };

  // Build the data-check-string: all key=value pairs except `hash`, sorted
  // alphabetically, joined by newlines.
  const entries: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k !== "hash") entries.push(`${k}=${v}`);
  }
  entries.sort();
  const dataCheckString = entries.join("\n");

  // Derive the secret key.
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  // Compute the expected hash.
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (expectedHash !== hash) {
    return { ok: false, reason: "hash mismatch" };
  }

  // Check auth_date freshness.
  const authDateStr = params.get("auth_date");
  if (!authDateStr) return { ok: false, reason: "missing auth_date" };
  const authDate = parseInt(authDateStr, 10);
  if (Number.isNaN(authDate)) return { ok: false, reason: "invalid auth_date" };
  if (Date.now() - authDate * 1000 > maxAgeMs) {
    return { ok: false, reason: "initData expired" };
  }

  // Extract user.
  const userStr = params.get("user");
  if (!userStr) return { ok: false, reason: "missing user field" };
  let user: TgUser;
  try {
    user = JSON.parse(userStr) as TgUser;
  } catch {
    return { ok: false, reason: "malformed user JSON" };
  }
  if (!user.id) return { ok: false, reason: "user.id missing" };

  return { ok: true, user, authDate };
}
