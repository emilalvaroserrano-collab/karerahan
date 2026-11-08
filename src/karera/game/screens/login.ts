// Phone-number login (DOM overlay over the canvas; native keyboards on mobile).
import { FONT_IMPACT, FONT_MOTOR } from "../constants";
import { Game, Screen } from "../engine";
import { Auth } from "../auth";
import { drawCentered, text } from "../ui";
import { MenuScreen } from "./menu";

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export class LoginScreen implements Screen {
  private onKey: ((e: KeyboardEvent) => void) | null = null;

  constructor(private game: Game) {}

  enter(): void {
    this.game.sound.soundtrack(false);
    el("auth-overlay")?.classList.remove("hidden");
    document.querySelector("#auth-overlay .hint")?.remove();
    const err = el("lo-err");
    if (err) err.textContent = "";
    const btn = el("lo-btn");
    btn?.addEventListener("click", this.login);
    const pass = el<HTMLInputElement>("lo-pass");
    this.onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") void this.login();
    };
    pass?.addEventListener("keydown", this.onKey);
    setTimeout(() => el<HTMLInputElement>("lo-phone")?.focus({ preventScroll: true }), 50);
  }

  exit(): void {
    el("auth-overlay")?.classList.add("hidden");
    el("lo-btn")?.removeEventListener("click", this.login);
    if (this.onKey) el("lo-pass")?.removeEventListener("keydown", this.onKey);
    this.onKey = null;
  }

  private login = async (): Promise<void> => {
    const phone = el<HTMLInputElement>("lo-phone")?.value ?? "";
    const pass = el<HTMLInputElement>("lo-pass")?.value ?? "";
    const err = el("lo-err");
    const btn = el<HTMLButtonElement>("lo-btn");
    if (btn) btn.textContent = "...";
    if (err) err.textContent = "";
    try {
      const u = await Auth.verify(phone, pass);
      if (!u) {
        if (err) err.textContent = "Wrong credentials.";
        return;
      }
      Auth.setSession(u.phone);
      this.game.state.phone = u.phone;
      this.game.state.loadWallet();
      this.game.state.newRace();
      this.game.net.auth(u.phone);
      this.game.show(new MenuScreen(this.game));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Login failed.";
      // Friendlier Firebase messages
      const friendly = /invalid-credential|wrong-password|user-not-found/i.test(msg)
        ? "Wrong email/password, or account not found in Firebase."
        : /email-already-in-use/i.test(msg)
          ? "Email already in use."
          : /network-request-failed/i.test(msg)
            ? "Network error. Check your connection."
            : msg;
      if (err) err.textContent = friendly;
    } finally {
      if (btn) btn.textContent = "ENTER PADDOCK";
    }
  };

  update(): void {}

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    try {
      ctx.drawImage(g.assets.img("bg_menu"), 0, 0, 1280, 876);
      drawCentered(ctx, g.assets.img("logo_menu"), 640, 86, 754, 116);
    } catch {
      ctx.fillStyle = "#06142e";
      ctx.fillRect(0, 0, 1280, 876);
    }
    text(ctx, "KARERA • LOGIN", 640, 700, {
      font: FONT_IMPACT, size: 40, color: "#ffffff",
    });
    text(ctx, "Use the login form to enter", 640, 745, {
      font: FONT_MOTOR, size: 20, color: "#9fd0ff",
    });
  }

  pointerDown(): void {}
  pointerUp(): void {}
}
