/**
 * THE PIT: real physics, small rubber balls (after packscape's Ball Pit, whose
 * material won its own argument: "bouncy rubber balls, and I really like
 * these bouncy rubber balls"). Verlet circles with a spatial hash and SLEEP
 * STATES: settled balls freeze until an impact or a removal wakes them, so
 * the live simulation is only the few dozen moving at any moment.
 * Substepped at 240 Hz because entry speeds cover several radii per frame.
 * No canvas, no audio and no Math.random in here: the scene injects the
 * randomness, draws what this computes, and plays the events `step` reports.
 */
export const WORLD_W = 1000;
export const GRAVITY = 1150;
const RESTITUTION = 0.45;
const WALL_RESTITUTION = 0.6;
/** Rolling resistance as a constant deceleration (units/s²): long rollouts and steep piles. */
const ROLL_DECEL = 150;
const SLEEP_SPEED = 7;
const SLEEP_AFTER = 0.45;
const WAKE_IMPACT = 30;
const SOUND_IMPACT = 40;
const SLIDE_SPEED = 16;
export const MAX_BALLS = 600;
/** How long a ball lasts, in seconds; the pit turns over faster as it fills. */
export const EROSION_SECONDS = 70;
const TERMINAL = 820;
const NOMINAL_SUB = 1 / 240;
const CELL = 18;

export interface Ball {
  /** The register that threw it, 0..5. */
  register: number;
  x: number;
  y: number;
  px: number;
  py: number;
  r: number;
  life: number;
  asleep: boolean;
  still: number;
  contact: boolean;
  /** 0..1 impact squash, set on a hard landing and relaxed by step. */
  squash: number;
}

export interface BallEvents {
  landed: { r: number; x: number; impact: number }[];
  slid: { r: number; speed: number }[];
}

/** Where a drop lands for a side, with a triangular spread so each side piles into a dune. */
export function dropX(side: "left" | "right", spread: number): number {
  return side === "right" ? WORLD_W * (0.74 + spread * 0.42) : WORLD_W * (0.26 + spread * 0.42);
}
export function dropSpread(random: () => number): number {
  return (random() + random() - 1) * 0.38;
}
/** The fuller the pit, the faster the tide takes its oldest. */
export function erosionPressure(fill: number): number {
  return 1 + 3 * Math.min(Math.max(fill, 0), 1) ** 2;
}

const cellKey = (x: number, y: number): number =>
  Math.floor(x / CELL) * 100_000 + Math.floor(y / CELL);

export class BallPit {
  readonly balls: Ball[] = [];
  constructor(readonly capacity: number = MAX_BALLS) {}

  /** Drop a ball from above the frame at x; it enters by falling into view. */
  drop(register: number, r: number, x: number, random: () => number, fromY = 340): void {
    if (this.balls.length >= this.capacity) this.remove(0);
    const y = fromY + random() * 60;
    this.balls.push(
      this.make(register, r, Math.min(WORLD_W - r, Math.max(r, x)), y, (random() - 0.5) * 30, 0),
    );
  }

  private make(register: number, r: number, x: number, y: number, vx: number, vy: number): Ball {
    return {
      register,
      x,
      y,
      px: x - vx * NOMINAL_SUB,
      py: y - vy * NOMINAL_SUB,
      r,
      life: 1,
      asleep: false,
      still: 0,
      contact: false,
      squash: 0,
    };
  }

  step(dt: number, decay = dt / EROSION_SECONDS): BallEvents {
    const events: BallEvents = { landed: [], slid: [] };
    if (dt <= 0) return events;
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      ball.life -= decay;
      if (ball.squash > 0) ball.squash = Math.max(0, ball.squash - dt * 6);
      if (ball.life <= 0) this.remove(i);
    }
    const substeps = Math.min(8, Math.max(1, Math.ceil(dt / (1 / 240))));
    const sub = dt / substeps;
    for (let s = 0; s < substeps; s++) this.substep(sub, events);
    return events;
  }

  private substep(dt: number, events: BallEvents): void {
    const hash = this.buildHash();
    for (const ball of this.balls) {
      if (ball.asleep) continue;
      const wasInContact = ball.contact;
      const fallSpeed = Math.abs(ball.y - ball.py) / dt;
      const vx = ball.x - ball.px;
      const vy = ball.y - ball.py;
      ball.px = ball.x;
      ball.py = ball.y;
      ball.x += vx;
      ball.y += Math.max(vy - GRAVITY * dt * dt, -TERMINAL * dt);
      if (Math.abs(ball.x - ball.px) + Math.abs(ball.y - ball.py) > 0.05)
        this.wakeRestingOn(ball, hash);
      ball.contact = false;
      this.collide(ball, hash, dt);
      if (ball.contact && !wasInContact && fallSpeed > SOUND_IMPACT) {
        events.landed.push({ r: ball.r, x: ball.x, impact: fallSpeed });
        ball.squash = Math.min(1, fallSpeed / 700);
      }
      const slideSpeed = Math.abs(ball.x - ball.px) / dt;
      if (ball.contact && wasInContact && slideSpeed > SLIDE_SPEED)
        events.slid.push({ r: ball.r, speed: slideSpeed });
      const speed = Math.hypot(ball.x - ball.px, ball.y - ball.py) / dt;
      if (ball.contact && speed < SLEEP_SPEED) {
        ball.still += dt;
        if (ball.still >= SLEEP_AFTER) {
          ball.asleep = true;
          ball.px = ball.x;
          ball.py = ball.y;
        }
      } else ball.still = 0;
    }
  }

  all(): readonly Ball[] {
    return this.balls;
  }

  clear(): void {
    this.balls.length = 0;
  }

  private remove(index: number): void {
    const gone = this.balls[index];
    this.balls.splice(index, 1);
    const reach = gone.r * 2.6;
    for (const other of this.balls) {
      if (!other.asleep) continue;
      const dx = other.x - gone.x;
      const dy = other.y - gone.y;
      const limit = reach + other.r;
      if (dx * dx + dy * dy < limit * limit) {
        other.asleep = false;
        other.still = 0;
      }
    }
  }

  private wakeRestingOn(ball: Ball, hash: Map<number, number[]>): void {
    const cx = Math.floor(ball.px / CELL);
    const cy = Math.floor(ball.py / CELL);
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const cell = hash.get((cx + ox) * 100_000 + (cy + oy));
        if (!cell) continue;
        for (const j of cell) {
          const other = this.balls[j];
          if (!other || !other.asleep || other.y <= ball.py) continue;
          const dx = other.x - ball.px;
          const dy = other.y - ball.py;
          const reach = ball.r + other.r + 1;
          if (dx * dx + dy * dy < reach * reach) {
            other.asleep = false;
            other.still = 0;
          }
        }
      }
  }

  private buildHash(): Map<number, number[]> {
    const hash = new Map<number, number[]>();
    for (let i = 0; i < this.balls.length; i++) {
      const key = cellKey(this.balls[i].x, this.balls[i].y);
      const cell = hash.get(key);
      if (cell) cell.push(i);
      else hash.set(key, [i]);
    }
    return hash;
  }

  private collide(ball: Ball, hash: Map<number, number[]>, dt: number): void {
    if (ball.y < ball.r) {
      const vy = ball.y - ball.py;
      const vx = ball.x - ball.px;
      ball.y = ball.r;
      ball.py = ball.y + vy * RESTITUTION;
      const kept = Math.max(0, Math.abs(vx) - ROLL_DECEL * dt * dt);
      ball.px = ball.x - Math.sign(vx) * kept;
      ball.contact = true;
    }
    if (ball.x < ball.r) {
      const vx = ball.x - ball.px;
      ball.x = ball.r;
      if (vx < 0) ball.px = ball.x + vx * WALL_RESTITUTION;
      ball.py = ball.y - (ball.y - ball.py) * 0.9;
      ball.contact = true;
    } else if (ball.x > WORLD_W - ball.r) {
      const vx = ball.x - ball.px;
      ball.x = WORLD_W - ball.r;
      if (vx > 0) ball.px = ball.x + vx * WALL_RESTITUTION;
      ball.py = ball.y - (ball.y - ball.py) * 0.9;
      ball.contact = true;
    }
    const cx = Math.floor(ball.x / CELL);
    const cy = Math.floor(ball.y / CELL);
    const speed = Math.hypot(ball.x - ball.px, ball.y - ball.py) / dt;
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const cell = hash.get((cx + ox) * 100_000 + (cy + oy));
        if (!cell) continue;
        for (const j of cell) {
          const other = this.balls[j];
          if (!other || other === ball) continue;
          const dx = ball.x - other.x;
          const dy = ball.y - other.y;
          const min = ball.r + other.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const overlap = min - d;
          const nx = dx / d;
          const ny = dy / d;
          if (other.asleep) {
            const wedgedOnWall =
              (ball.x <= ball.r + 0.5 && nx < 0) || (ball.x >= WORLD_W - ball.r - 0.5 && nx > 0);
            if (speed > WAKE_IMPACT || wedgedOnWall) {
              other.asleep = false;
              other.still = 0;
              ball.x += nx * overlap * 0.7;
              ball.y += ny * overlap * 0.7;
              other.x -= nx * overlap * 0.3;
              other.y -= ny * overlap * 0.3;
            } else {
              ball.x += nx * overlap;
              ball.y += ny * overlap;
            }
            if (ny > 0.3) {
              const vx = ball.x - ball.px;
              const vy = ball.y - ball.py;
              ball.px = ball.x - vx * 0.5;
              if (vy < 0) ball.py = ball.y + vy * RESTITUTION;
            }
          } else {
            ball.x += nx * overlap * 0.5;
            ball.y += ny * overlap * 0.5;
            other.x -= nx * overlap * 0.5;
            other.y -= ny * overlap * 0.5;
          }
          if (ny > 0.3) ball.contact = true;
        }
      }
  }
}
