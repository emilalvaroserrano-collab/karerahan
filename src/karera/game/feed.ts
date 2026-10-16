// Shared race feed: horse totals, bet toasts, and who is on the track.
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

export type BetToast = { id: string; text: string; at: number };

const TOAST_MS = 3200;

class RaceFeed {
  totals = [0, 0, 0, 0, 0, 0, 0, 0];
  online = 1;
  race = 0;
  private phone = "";
  private seen = new Set<string>();
  private notes: BetToast[] = [];
  private presence: RealtimeChannel | null = null;
  private bets: RealtimeChannel | null = null;

  total(horse: number): number {
    return this.totals[horse] ?? 0;
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
    this.totals = [0, 0, 0, 0, 0, 0, 0, 0];
    this.seen.clear();
    void this.load(race);
    this.subscribe(race);
  }

  leave(): void {
    this.phone = "";
    this.online = 1;
    this.notes = [];
    this.paint();
    if (this.presence && supabase) void supabase.removeChannel(this.presence);
    if (this.bets && supabase) void supabase.removeChannel(this.bets);
    this.presence = null;
    this.bets = null;
    this.race = 0;
  }

  post(race: number, horse: number, name: string, amount: number): void {
    const token = Auth.sessionToken();
    if (!hasSupabase || !supabase || !token) {
      this.toast(this.phone || "00000", name, amount);
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
        if (error || !data) return;
        this.ingest(data as FeedRow, true);
      });
  }

  clear(race: number): void {
    const token = Auth.sessionToken();
    if (!hasSupabase || !supabase || !token) return;
    void supabase.rpc("clear_race_bets", { p_token: token, p_race: race }).then(() => {
      void this.load(race);
    });
  }

  private async load(race: number): Promise<void> {
    if (!supabase) return;
    const { data, error } = await supabase.rpc("race_bets", { p_race: race });
    if (error || race !== this.race || !Array.isArray(data)) return;
    this.totals = [0, 0, 0, 0, 0, 0, 0, 0];
    this.seen.clear();
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
      () => {
        if (race === this.race) void this.load(race);
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
    if (!row?.id || this.seen.has(row.id)) return;
    const horse = Number(row.horse);
    const amount = Number(row.amount);
    if (horse < 0 || horse > 7 || !(amount > 0)) return;
    this.seen.add(row.id);
    this.totals[horse] = Math.round((this.totals[horse] + amount) * 100) / 100;
    if (announce) this.toast(String(row.phone ?? ""), String(row.horse_name ?? ""), amount);
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
      document.body.appendChild(host);
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
