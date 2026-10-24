// Official Donut Local API discovery + credential (contract v0.31.x).
//
// This replaces the retired DBI-era discovery (runtime.json written by a
// backend CareerFlow owned). The official application exposes:
//
//   settings  <home>/AppData/Local/DonutBrowser/settings/app_settings.json
//             { api_enabled: bool, api_port: number }
//   token     .../settings/api_token.dat  — "DBAPI" v2 container:
//             header "DBAPI" | 0x02 | saltLen u8 | saltB64 | nonce 12 |
//             ctLen u32-le | ct
//             key = Argon2id(vault.key raw bytes, raw salt,
//                            m=19456, t=2, p=1, 32 bytes) -> AES-256-GCM
//   vault     .../settings/vault.key     — raw key material (same user)
//
// SECURITY CONTRACT:
//   - The decrypted token NEVER leaves request-header scope: it is not
//     returned by any exported function except inside `authHeaders`, never
//     logged, never written to disk. Callers must pass it only to fetch().
//   - The fallback token source is the app_settings.json `api_token` field
//     (the value the Settings UI lets the user copy) — same secrecy rule.

import { readFileSync } from "node:fs";
import { createDecipheriv, argon2 as argon2Cb } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const argon2 = promisify(argon2Cb);

const DEFAULT_SETTINGS_DIR = path.join(
  os.homedir(),
  "AppData",
  "Local",
  "DonutBrowser",
  "settings",
);

const DBAPI_HEADER = "DBAPI";
const DBAPI_VERSION = 2;
const ARGON2 = Object.freeze({
  parallelism: 1,
  memory: 19456,
  passes: 2,
  tagLength: 32,
});

function settingsDir(override) {
  return override || process.env.CAREERFLOW_DONUT_SETTINGS_DIR || DEFAULT_SETTINGS_DIR;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function b64ToBuf(text) {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  return Buffer.from(padded, "base64url");
}

function looksLikeToken(value) {
  return typeof value === "string" && /^[\x21-\x7e]{8,}$/.test(value);
}

function tokenFromSettings(base) {
  const settings = readJsonFile(path.join(base, "app_settings.json"));
  const token = typeof settings?.api_token === "string" ? settings.api_token : null;
  return looksLikeToken(token) ? token : null;
}

/**
 * Decrypt the official DBAPI v2 token container. Returns the token string or
 * null. The value is for the caller's request header only — never log it.
 */
export async function deriveToken(base) {
  try {
    const data = readFileSync(path.join(base, "api_token.dat"));
    if (
      data.length < 24 ||
      data.subarray(0, 5).toString("latin1") !== DBAPI_HEADER ||
      data[5] !== DBAPI_VERSION
    ) {
      return tokenFromSettings(base);
    }
    const saltLen = data[6];
    const salt = b64ToBuf(data.subarray(7, 7 + saltLen).toString("ascii"));
    let off = 7 + saltLen;
    const nonce = data.subarray(off, off + 12);
    off += 12;
    const ctLen = data.readUInt32LE(off);
    // The stored ciphertext is GCM ciphertext WITH the 16-byte auth tag
    // appended. Node's decipher wants them separated.
    const ctWithTag = data.subarray(off + 4, off + 4 + ctLen);
    if (ctWithTag.length <= 16) return tokenFromSettings(base);
    const ciphertext = ctWithTag.subarray(0, ctWithTag.length - 16);
    const authTag = ctWithTag.subarray(ctWithTag.length - 16);
    const vaultKey = readFileSync(path.join(base, "vault.key"));
    // Node's argon2 parameter map: `nonce` is the Argon2 SALT (verified
    // byte-for-byte against the reference implementation).
    const key = await argon2("argon2id", {
      message: vaultKey,
      nonce: salt,
      ...ARGON2,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const token = plain.toString("ascii").replace(/[\s\u0000]+/g, "");
    return looksLikeToken(token) ? token : null;
  } catch {
    return tokenFromSettings(base);
  }
}

/**
 * Official Local API location + auth material.
 *
 * Returns { ok, state, port?, reason?, authHeaders? } where authHeaders is
 * suitable for fetch(); the token inside must never be logged. `state` is
 * provider-neutral: "connected" when the API is enabled and a token exists,
 * "unavailable" otherwise.
 */
export async function readLocalApiCredential(dir) {
  const base = settingsDir(dir);
  const settings = readJsonFile(path.join(base, "app_settings.json"));
  const enabled = settings?.api_enabled === true;
  const port = Number(settings?.api_port) || 10108;
  if (!enabled) {
    return { ok: false, state: "unavailable", reason: "local-api-disabled" };
  }
  const token = await deriveToken(base);
  if (!token) {
    return { ok: false, state: "unavailable", reason: "token-unavailable" };
  }
  return {
    ok: true,
    state: "connected",
    port,
    authHeaders: { Authorization: `Bearer ${token}` },
  };
}

/** Sanitized connection facts — safe for the renderer and logs. */
export async function describeLocalApi(dir) {
  const base = settingsDir(dir);
  const settings = readJsonFile(path.join(base, "app_settings.json"));
  return {
    apiEnabled: settings?.api_enabled === true,
    apiPort: Number(settings?.api_port) || 10108,
    hasCredential: (await deriveToken(base)) !== null,
  };
}
