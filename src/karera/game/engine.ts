// Game engine: canvas scaling (1280x876 design space, contain-fit), main
// loop, pointer mapping (rotation-aware for auto-landscape), screen management.
import { Assets } from "./assets";
import { Sound } from "./audio";
import { DESIGN_H, DESIGN_W } from "./constants";
import { GameState } from "./state";
import { Buttons } from "./ui";
import { Network } from "./network";

export interface Screen {
  enter(): void;
  exit(): void;
  update(dt: number): void;
  render(ctx: CanvasRenderingContext2D): void;
  pointerDown(x: number, y: number): void;
  pointerUp(x: number, y: number): void;
}

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  assets = new Assets();
  sound: Sound;
  state = new GameState();
  buttons = new Buttons();
  screen: Screen | null = null;
  net: Network;
  scale = 1;
  /** True while the canvas is CSS-rotated for portrait (auto-landscape). */
  rotated = false;
  private last = 0;
  private orientDiv: HTMLElement | null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    this.ctx = ctx;
    this.sound = new Sound(this.assets);
    this.sound.muted = true;
    this.orientDiv = document.querySelector(".orientation-msg-container");
    this.net = new Network();
    this.net.connect();

    window.addEventListener("resize", () => this.resize());
    window.addEventListener("orientationchange", () => this.resize());
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this.resize());
    }
    canvas.addEventListener("pointerdown", (e) => {
      // Re-assert the soundtrack on every tap while unmuted: mobile browsers
      // only allow audio inside/after user gestures, so this heals playback
      // after screen transitions or auto-play blocks. Resumes BGM or the
      // race bed depending on which screen is showing (never both).
      this.sound.resume();
      const p = this.toDesign(e.clientX, e.clientY);
      this.buttons.down(p.x, p.y);
      this.screen?.pointerDown(p.x, p.y);
    });
    window.addEventListener("pointerup", (e) => {
      const p = this.toDesign(e.clientX, e.clientY);
      this.buttons.up(p.x, p.y);
      this.screen?.pointerUp(p.x, p.y);
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.resize();
  }

  resize(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Portrait (phone held upright): auto-landscape — CSS-rotate the
    // landscape game 90° so it fills the screen instead of a tiny strip.
    // Landscape/desktop: contain-fit the whole 1280x876 stage so the HUD is
    // never cropped (scale-to-width cut the top/bottom on short screens).
    this.rotated = vh > vw;
    const aw = this.rotated ? vh : vw;
    const ah = this.rotated ? vw : vh;
    this.scale = Math.min(aw / DESIGN_W, ah / DESIGN_H);
    const cw = Math.max(1, Math.round(DESIGN_W * this.scale));
    const ch = Math.max(1, Math.round(DESIGN_H * this.scale));
    const st = this.canvas.style;
    st.width = `${cw}px`;
    st.height = `${ch}px`;
    st.left = "50%";
    st.top = "50%";
    st.transform = this.rotated
      ? "translate(-50%, -50%) rotate(90deg)"
      : "translate(-50%, -50%)";
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    const ui = document.getElementById("stage-ui");
    if (ui) {
      ui.style.width = `${cw}px`;
      ui.style.height = `${ch}px`;
      ui.style.transform = st.transform;
    }
    document.documentElement.classList.toggle("stage-rotated", this.rotated);
    // The rotate-device overlay is obsolete: portrait now plays fullscreen
    // via auto-landscape.
    if (this.orientDiv) {
      this.orientDiv.style.display = "none";
    }
  }

  toDesign(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    if (!this.rotated) {
      return {
        x: ((clientX - r.left) / r.width) * DESIGN_W,
        y: ((clientY - r.top) / r.height) * DESIGN_H,
      };
    }
    // Canvas is rotated 90° clockwise about its center (local +x → screen
    // +y), so inverse-rotate the touch point, then scale. Bounding box is
    // ch×cw while the unrotated CSS size is cw×ch.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const sx = clientX - cx;
    const sy = clientY - cy;
    const cw = r.height;
    const ch = r.width;
    const dx = sy;
    const dy = -sx;
    return {
      x: (dx / cw + 0.5) * DESIGN_W,
      y: (dy / ch + 0.5) * DESIGN_H,
    };
  }

  show(s: Screen): void {
    this.screen?.exit();
    this.buttons.clear();
    this.screen = s;
    s.enter();
  }

  fullscreen(on: boolean): void {
    try {
      if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) void document.exitFullscreen();
    } catch {
      /* ignore */
    }
  }

  private alive = true;

  stop(): void {
    this.alive = false;
  }

  run(): void {
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.alive || !this.canvas.isConnected) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      const k = this.canvas.width / DESIGN_W;
      this.ctx.setTransform(k, 0, 0, k, 0, 0);
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, DESIGN_W, DESIGN_H);
      this.screen?.update(dt);
      this.screen?.render(this.ctx);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
