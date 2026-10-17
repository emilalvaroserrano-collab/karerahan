// Two-bone inverse kinematics for the gallop.
// The sprite still draws the horse. The rig solves the fore and hind legs
// against the ground and moves the body so those legs can actually reach:
// a ballistic rise while both hooves are off, a compression when the
// forehand lands, and a small pitch when one end is more stretched.

export interface IkPose {
  /** Pixels the body should rise (positive = up). */
  lift: number;
  /** Radians, nose-down positive for a horse facing right. */
  pitch: number;
}

/** Law of cosines. `bend` -1 puts the joint above the hip-to-hoof line. */
export function solveTwoBone(
  hipX: number,
  hipY: number,
  targetX: number,
  targetY: number,
  upper: number,
  lower: number,
  bend: number,
): { kneeX: number; kneeY: number; reach: number } {
  const dx = targetX - hipX;
  const dy = targetY - hipY;
  const dist = Math.hypot(dx, dy) || 1e-4;
  const max = upper + lower - 0.01;
  const min = Math.abs(upper - lower) + 0.01;
  const clamped = Math.min(max, Math.max(min, dist));
  const cosJoint = (upper * upper + clamped * clamped - lower * lower) / (2 * upper * clamped);
  const joint = Math.acos(Math.max(-1, Math.min(1, cosJoint)));
  const dir = Math.atan2(dy, dx) + bend * joint;
  return {
    kneeX: hipX + Math.cos(dir) * upper,
    kneeY: hipY + Math.sin(dir) * upper,
    reach: dist / (upper + lower),
  };
}

/** Hoof on the ground rolls backward; in the air it swings forward on an arc. */
function hoof(
  phase: number,
  stance0: number,
  stance1: number,
  back: number,
  front: number,
  swingLift: number,
): { x: number; y: number } {
  const p = ((phase % 1) + 1) % 1;
  let into = p - stance0;
  if (into < 0) into += 1;
  const span = stance1 >= stance0 ? stance1 - stance0 : 1 - stance0 + stance1;
  if (into <= span) {
    const t = into / span;
    return { x: front + (back - front) * t, y: 0 };
  }
  const swing = (into - span) / (1 - span);
  return {
    x: back + (front - back) * swing,
    y: -swingLift * Math.sin(swing * Math.PI),
  };
}

export function gallopPose(phase: number): IkPose {
  const p = ((phase % 1) + 1) % 1;
  // Suspension peaks on the extended frame (~0.16). Forehand lands ~0.30.
  let lift = 0;
  if (p >= 0.02 && p <= 0.3) {
    const t = (p - 0.02) / 0.28;
    lift = 7 * 4 * t * (1 - t);
  }
  if (p >= 0.28 && p <= 0.5) {
    const t = (p - 0.28) / 0.22;
    lift -= 2.6 * Math.sin(t * Math.PI);
  }

  const pass = (bodyLift: number) => {
    const shoulder = { x: 36, y: -78 - bodyLift };
    const hip = { x: -42, y: -72 - bodyLift };
    const fore = hoof(p, 0.22, 0.5, 6, 64, 28);
    const hind = hoof(p, 0.52, 0.84, -80, -26, 22);
    return {
      fore: solveTwoBone(shoulder.x, shoulder.y, fore.x, fore.y, 40, 42, -1),
      hind: solveTwoBone(hip.x, hip.y, hind.x, hind.y, 42, 44, -1),
    };
  };

  let legs = pass(lift);
  const stretch = Math.max(legs.fore.reach, legs.hind.reach);
  if (stretch > 0.98) {
    lift -= Math.min(2, (stretch - 0.98) * 28);
    legs = pass(lift);
  }

  // Nose down when the foreleg is the one working, nose up on the hind push.
  const pitch = Math.max(-0.022, Math.min(0.022, (legs.fore.reach - legs.hind.reach) * 0.05));
  return { lift: Math.max(-4, Math.min(8, lift)), pitch };
}
