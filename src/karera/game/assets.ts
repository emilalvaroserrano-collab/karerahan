// Asset manifest + loading with progress. Mirrors the original preload list.
import { CHIP_VALUES } from "./constants";
import { assetBase } from "./supabase";

const SPR = assetBase ? `${assetBase}sprites/` : "sprites/";
const SND = assetBase ? `${assetBase}sounds/` : "sounds/";
/** Bump when environment backgrounds are replaced so caches drop the old art. */
const BG_REV = "real2";

function srcOf(file: string): string {
  const src = SPR + file;
  return file.startsWith("bg_") ? `${src}?v=${BG_REV}` : src;
}

export const IMAGE_FILES: string[] = [
  "200x200.jpg",
  "bg_menu.jpg",
  "bg_bet_panel.jpg",
  "logo_menu.png",
  "logo_ctl.png",
  "but_play.png",
  "but_credits.png",
  "but_exit.png",
  "but_fullscreen.png",
  "but_start.png",
  "but_start_race.png",
  "but_clear_bet.png",
  "but_home.png",
  "but_restart.png",
  "but_yes.png",
  "but_no.png",
  "but_skip.png",
  "arrow_left.png",
  "arrow_right.png",
  "audio_icon.png",
  "bet_place.png",
  "odd_bg.png",
  "money_panel.png",
  "fiche_panel.png",
  "fiche_highlight.png",
  "bibs.png",
  "forecast_panel.png",
  "simple_bet_panel.png",
  "panel_arrival.png",
  "rank_panel.png",
  "msg_box.png",
  "win_panel.png",
  "lose_panel.png",
  "progress_bar.png",
  "fill_bar.png",
  ...CHIP_VALUES.map((_, i) => `fiche_${i}.png`),
  ...Array.from({ length: 8 }, (_, i) => `bib_gui_${i}.png`),
  ...Array.from({ length: 8 }, (_, i) => `horse_${i + 1}_a.png`),
  ...Array.from({ length: 8 }, (_, i) => `horse_${i + 1}_b.png`),
  ...Array.from({ length: 9 }, (_, i) => `cage_${i}.png`),
  ...Array.from({ length: 9 }, (_, i) => `cage_gates/gate_${i}.png`),
];

/** Original side-scrolling track sprites, bg_track_0 .. bg_track_187. */
export const TRACK_COUNT = 188;

export function trackSrc(i: number): string {
  const n = Math.max(0, Math.min(TRACK_COUNT - 1, i));
  return `/sprites/bg_track/bg_track_${n}.jpg`;
}

export const SOUND_FILES = [
  "click.mp3",
  "chip.mp3",
  "photo.mp3",
  "start_race.mp3",
  "race_intro.mp3",
  "soundtrack.mp3",
] as const;

export type SoundName = (typeof SOUND_FILES)[number];

export class Assets {
  images = new Map<string, HTMLImageElement>();
  sounds = new Map<SoundName, HTMLAudioElement>();
  loaded = 0;
  total = 0;

  get progress(): number {
    return this.total === 0 ? 0 : this.loaded / this.total;
  }

  img(name: string): HTMLImageElement {
    const im = this.images.get(name);
    if (!im) throw new Error(`image not loaded: ${name}`);
    return im;
  }

  trackFrame(i: number): HTMLImageElement {
    const n = Math.max(0, Math.min(TRACK_COUNT - 1, Math.round(i)));
    const key = `bg_track_${n}`;
    let im = this.images.get(key);
    if (!im) {
      im = new Image();
      im.src = trackSrc(n);
      this.images.set(key, im);
    }
    return im;
  }

  async loadAll(): Promise<void> {
    const jobs: Promise<void>[] = [];
    const all = [...IMAGE_FILES.map((f) => srcOf(f))];
    for (let i = 0; i < TRACK_COUNT; i++) all.push(trackSrc(i));
    this.total = all.length + SOUND_FILES.length;

    const tick = () => {
      this.loaded++;
    };
    for (const src of all) {
      jobs.push(
        new Promise<void>((resolve) => {
          const im = new Image();
          im.onload = () => {
            tick();
            resolve();
          };
          im.onerror = () => {
            tick();
            resolve();
          };
          im.src = src;
          const key = src.split("/").pop()!.split("?")[0].replace(/\.(png|jpg)$/, "");
          this.images.set(key, im);
        }),
      );
    }
    for (const f of SOUND_FILES) {
      jobs.push(
        new Promise<void>((resolve) => {
          const a = new Audio();
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            tick();
            resolve();
          };
          a.addEventListener("canplaythrough", finish, { once: true });
          a.addEventListener("error", finish, { once: true });
          // Fallback in case events never fire.
          setTimeout(finish, 8000);
          a.src = SND + f;
          a.load();
          this.sounds.set(f as SoundName, a);
        }),
      );
    }
    // Resolve progressively; caller polls progress.
    void Promise.all(jobs);
    await Promise.all(jobs);
  }
}
