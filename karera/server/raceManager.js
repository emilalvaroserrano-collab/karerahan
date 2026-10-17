const TRAPS = 8;
const COUNTDOWN_S = 80;
const HOUSE_TAKE = 0.1;

export class RaceManager {
  constructor() {
    this.raceNumber = 1;
    this.phase = "betting";
    this.countdown = 0;
    this.bets = [];
    this.horsesWithBets = new Set();
    this.raceStartTime = 0;
    this.raceId = null;
    this.results = null;
  }

  state() {
    return {
      raceId: this.raceId,
      raceNumber: this.raceNumber,
      phase: this.phase,
      countdown: Math.max(0, this.countdown),
      bets: this.bets,
      horsesWithBets: [...this.horsesWithBets],
      poolTotal: this.bets.reduce((s, b) => s + b.amount, 0),
      results: this.results,
    };
  }

  placeBet(phone, kind, a, b, amount) {
    if (this.phase !== "betting") return { ok: false, reason: "locked" };
    if (amount <= 0) return { ok: false, reason: "invalid" };

    this.bets.push({ phone, kind, a, b, amount, t: Date.now() });
    this.horsesWithBets.add(a);
    if (b >= 0) this.horsesWithBets.add(b);

    if (this.armed() && this.countdown <= 0) {
      this.countdown = COUNTDOWN_S;
    }

    return { ok: true };
  }

  removeBets(phone) {
    this.bets = this.bets.filter((b) => b.phone !== phone);
    this.recalcHorses();
  }

  recalcHorses() {
    this.horsesWithBets.clear();
    for (const b of this.bets) {
      this.horsesWithBets.add(b.a);
      if (b.b >= 0) this.horsesWithBets.add(b.b);
    }
    if (!this.armed()) this.countdown = 0;
  }

  armed() {
    const players = new Set(this.bets.map((b) => b.phone).filter(Boolean));
    return this.horsesWithBets.size >= 2 || players.size >= 2;
  }

  tick(dt) {
    if (this.phase === "betting" && this.countdown > 0) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.phase = "racing";
        this.raceStartTime = Date.now();
        return true;
      }
    }
    return false;
  }

  finishRace(results) {
    this.results = results;
    this.phase = "results";
  }

  hydrate(saved) {
    if (!saved || typeof saved !== "object") return;
    this.raceId = saved.raceId || null;
    this.raceNumber = saved.raceNumber || 1;
    this.phase = saved.phase || "betting";
    this.countdown = Number(saved.countdown) || 0;
    this.bets = Array.isArray(saved.bets) ? saved.bets : [];
    this.results = saved.results ?? null;
    this.recalcHorses();
  }

  nextRace() {
    this.raceId = null;
    this.raceNumber++;
    this.phase = "betting";
    this.countdown = 0;
    this.bets = [];
    this.horsesWithBets.clear();
    this.results = null;
  }
}
