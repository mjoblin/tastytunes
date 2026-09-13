import type { Rgb, Scene, SceneFrame, SceneKey, SceneSettingDef, SceneSettings } from "../types";
import { PresenceTracker } from "../../presence";
import { typePx, sceneFont } from "../../type";
import { clamp, mix, rgb, rgba } from "../lib";
import { BallPit, EROSION_SECONDS, WORLD_W, dropSpread, dropX, erosionPressure } from "./balls";
import {
  HIT_ONSET,
  THROW_GAP_MS,
  radiusForDrum,
  radiusForHit,
  registerForDrum,
  registerOf,
  sideOf,
} from "./model";

/**
 * BALL PIT: the beats, thrown in (after packscape's Ball Pit, in this app's
 * voice). Every drum drops a rubber ball from above the frame: a kick a
 * bass-colored boulder from the left, a hat an air-colored marble from the
 * right, a snare the middle, sized by how hard; the hits are the file's own
 * drum onsets. They bounce like they mean it, pile up,
 * and the tide takes the oldest in about a minute, the pile slumping after.
 * The current line is written on the back wall. A quiet, synthesized boing
 * per landing hides behind a toggle that is off by default.
 */
export const PIT_KEY: SceneKey = {
  reads: [
    { shows: "A ball", means: "A drum hit" },
    { shows: "Its size", means: "How hard the hit was. A kick is a boulder and a hi-hat a marble" },
    {
      shows: "Its color and side",
      means:
        "Which drum. Kicks come from the left, hi-hats from the right and snares from the middle",
    },
    { shows: "The pile", means: "The last minute of hits. The oldest are washed away" },
    { shows: "The back wall", means: "The line being sung, with the next below" },
    { shows: "A ring on the floor", means: "Each beat, wider on the first beat of a bar" },
    { shows: "The floor's glow", means: "The bass" },
    { shows: "A rain of marbles", means: "A drop" },
  ],
  honesty: [
    "A ball is a drum hit found in the audio (a hard-plucked bass can count as a kick), not a note, and where it rolls means nothing.",
  ],
};

export const PIT_SETTINGS: SceneSettingDef[] = [
  { key: "sounds", label: "Sounds", kind: "toggle", default: false, full: true },
  { key: "words", label: "Lyrics", kind: "toggle", default: true, full: true },
];

function registerColor(P: SceneFrame["palette"], register: number): Rgb {
  const t = register / 5;
  return t < 0.5
    ? mix(P.accent[0], P.accent[1], t * 2)
    : mix(P.accent[1], P.accent[2], (t - 0.5) * 2);
}

/** A tiny foley: one oscillator, a pitch that follows the ball, at most a dozen a second. */
class Foley {
  private ctx: AudioContext | null = null;
  private recent: number[] = [];
  play(r: number, impact: number): void {
    const now = performance.now();
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= 12) return;
    this.recent.push(now);
    if (!this.ctx) this.ctx = new AudioContext();
    const c = this.ctx;
    const osc = c.createOscillator();
    const gain = c.createGain();
    const hz = 520 - 28 * r;
    osc.type = "sine";
    osc.frequency.setValueAtTime(hz * 1.6, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(hz, c.currentTime + 0.08);
    const level = Math.min(0.12, 0.02 + impact / 8000);
    gain.gain.setValueAtTime(level, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0005, c.currentTime + 0.18);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.2);
  }
  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}

export class Pit implements Scene {
  settings: SceneSettings = {};
  private pit = new BallPit();
  private lastThrow = 0;
  private foley: Foley | null = null;
  private wall = new PresenceTracker(700, 1600);
  /** Rings on the floor at each beat, dust where a ball lands, and a drop's rain of marbles. */
  private beatRings: { born: number; big: boolean }[] = [];
  private dust: { x: number; y: number; vx: number; vy: number; born: number; life: number }[] = [];
  private rain = 0;
  private rainAt = 0;

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    ctx.fillStyle = rgb(P.bg);
    ctx.fillRect(0, 0, w, h);

    // a drum throws a ball, from above the frame, on its register's side: one per hit from
    // the file's own onset list, else the strip's transient when the track has none
    const groundFrac = f.mini ? 0.92 : 0.86;
    const worldPerPx = WORLD_W / w;
    const skyY = h * groundFrac * worldPerPx + 40;
    const throwBall = (register: number, r: number): void => {
      const side = sideOf(register, Math.random());
      // the stereo image leans the throw toward the side the sound sits
      const x = clamp(
        dropX(side, dropSpread(Math.random)) + f.pan * WORLD_W * 0.12,
        8,
        WORLD_W - 8,
      );
      this.pit.drop(register, r, x, Math.random, skyY);
    };
    // the beat: a ring on the floor, wider on the downbeat
    if (f.beat?.onBeat) this.beatRings.push({ born: f.now, big: f.beat.onBar });
    // a drop: a rain of marbles over the next half second
    if (f.drop?.onDrop) {
      this.rain = 14;
      this.rainAt = 0;
    }
    if (this.rain > 0 && f.now - this.rainAt > 35) {
      this.rainAt = f.now;
      this.rain--;
      this.pit.drop(
        Math.floor(Math.random() * 6),
        3 + Math.random() * 3,
        8 + Math.random() * (WORLD_W - 16),
        Math.random,
        skyY + Math.random() * 120,
      );
    }
    if (f.hitsKnown) {
      for (const hit of f.hits) {
        const register = registerForDrum(hit.type, Math.random());
        throwBall(register, radiusForDrum(hit.type, hit.strength));
      }
    } else if (f.onset > HIT_ONSET && f.now - this.lastThrow > THROW_GAP_MS && f.playing) {
      this.lastThrow = f.now;
      throwBall(registerOf(f.bands), radiusForHit(f.onset, f.loud));
    }
    const dt = f.reduced ? f.dt * 0.5 : f.dt;
    const pressure = erosionPressure(this.pit.all().length / this.pit.capacity);
    const events = this.pit.step(dt, (dt / EROSION_SECONDS) * pressure);
    // dust where a ball lands hard
    for (const l of events.landed) {
      const n = Math.min(7, 2 + Math.round(l.impact / 260));
      for (let i = 0; i < n; i++)
        this.dust.push({
          x: l.x + (Math.random() - 0.5) * l.r * 2,
          y: 0,
          vx: (Math.random() - 0.5) * 90,
          vy: 30 + Math.random() * 70,
          born: f.now,
          life: 300 + Math.random() * 250,
        });
    }
    if (this.dust.length > 160) this.dust.splice(0, this.dust.length - 160);
    if (this.settings.sounds === true && !f.mini) {
      if (!this.foley) this.foley = new Foley();
      for (const landing of events.landed) this.foley.play(landing.r, landing.impact);
    } else if (this.foley) {
      this.foley.dispose();
      this.foley = null;
    }

    // the back wall: the current line, faint, and the floor line
    const groundY = h * (f.mini ? 0.92 : 0.86);
    if (f.lyric && this.settings.words !== false) {
      const { lines, index, text } = f.lyric;
      this.wall.step(text ? [String(index)] : [], f.dt);
      sceneFont(ctx, f, "lead", 500);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (const key of this.wall.keys()) {
        const ln = lines[Number(key)]?.text;
        if (!ln) continue;
        ctx.fillStyle = rgba(P.ink, 0.22 * this.wall.get(key));
        ctx.fillText(ln, w / 2, h * 0.3);
      }
      // the next line waits below, fainter
      if (f.lyric.next) {
        sceneFont(ctx, f, "body", 400);
        ctx.fillStyle = rgba(P.ink, 0.1);
        ctx.fillText(f.lyric.next, w / 2, h * 0.3 + typePx(f, "lead") * 1.5);
      }
      ctx.textAlign = "start";
    }
    // the floor glows with the bass; the beat rings run out along it
    const floorGlow = ctx.createLinearGradient(0, groundY - h * 0.14, 0, groundY);
    floorGlow.addColorStop(0, rgba(P.accent[0], 0));
    floorGlow.addColorStop(1, rgba(P.accent[0], 0.04 + 0.18 * f.slowBands[0]));
    ctx.fillStyle = floorGlow;
    ctx.fillRect(0, groundY - h * 0.14, w, h * 0.14);
    for (let i = this.beatRings.length - 1; i >= 0; i--) {
      const ring = this.beatRings[i];
      const age = (f.now - ring.born) / 650;
      if (age >= 1) {
        this.beatRings.splice(i, 1);
        continue;
      }
      const rx = w * (0.04 + 0.46 * age) * (ring.big ? 1.15 : 1);
      ctx.strokeStyle = rgba(P.gold, (1 - age) * (ring.big ? 0.4 : 0.2));
      ctx.lineWidth = ring.big ? 1.5 : 1;
      ctx.beginPath();
      ctx.ellipse(w / 2, groundY, rx, rx * 0.05, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(P.gold, P.light ? 0.5 : 0.35);
    ctx.fillRect(0, groundY, w, Math.max(1, h * 0.002));

    // the balls: rubber squashes wide and short on impact, then relaxes; a gloss dot says rubber
    const scale = w / WORLD_W;
    for (const ball of this.pit.all()) {
      const x = ball.x * scale;
      const y = groundY - ball.y * scale;
      const r = Math.max(1.5, ball.r * scale);
      const rx = r * (1 + 0.45 * ball.squash);
      const ry = r * (1 - 0.35 * ball.squash);
      const color = registerColor(P, ball.register);
      const alpha = 0.35 + 0.65 * ball.life;
      ctx.fillStyle = rgba(mix(color, P.bg, 0.15 * (1 - ball.life)), alpha);
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba(mix(color, P.ink, 0.7), 0.45 * ball.life);
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - ry * 0.4, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
    // the dust
    const scaleD = w / WORLD_W;
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      const age = (f.now - d.born) / d.life;
      if (age >= 1) {
        this.dust.splice(i, 1);
        continue;
      }
      const t = age * (d.life / 1000);
      const x = (d.x + d.vx * t) * scaleD;
      const y = groundY - (d.vy * t - 120 * t * t) * scaleD;
      ctx.fillStyle = rgba(P.ink, 0.25 * (1 - age));
      ctx.beginPath();
      ctx.arc(x, y, 1.2 + 1.2 * (1 - age), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
