// Phone-number auth + wallets.
// When Supabase is configured, accounts live in Postgres and the browser only
// receives a session token. Otherwise this falls back to localStorage.
import { hasSupabase, supabase } from "./supabase";

export interface User {
  phone: string;
  /** Present only for the localStorage fallback. Never returned by Supabase. */
  pass?: string;
  role: "admin" | "player";
  balance: number;
  createdAt: number;
}

interface StoreShape {
  v: 1;
  users: User[];
  house: number;
}

const USERS_KEY = "pm_users_v1";
const SESSION_KEY = "pm_session_v1";
const TOKEN_KEY = "pm_token_v1";

const ADMIN_PHONE = "admin";
const ADMIN_PASS = "admin123";
const DEMO_PHONE = "09123456789";
const DEMO_PASS = "1234";
const DEMO_BALANCE = 1000;

let cache: StoreShape = { v: 1, users: [], house: 0 };
let token: string | null = null;
let pendingDelta = 0;
let deltaChain: Promise<void> = Promise.resolve();
let watchPhone = "";
let watchTimer: ReturnType<typeof setInterval> | undefined;
let onBalance: ((balance: number) => void) | null = null;
type WalletChannel = { unsubscribe: () => Promise<unknown> };
let walletChannel: WalletChannel | null = null;

async function sha256(s: string): Promise<string> {
  const salted = `karera::${s}`;
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salted));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    /* fall through */
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < salted.length; i++) {
    const ch = salted.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `!${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}

function asUser(raw: unknown): User | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.phone !== "string" || (r.role !== "admin" && r.role !== "player")) return null;
  return {
    phone: r.phone,
    role: r.role,
    balance: Number(r.balance) || 0,
    createdAt: Number(r.createdAt) || Date.now(),
  };
}

function remember(u: User): void {
  const i = cache.users.findIndex((x) => x.phone === u.phone);
  if (i >= 0) cache.users[i] = u;
  else cache.users.push(u);
}

function applyBundle(raw: unknown): void {
  const b = (raw ?? {}) as { house?: unknown; me?: unknown; users?: unknown };
  cache.house = Number(b.house) || 0;
  const list = Array.isArray(b.users) ? b.users.map(asUser).filter((u): u is User => !!u) : [];
  const me = asUser(b.me);
  cache.users = list.length ? list : me ? [me] : [];
}

async function pullBundle(): Promise<void> {
  if (!supabase || !token) return;
  const { data, error } = await supabase.rpc("session_bundle", { p_token: token });
  if (error) throw new Error(error.message);
  // Don't let a stale read wipe a bet/win that hasn't landed yet.
  if (Math.abs(pendingDelta) > 0.001) return;
  applyBundle(data);
  const me = asUser((data as { me?: unknown } | null)?.me);
  if (!me) {
    token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  onBalance?.(me.balance);
}

function loadLocal(): StoreShape {
  try {
    const raw = localStorage.getItem(USERS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as StoreShape;
      if (p && p.v === 1 && Array.isArray(p.users)) {
        return { v: 1, users: p.users, house: p.house || 0 };
      }
    }
  } catch {
    /* corrupted → reseed */
  }
  return { v: 1, users: [], house: 0 };
}

function saveLocal(): void {
  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(cache));
  } catch {
    /* storage full/blocked */
  }
}

export function isValidPhone(phone: string): boolean {
  return /^09\d{9}$/.test(phone);
}

export const Auth = {
  /** Seed the admin + a demo player on first run. Call once at startup. */
  async init(): Promise<void> {
    if (hasSupabase) {
      try {
        token = localStorage.getItem(TOKEN_KEY);
      } catch {
        token = null;
      }
      if (token) {
        try {
          await pullBundle();
        } catch {
          token = null;
        }
      }
      return;
    }
    cache = loadLocal();
    if (cache.users.length === 0) {
      const now = Date.now();
      cache.users.push({
        phone: ADMIN_PHONE,
        pass: await sha256(ADMIN_PASS),
        role: "admin",
        balance: 0,
        createdAt: now,
      });
      cache.users.push({
        phone: DEMO_PHONE,
        pass: await sha256(DEMO_PASS),
        role: "player",
        balance: DEMO_BALANCE,
        createdAt: now,
      });
      saveLocal();
    }
  },

  users(): User[] {
    return cache.users;
  },

  getUser(phone: string): User | undefined {
    return cache.users.find((u) => u.phone === phone);
  },

  async verify(phone: string, password: string): Promise<User | null> {
    phone = phone.trim();
    const h = await sha256(password);
    if (hasSupabase && supabase) {
      const { data, error } = await supabase.rpc("login", { p_phone: phone, p_pass_hash: h });
      if (error) throw new Error(error.message);
      const row = (data ?? null) as { token?: string } | null;
      const u = asUser(data);
      if (!u || !row?.token) return null;
      token = row.token;
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* ignore */
      }
      remember(u);
      try {
        await pullBundle();
      } catch {
        /* login itself succeeded */
      }
      return this.getUser(u.phone) ?? u;
    }
    const u = this.getUser(phone);
    if (!u || h !== u.pass) return null;
    return u;
  },

  async createUser(phone: string, password: string, balance: number, role: "player" | "admin" = "player"): Promise<User> {
    phone = phone.trim();
    if (role === "player" && !isValidPhone(phone)) {
      throw new Error("Phone must be 09XXXXXXXXX (11 digits).");
    }
    if (!phone) throw new Error("Username required.");
    if (password.length < 4) throw new Error("Password needs 4+ characters.");
    if (!Number.isFinite(balance) || balance < 0) throw new Error("Balance must be 0 or more.");
    const pass = await sha256(password);
    if (hasSupabase && supabase) {
      if (!token) throw new Error("Admin only");
      const { data, error } = await supabase.rpc("create_player", {
        p_token: token,
        p_phone: phone,
        p_pass_hash: pass,
        p_balance: balance,
        p_role: role,
      });
      if (error) throw new Error(error.message);
      const u = asUser(data);
      if (!u) throw new Error("Create failed.");
      remember(u);
      return u;
    }
    if (cache.users.some((u) => u.phone === phone)) throw new Error("Account already exists.");
    const u: User = {
      phone,
      pass,
      role,
      balance: Math.round(balance * 100) / 100,
      createdAt: Date.now(),
    };
    cache.users.push(u);
    saveLocal();
    return u;
  },

  /** Latest balance for this session, from the database, without resetting it. */
  async refresh(): Promise<void> {
    if (hasSupabase && token) {
      try {
        await pullBundle();
      } catch {
        /* keep the last known balance */
      }
    }
  },

  /** How much has been sent but not confirmed. Non-zero means don't overwrite. */
  pending(): number {
    return pendingDelta;
  },

  /**
   * Follow this player's wallet. Broadcasts from Postgres apply immediately;
   * a short poll covers anything the socket misses. Never writes a balance.
   */
  watch(phone: string, cb: (balance: number) => void): void {
    onBalance = cb;
    if (!hasSupabase || !supabase || !phone) return;
    if (watchPhone === phone && walletChannel) return;
    watchPhone = phone;
    if (walletChannel) {
      void walletChannel.unsubscribe();
      walletChannel = null;
    }
    const channel = supabase.channel(`wallet:${phone}`);
    walletChannel = channel;
    channel.on("broadcast", { event: "balance" }, (msg) => {
      const raw = (msg as { payload?: { balance?: unknown } }).payload?.balance;
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.abs(pendingDelta) > 0.001) return;
      const u = cache.users.find((x) => x.phone === phone);
      if (u) u.balance = n;
      onBalance?.(n);
    });
    void channel.subscribe();
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      void this.refresh();
    }, 2000);
  },

  /** Add or subtract the stored balance. Serialized so two bets can't clobber. */
  pushDelta(phone: string, delta: number): void {
    const d = Math.round(delta * 100) / 100;
    if (!d) return;
    const u = cache.users.find((x) => x.phone === phone);
    if (u) u.balance = Math.max(0, Math.round((u.balance + d) * 100) / 100);
    if (!hasSupabase || !supabase || !token) {
      saveLocal();
      return;
    }
    pendingDelta = Math.round((pendingDelta + d) * 100) / 100;
    deltaChain = deltaChain.then(() => this.sendDelta(phone, d));
  },

  async sendDelta(phone: string, delta: number): Promise<void> {
    if (!supabase || !token) return;
    const { data, error } = await supabase.rpc("apply_wallet", {
      p_token: token,
      p_delta: delta,
    });
    pendingDelta = Math.round((pendingDelta - delta) * 100) / 100;
    if (error || data === null || data === undefined) {
      pendingDelta = 0;
      try {
        await pullBundle();
      } catch {
        /* keep last known */
      }
      return;
    }
    const n = Number(data);
    if (!Number.isFinite(n)) return;
    if (Math.abs(pendingDelta) < 0.001) {
      const u = cache.users.find((x) => x.phone === phone);
      if (u) u.balance = n;
      onBalance?.(n);
    }
  },
  adjustBalance(phone: string, delta: number): number {
    const u = cache.users.find((x) => x.phone === phone);
    if (!u && !hasSupabase) throw new Error("Account not found.");
    const next = Math.max(0, Math.round(((u?.balance ?? 0) + delta) * 100) / 100);
    if (u) u.balance = next;
    if (hasSupabase && supabase && token) {
      void supabase
        .rpc("adjust_balance", { p_token: token, p_phone: phone, p_delta: delta })
        .then(({ data, error }) => {
          if (error) return;
          const row = cache.users.find((x) => x.phone === phone);
          if (row && data !== null && data !== undefined) row.balance = Number(data);
        });
    } else {
      saveLocal();
    }
    return next;
  },

  /** Absolute writes are not allowed. Convert to a delta against the stored wallet. */
  persistBalance(phone: string, balance: number): void {
    const u = cache.users.find((x) => x.phone === phone);
    const next = Math.max(0, Math.round(balance * 100) / 100);
    const prev = u ? u.balance : next;
    const delta = Math.round((next - prev) * 100) / 100;
    if (delta !== 0) this.pushDelta(phone, delta);
  },

  creditHouse(amount: number): void {
    if (!(amount > 0)) return;
    cache.house = Math.round((cache.house + amount) * 100) / 100;
    if (hasSupabase && supabase && token) {
      void supabase.rpc("credit_house", { p_token: token, p_amount: amount }).then(({ data, error }) => {
        if (!error && data !== null && data !== undefined) cache.house = Number(data);
      });
      return;
    }
    saveLocal();
  },

  house(): number {
    return cache.house;
  },

  setSession(phone: string): void {
    try {
      localStorage.setItem(SESSION_KEY, phone);
    } catch {
      /* ignore */
    }
  },

  clearSession(): void {
    token = null;
    watchPhone = "";
    onBalance = null;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = undefined;
    if (walletChannel) void walletChannel.unsubscribe();
    walletChannel = null;
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },

  sessionPhone(): string | null {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },

  sessionToken(): string | null {
    return token;
  },

  currentUser(): User | null {
    const p = this.sessionPhone();
    return p ? this.getUser(p) ?? null : null;
  },
};
