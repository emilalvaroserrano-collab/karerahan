// Shared race feed: the live pari-mutuel pool, bet toasts, and who is on
// the track.
//
// Every bet placed while the window is open is one row in race_feed (who,
// which horse, how much). This module keeps those rows live over realtime and
// derives everything the screens read:
//   - total per horse           -> betting cards, quick-bet multipliers
//   - players per horse         -> "N PLAYERS" on the cards
//   - this player's saved stake -> payout at the end of the race
//   - race-level pool/players/bets -> betting header
// When Supabase is not configured the same rows are kept in memory, so the
// pool still moves and still pays.
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Auth } from "./auth";
import { hasSupabase, supabase } from "./supabase";

export type FeedRow = {
  id: string;
  phone: string;
  horse: number;
  horse_name: string;
  amount: number;
};

/** What one horse's corner of the pool looks like right now. */
export type HorsePool = {
  /** distinct players with money on this horse */
  players: number;
  /** total staked on this horse */
  total: number;
  /** bet entries on this horse */
  bets: number;
};

/** The whole race pool, the number a payout is derived from. */
export type RacePool = {
  race: number;
  /** all money staked on the race */
  total: number;
  /** distinct players in the pool */
  players: number;
  /** bet entries in the pool */
  bets: number;
  horses: HorsePool[];
};

export type BetToast = { id: string; text: string; at: number };

const TOAST_MS = 3200;

const r2 = (v: number): number => Math.round(v * 100) / 100;

const emptyHorses = (): HorsePool[] =>
  Array.from({ length: 8 }, () => ({ players: 0, total: 0, bets: 0 }));

class RaceFeed {
  online = 1;
  race = 0;
  private phone = "";
  private rows = new Map<string, FeedRow>();
  private horses: HorsePool[] = emptyHorses();
  /** phone -> stake per horse, for payouts and "you" readouts */
  private byPhone = new Map<string, number[]>();
  private pool: RacePool = { race: 0, total: 0, players: 0, bets: 0, horses: emptyHorses() };
  private notes: BetToast[] = [];
  private localSeq = 0;
  private presence: RealtimeChannel | null = null;
  private bets: RealtimeChannel | null = null;

  /** Total staked on one horse this race. */
  total(horse: number): number {
    return this.horses[horse]?.total ?? 0;
  }

  /** How many distinct players have money on one horse. */
  players(horse: number): number {
    return this.horses[horse]?.players ?? 0;
  }

  /** How many bet entries sit on one horse. */
  betsOn(horse: number): number {
    return this.horses[horse]?.bets ?? 0;
  }

  /** What one player has staked on one horse (0 when they passed). */
  playerStake(horse: number, phone: string): number {
    return this.byPhone.get(phone)?.[horse] ?? 0;
  }

  /** What one player has staked across the whole race. */
  playerRaceStake(phone: string): number {
    const stake = this.byPhone.get(phone);
    return stake ? r2(stake.reduce((s, n) => s + n, 0)) : 0;
  }

  /** The race pool as it stands (a copy; safe to hold). */
  racePool(): RacePool {
    return { ...this.pool, horses: this.pool.horses.map((h) => ({ ...h })) };
  }

  toasts(now = performance.now()): BetToast[] {
    this.notes = this.notes.filter((t) => now - t.at < TOAST_MS);
    return this.notes;
  }

  /** Call whenever a player is on the track (betting, waiting, or watching). */
  join(phone: string, race: number): void {
    if (!phone) return;
    this.phone = phone;
    this.ensurePresence(phone);
    if (this.race === race && this.bets) return;
    this.race = race;
    this.reset();
    void this.load(race);
    this.subscribe(race);
  }

  leave(): void {
    this.phone = "";
    this.online = 1;
    this.notes = [];
    this.reset();
    this.paint();
    if (this.presence && supabase) void supabase.removeChannel(this.presence);
    if (this.bets && supabase) void supabase.removeChannel(this.bets);
    this.presence = null;
    this.bets = null;
  }

  post(race: number, horse: number, name: string, amount: number): void {
    const token = Auth.sessionToken();
    if (!hasSupabase || !supabase || !token) {
      this.ingest(
        {
          id: `local-${++this.localSeq}`,
          phone: this.phone || "00000",
          horse,
          horse_name: name,
          amount: r2(amount),
        },
        true,
      );
      return;
    }
    void supabase
      .rpc("post_race_bet", {
        p_token: token,
        p_race: race,
        p_horse: horse,
        p_name: name,
        p_amount: amount,
      })
      .then(({ data, error }) => {
        // A lost write must not poison the board: re-pull the truth instead
        // of guessing what landed.
        if (error || !data) {
          void this.load(race);
          return;
        }
        this.ingest(data as FeedRow, true);
      });
  }

  clear(race: number): void {
    const token = Auth.sessionToken();
    if (!hasSupabase || !supabase || !token) {
      if (race === this.race) {
        const mine = this.phone || "00000";
        for (const [id, row] of [...this.rows]) if (row.phone === mine) this.rows.delete(id);
        this.recalc();
      }
      return;
    }
    void supabase.rpc("clear_race_bets", { p_token: token, p_race: race }).then(() => {
      void this.load(race);
    });
  }

  /**
   * Record this player's settlement for the race: their stake, the dividend
   * it was paid at, and the pool it came from. Best-effort — the UI must
   * never wait on (or fail from) the durable log.
   */
  logPayout(
    race: number,
    horse: number,
    stake: number,
    stakeOnHorse: number,
    dividend: number,
    payout: number,
    poolTotal: number,
  ): void {
    const token = Auth.sessionToken();
    if (!hasSupabase || !supabase || !token || !(stake > 0)) return;
    void supabase
      .rpc("log_race_payout", {
        p_token: token,
        p_race: race,
        p_horse: horse,
        p_stake: r2(stake),
        p_stake_on_horse: r2(stakeOnHorse),
        p_dividend: r2(dividend),
        p_payout: r2(payout),
        p_pool_total: r2(poolTotal),
      })
      .then(undefined, () => {
        /* durable record is optional; the race keeps going */
      });
  }

  private reset(): void {
    this.rows.clear();
    this.byPhone.clear();
    this.horses = emptyHorses();
    this.pool = { race: this.race, total: 0, players: 0, bets: 0, horses: emptyHorses() };
  }

  private async load(race: number): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("race_bets", { p_race: race });
    if (error || race !== this.race || !Array.isArray(data)) return;
    this.reset();
    for (const row of data) this.ingest(row as FeedRow, false);
  }

  private subscribe(race: number): void {
    if (!supabase) return;
    if (this.bets) void supabase.removeChannel(this.bets);
    const ch = supabase.channel(`race-feed-${race}`);
    this.bets = ch;
    ch.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "race_feed", filter: `race_number=eq.${race}` },
      (payload) => {
        if (race !== this.race) return;
        this.ingest(payload.new as FeedRow, true);
      },
    );
    ch.on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "race_feed", filter: `race_number=eq.${race}` },
      (payload) => {
        if (race !== this.race) return;
        const id = (payload.old as { id?: string } | undefined)?.id;
        if (id && this.rows.delete(String(id))) {
          this.recalc();
          return;
        }
        // No usable key in the payload: pull the rows again.
        void this.load(race);
      },
    );
    void ch.subscribe();
  }

  private ensurePresence(phone: string): void {
    if (!supabase || this.presence) return;
    const ch = supabase.channel("track-live", { config: { presence: { key: phone } } });
    this.presence = ch;
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      const n = Object.keys(state).length;
      this.online = Math.max(1, n);
    });
    void ch.subscribe((status) => {
      if (status === "SUBSCRIBED") void ch.track({ phone });
    });
  }

  private ingest(row: FeedRow, announce: boolean): void {
    if (!row?.id) return;
    const horse = Number(row.horse);
    const amount = Number(row.amount);
    if (horse < 0 || horse > 7 || !(amount > 0)) return;
    const id = String(row.id);
    if (!this.rows.has(id)) {
      this.rows.set(id, {
        id,
        phone: String(row.phone ?? ""),
        horse,
        horse_name: String(row.horse_name ?? ""),
        amount: r2(amount),
      });
      this.recalc();
    }
    if (announce) this.toast(String(row.phone ?? ""), String(row.horse_name ?? ""), amount);
  }

  /** Roll every row up into the per-horse and race-wide pool numbers. */
  private recalc(): void {
    const totals = new Array(8).fill(0);
    const bets = new Array(8).fill(0);
    const phones: Set<string>[] = Array.from({ length: 8 }, () => new Set<string>());
    const byPhone = new Map<string, number[]>();
    const racePhones = new Set<string>();
    let raceTotal = 0;
    let raceBets = 0;
    for (const row of this.rows.values()) {
      totals[row.horse] = r2(totals[row.horse] + row.amount);
      bets[row.horse] += 1;
      phones[row.horse].add(row.phone);
      racePhones.add(row.phone);
      raceTotal = r2(raceTotal + row.amount);
      raceBets += 1;
      let stake = byPhone.get(row.phone);
      if (!stake) {
        stake = new Array(8).fill(0);
        byPhone.set(row.phone, stake);
      }
      stake[row.horse] = r2(stake[row.horse] + row.amount);
    }
    this.horses = totals.map((total, i) => ({ players: phones[i].size, total, bets: bets[i] }));
    this.byPhone = byPhone;
    this.pool = {
      race: this.race,
      total: raceTotal,
      players: racePhones.size,
      bets: raceBets,
      horses: this.horses.map((h) => ({ ...h })),
    };
  }

  private toast(phone: string, name: string, amount: number): void {
    const digits = phone.replace(/\D/g, "");
    const tail = (digits || "00000").slice(-5);
    const amt = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
    this.notes.unshift({
      id: `${Date.now()}-${tail}-${name}`,
      text: `${tail} bets ${amt} to ${name}`,
      at: performance.now(),
    });
    this.notes = this.notes.slice(0, 4);
    this.paint();
    window.setTimeout(() => this.paint(), TOAST_MS + 50);
  }

  private paint(): void {
    const now = performance.now();
    this.notes = this.notes.filter((t) => now - t.at < TOAST_MS);
    let host = document.getElementById("race-toasts");
    if (!this.notes.length) {
      host?.remove();
      return;
    }
    if (!host) {
      host = document.createElement("div");
      host.id = "race-toasts";
      (document.getElementById("stage-ui") ?? document.body).appendChild(host);
    }
    host.replaceChildren(...this.notes.map((t) => {
      const el = document.createElement("div");
      el.className = "race-toast";
      el.textContent = t.text;
      return el;
    }));
  }
}

export const feed = new RaceFeed();
