// Canvas draw helpers + a tiny immediate-mode button registry.
import { Assets } from "./assets";

export interface TextOpts {
  font: string;
  size: number;
  color: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  spacing?: number;
  stroke?: string;
  strokeWidth?: number;
}

export function text(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  o: TextOpts,
): void {
  ctx.save();
  ctx.font = `${o.size}px ${o.font}`;
  ctx.textAlign = o.align ?? "center";
  ctx.textBaseline = o.baseline ?? "middle";
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${o.spacing ?? 0}px`;
  } catch {
    /* older canvas */
  }
  if (o.stroke) {
    ctx.lineWidth = o.strokeWidth ?? 3;
    ctx.strokeStyle = o.stroke;
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = o.color;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** Draw text shrunk (never stretched) until it fits `maxW`. Keeps long
 *  names and big amounts inside the panel slots instead of spilling over
 *  the art next to them. */
export function fitText(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  o: TextOpts,
  maxW: number,
  minSize = 9,
): void {
  let size = o.size;
  ctx.save();
  ctx.font = `${size}px ${o.font}`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  if (w > maxW && w > 0) size = Math.max(minSize, Math.floor((size * maxW) / w));
  text(ctx, str, x, y, { ...o, size });
}

export function drawCentered(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  w?: number,
  h?: number,
): void {
  const dw = w ?? img.naturalWidth;
  const dh = h ?? img.naturalHeight;
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
}

/** Draw the left (index 0) or right (index 1) half of a 2-state wide sprite. */
export function drawStateHalf(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  name: string,
  index: 0 | 1,
  x: number,
  y: number,
): void {
  const img = assets.img(name);
  const hw = img.naturalWidth / 2;
  ctx.drawImage(img, index * hw, 0, hw, img.naturalHeight, x, y, hw, img.naturalHeight);
}

export interface ButtonDef {
  x: number;
  y: number;
  w: number;
  h: number;
  onTap: () => void;
  /** press feedback scale, default 0.94 */
  pressScale?: number;
}

export class Buttons {
  list: ButtonDef[] = [];
  private pressed: ButtonDef | null = null;
  private pressX = 0;
  private pressY = 0;
  private pressT = 0;

  /** Called every frame by screens before re-registering their buttons.
   *  Must NOT drop the active press: pointerup may arrive many frames later,
   *  long after the pressed button object was replaced. */
  clear(): void {
    this.list = [];
  }

  add(b: ButtonDef): void {
    this.list.push(b);
  }

  down(x: number, y: number): boolean {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        this.pressed = b;
        this.pressX = x;
        this.pressY = y;
        this.pressT = performance.now();
        return true;
      }
    }
    return false;
  }

  /** Resolve the tap against the current frame's list (the button object
   *  captured on pointerdown is stale by now). Tap only fires when both the
   *  press and release points hit the same button. */
  up(x: number, y: number): boolean {
    const had = this.pressed !== null;
    const { pressX, pressY } = this;
    this.pressed = null;
    if (!had) return false;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      const inDown = pressX >= b.x && pressX <= b.x + b.w && pressY >= b.y && pressY <= b.y + b.h;
      const inUp = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      if (inDown && inUp) {
        b.onTap();
        return true;
      }
    }
    return false;
  }

  /** True while the pointer is held over a button occupying the press point. */
  isPressed(b: ButtonDef): boolean {
    return (
      this.pressed !== null &&
      performance.now() - this.pressT < 350 &&
      this.pressX >= b.x &&
      this.pressX <= b.x + b.w &&
      this.pressY >= b.y &&
      this.pressY <= b.y + b.h
    );
  }
}
