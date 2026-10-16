// One shared race for every player, driven by the clock so nobody
// starts a private race. Betting is open, then the same race runs.

export const BET_S = 60;
export const RACE_S = 70;
export const CYCLE_S = BET_S + RACE_S;
const EPOCH = Date.UTC(2026, 0, 1) / 1000;

export type RacePhase = "betting" | "racing";

export type RaceClock = {
  raceNumber: number;
  phase: RacePhase;
  /** Seconds left in the betting window. 0 while the race is running. */
  countdown: number;
  /** Seconds the current race has already been running. */
  raceT: number;
  /** Seconds until the next betting window opens. */
  nextIn: number;
};

export function raceClock(now = Date.now()): RaceClock {
  const t = now / 1000 - EPOCH;
  const cycle = Math.floor(t / CYCLE_S);
  const into = t - cycle * CYCLE_S;
  const raceNumber = cycle + 1;
  if (into < BET_S) {
    const countdown = BET_S - into;
    return { raceNumber, phase: "betting", countdown, raceT: 0, nextIn: countdown };
  }
  const raceT = into - BET_S;
  return {
    raceNumber,
    phase: "racing",
    countdown: 0,
    raceT,
    nextIn: CYCLE_S - into,
  };
}

/** Same sequence on every device for a given race number. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
