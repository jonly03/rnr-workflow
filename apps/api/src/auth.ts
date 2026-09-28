import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { CaseStore } from "./store.js";
import type { Channel, StaffUser } from "./types.js";

const CHANNELS: Channel[] = ["DIRECT", "AUCTION", "INSURANCE"];

declare global {
  namespace Express {
    interface Request {
      staff?: StaffUser;
    }
  }
}

export interface AuthConfig {
  authSecret: string;
  tokenTtlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours

// --- Password hashing (scrypt, no external dependencies) ---

const SCRYPT_KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const derived = await scryptAsync(password, salt);
  return timingSafeEqual(derived, expected);
}

// --- Minimal HS256 JWT (no external dependencies) ---

const b64urlEncode = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlDecode = (input: string): Buffer =>
  Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export interface StaffTokenPayload {
  sub: string; // staff user id
  email: string;
  name: string;
  role: string;
  /** Channel codes this staff member may access. Absent = all channels. */
  channels?: string[];
  iat: number;
  exp: number;
}

export function signToken(
  staff: StaffUser,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: StaffTokenPayload = {
    sub: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    ...(staff.channels ? { channels: staff.channels } : {}),
    iat: now,
    exp: now + ttlSeconds
  };
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const signature = b64urlEncode(
    createHmac("sha256", secret).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

export function verifyToken(
  token: string,
  secret: string
): StaffTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = b64urlEncode(
    createHmac("sha256", secret).update(`${header}.${body}`).digest()
  );
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return null;
    }
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return payload as StaffTokenPayload;
  } catch {
    return null;
  }
}

// --- Express middleware ---

export function requireAuth(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("Authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (!match) {
      return res.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Authentication required." }
      });
    }
    const payload = verifyToken(match[1], config.authSecret);
    if (!payload) {
      return res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or expired session. Please sign in again."
        }
      });
    }
    req.staff = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      created_at: "",
      ...(Array.isArray(payload.channels) &&
      payload.channels.every(c => CHANNELS.includes(c as Channel))
        ? { channels: payload.channels as Channel[] }
        : {})
    };
    return next();
  };
}

// --- Seed admin from environment (first boot) ---

export async function ensureSeedAdmin(store: CaseStore): Promise<void> {
  const email = process.env.STAFF_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.STAFF_ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await store.findStaffByEmail(email);
  if (existing) return;
  try {
    await store.createStaffUser({
      email,
      name: "Admin",
      role: "admin",
      passwordHash: await hashPassword(password)
    });
  } catch (error) {
    // Another instance may have seeded the same admin concurrently.
    // Re-check before treating this as a real failure.
    const raced = await store.findStaffByEmail(email).catch(() => null);
    if (raced) return;
    throw error;
  }
  console.log(`Seeded staff admin account: ${email}`);
}
