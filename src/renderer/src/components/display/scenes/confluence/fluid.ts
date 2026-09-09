import * as THREE from "three";

/**
 * THE WATER: a real-time incompressible fluid on the GPU (after packscape's
 * confluence/fluid.ts, which is Stam's stable fluids the way every WebGL
 * fluid since has done it). A velocity field and a dye field in ping-pong
 * render targets, advected semi-Lagrangian along the velocity, vorticity
 * confinement to keep the swirls alive, a Jacobi pressure solve to keep the
 * flow divergence-free. Nothing here knows what a register is; the scene
 * decides what goes in (model.ts) and this decides how it moves.
 *
 * Two grids: velocity is coarse (it only has to be smooth), dye is finer (it
 * is what you look at); both half-float and linearly filtered, the filtering
 * being the advection's interpolation. Added for this app: a TEXT STAMP pass
 * (a line of words becomes ink) and a display that adds ink to the faceplate
 * or soaks it into paper. No pow() in any shader here: the law.
 */
const BASE_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform vec2 texelSize;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
void main() {
  vUv = uv;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEADER = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
`;

/**
 * THE OBSTACLE: a mask of solid cells (the words' letters) the fluid must flow around. Where a
 * cell is solid the velocity and the dye are held at zero, the pressure solve treats a solid
 * neighbour as a wall (it takes the cell's own pressure, so nothing pushes through), and the
 * gradient step never leaves a component of velocity pointing into a wall. The mask is the
 * words' texture over its box in 0..1 (y up); off, every cell is open.
 */
const OBSTACLE = `
uniform sampler2D uObstacle;
uniform vec2 uObstacleOrigin;
uniform vec2 uObstacleSize;
uniform float uObstacleOn;
float solid(vec2 uv) {
  if (uObstacleOn < 0.5) return 0.0;
  vec2 q = (uv - uObstacleOrigin) / uObstacleSize;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return 0.0;
  return step(0.5, texture2D(uObstacle, q).a);
}
`;

const CLEAR_FRAGMENT = `${HEADER}
uniform sampler2D uTexture;
uniform float value;
void main() { gl_FragColor = value * texture2D(uTexture, vUv); }`;

const SPLAT_FRAGMENT = `${HEADER}${OBSTACLE}
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main() {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color * (1.0 - solid(vUv));
  vec3 base = texture2D(uTarget, vUv).xyz;
  gl_FragColor = vec4(base + splat, 1.0);
}`;

const VORTEX_FRAGMENT = `${HEADER}
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec2 point;
uniform float radius;
uniform float spin;
void main() {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  float r2 = dot(p, p);
  vec2 tangent = vec2(-p.y, p.x) * (1.0 / sqrt(radius));
  vec2 add = tangent * spin * exp(-r2 / radius);
  vec2 base = texture2D(uTarget, vUv).xy;
  gl_FragColor = vec4(base + add, 0.0, 1.0);
}`;

/** A line of words, stamped as ink: the text texture's coverage times a color, over a box. */
const TEXT_FRAGMENT = `${HEADER}
uniform sampler2D uTarget;
uniform sampler2D uText;
uniform vec3 color;
uniform vec2 origin;
uniform vec2 size;
void main() {
  vec2 q = (vUv - origin) / size;
  vec3 base = texture2D(uTarget, vUv).xyz;
  float a = 0.0;
  if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) a = texture2D(uText, q).a;
  gl_FragColor = vec4(base + color * a, 1.0);
}`;

const ADVECTION_FRAGMENT = `${HEADER}${OBSTACLE}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 velocityTexel;
uniform float dt;
uniform float dissipation;
void main() {
  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * velocityTexel;
  vec4 result = texture2D(uSource, coord);
  float decay = 1.0 + dissipation * dt;
  // inside a solid nothing moves and nothing collects
  gl_FragColor = (result / decay) * (1.0 - solid(vUv));
}`;

const DIVERGENCE_FRAGMENT = `${HEADER}
uniform sampler2D uVelocity;
void main() {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const CURL_FRAGMENT = `${HEADER}
uniform sampler2D uVelocity;
void main() {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

const VORTICITY_FRAGMENT = `${HEADER}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity += force * dt;
  velocity = min(max(velocity, -1000.0), 1000.0);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;

const PRESSURE_FRAGMENT = `${HEADER}${OBSTACLE}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float C = texture2D(uPressure, vUv).x;
  // a solid neighbour is a wall: it takes this cell's own pressure, so nothing pushes through
  float L = mix(texture2D(uPressure, vL).x, C, solid(vL));
  float R = mix(texture2D(uPressure, vR).x, C, solid(vR));
  float T = mix(texture2D(uPressure, vT).x, C, solid(vT));
  float B = mix(texture2D(uPressure, vB).x, C, solid(vB));
  float divergence = texture2D(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUBTRACT_FRAGMENT = `${HEADER}${OBSTACLE}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float C = texture2D(uPressure, vUv).x;
  float sL = solid(vL);
  float sR = solid(vR);
  float sT = solid(vT);
  float sB = solid(vB);
  float L = mix(texture2D(uPressure, vL).x, C, sL);
  float R = mix(texture2D(uPressure, vR).x, C, sR);
  float T = mix(texture2D(uPressure, vT).x, C, sT);
  float B = mix(texture2D(uPressure, vB).x, C, sB);
  vec2 velocity = texture2D(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  // no component of velocity points into a wall, and a solid cell holds still
  velocity.x = mix(velocity.x, max(velocity.x, 0.0), sL);
  velocity.x = mix(velocity.x, min(velocity.x, 0.0), sR);
  velocity.y = mix(velocity.y, max(velocity.y, 0.0), sB);
  velocity.y = mix(velocity.y, min(velocity.y, 0.0), sT);
  velocity *= 1.0 - solid(vUv);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;

/** The picture: ink over the faceplate's deep water, lit from the front by
 *  its own gradient so it reads as ink IN water; on paper the same ink soaks
 *  in and darkens. Soft-clipped so piled ink brightens without flattening. */
const DISPLAY_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DISPLAY_FRAGMENT = `
precision highp float;
uniform sampler2D uDye;
uniform vec2 dyeTexel;
uniform vec3 uWater;
uniform float uLight;
uniform float uExposure;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uDye, vUv).rgb;
  vec3 lc = texture2D(uDye, vUv - vec2(dyeTexel.x, 0.0)).rgb;
  vec3 rc = texture2D(uDye, vUv + vec2(dyeTexel.x, 0.0)).rgb;
  vec3 tc = texture2D(uDye, vUv + vec2(0.0, dyeTexel.y)).rgb;
  vec3 bc = texture2D(uDye, vUv - vec2(0.0, dyeTexel.y)).rgb;
  float dx = length(rc) - length(lc);
  float dy = length(tc) - length(bc);
  vec3 n = normalize(vec3(dx, dy, length(dyeTexel) * 2.5));
  float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.72, 0.72, 1.0);
  vec3 ink = c * uExposure;
  float m = max(ink.r, max(ink.g, ink.b));
  float clipped = m / (1.0 + m * 0.6);
  vec3 keepHue = ink * (clipped / max(m, 0.0001));
  vec3 perChannel = ink / (1.0 + ink * 0.6);
  ink = mix(keepHue, perChannel, 0.25);
  vec3 lit = uWater + ink * diffuse;
  // on paper the ink keeps its hue and darkens the page where it lies
  float cover = clamp(length(ink) * 0.9, 0.0, 0.85);
  vec3 hue = ink / max(m, 0.0001);
  vec3 soaked = mix(uWater, hue * (0.42 + 0.18 * diffuse), cover);
  gl_FragColor = vec4(mix(lit, soaked, uLight), 1.0);
}`;

interface DoubleTarget {
  readonly read: THREE.WebGLRenderTarget;
  readonly write: THREE.WebGLRenderTarget;
  texelSize: THREE.Vector2;
  swap(): void;
  dispose(): void;
}

function makeTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function makeDouble(width: number, height: number): DoubleTarget {
  let read = makeTarget(width, height);
  let write = makeTarget(width, height);
  return {
    get read() {
      return read;
    },
    get write() {
      return write;
    },
    texelSize: new THREE.Vector2(1 / width, 1 / height),
    swap() {
      const held = read;
      read = write;
      write = held;
    },
    dispose() {
      read.dispose();
      write.dispose();
    },
  };
}

export interface FluidParams {
  velocityDissipation: number;
  dyeDissipation: number;
  curl: number;
  pressureIterations: number;
}

export const DEFAULT_PARAMS: FluidParams = {
  velocityDissipation: 0.7,
  dyeDissipation: 0.07,
  curl: 14,
  pressureIterations: 20,
};

export const SIM_HEIGHT = 224;
export const DYE_HEIGHT = 720;

interface PendingSplat {
  x: number;
  y: number;
  dx: number;
  dy: number;
  radius: number;
  color: THREE.Color;
  ink: number;
}
interface PendingVortex {
  x: number;
  y: number;
  spin: number;
  radius: number;
}
interface PendingText {
  texture: THREE.Texture;
  cx: number;
  cy: number;
  w: number;
  h: number;
  color: THREE.Color;
  ink: number;
}

const tex = (): THREE.IUniform<THREE.Texture | null> => ({ value: null });
const uv2 = (): THREE.IUniform<THREE.Vector2> => ({ value: new THREE.Vector2() });

export class Fluid {
  private velocity: DoubleTarget;
  private dye: DoubleTarget;
  private pressure: DoubleTarget;
  private divergence: THREE.WebGLRenderTarget;
  private curl: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly quad: THREE.Mesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);

  private readonly clearU = { texelSize: uv2(), uTexture: tex(), value: { value: 0.8 } };
  private readonly splatU = {
    texelSize: uv2(),
    uTarget: tex(),
    aspectRatio: { value: 1 },
    color: { value: new THREE.Vector3() },
    point: { value: new THREE.Vector2() },
    radius: { value: 0.01 },
  };
  private readonly vortexU = {
    texelSize: uv2(),
    uTarget: tex(),
    aspectRatio: { value: 1 },
    point: { value: new THREE.Vector2() },
    radius: { value: 0.01 },
    spin: { value: 0 },
  };
  private readonly textU = {
    texelSize: uv2(),
    uTarget: tex(),
    uText: tex(),
    color: { value: new THREE.Vector3() },
    origin: { value: new THREE.Vector2() },
    size: { value: new THREE.Vector2(1, 1) },
  };
  private readonly advectionU = {
    texelSize: uv2(),
    uVelocity: tex(),
    uSource: tex(),
    velocityTexel: uv2(),
    dt: { value: 0 },
    dissipation: { value: 0 },
  };
  private readonly divergenceU = { texelSize: uv2(), uVelocity: tex() };
  private readonly curlU = { texelSize: uv2(), uVelocity: tex() };
  private readonly vorticityU = {
    texelSize: uv2(),
    uVelocity: tex(),
    uCurl: tex(),
    curl: { value: 0 },
    dt: { value: 0 },
  };
  private readonly pressureU = { texelSize: uv2(), uPressure: tex(), uDivergence: tex() };
  private readonly gradientU = { texelSize: uv2(), uPressure: tex(), uVelocity: tex() };
  /** The obstacle mask, shared by the passes that respect it (one set of uniform objects). */
  private readonly obstacleU = {
    uObstacle: tex(),
    uObstacleOrigin: { value: new THREE.Vector2() },
    uObstacleSize: { value: new THREE.Vector2(1, 1) },
    uObstacleOn: { value: 0 },
  };
  private readonly displayU = {
    uDye: tex(),
    dyeTexel: uv2(),
    uWater: { value: new THREE.Color(0.05, 0.05, 0.04) },
    uLight: { value: 0 },
    uExposure: { value: 1.25 },
  };

  private readonly materials: Record<string, THREE.RawShaderMaterial>;
  readonly displayMaterial: THREE.ShaderMaterial;

  private aspect: number;
  private pendingSplats: PendingSplat[] = [];
  private pendingVortices: PendingVortex[] = [];
  private pendingText: PendingText[] = [];
  private readonly splatColor = new THREE.Color();

  constructor(
    aspect: number,
    /** Grid scale: the picker's tile runs a quarter-size water. */
    private readonly scale = 1,
  ) {
    this.aspect = Math.max(aspect, 0.2);
    const [simW, simH] = this.simSize();
    const [dyeW, dyeH] = this.dyeSize();
    this.velocity = makeDouble(simW, simH);
    this.pressure = makeDouble(simW, simH);
    this.dye = makeDouble(dyeW, dyeH);
    this.divergence = makeTarget(simW, simH);
    this.curl = makeTarget(simW, simH);
    const raw = (
      fragment: string,
      uniforms: Record<string, THREE.IUniform>,
    ): THREE.RawShaderMaterial =>
      new THREE.RawShaderMaterial({
        vertexShader: BASE_VERTEX,
        fragmentShader: fragment,
        uniforms,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      });
    this.materials = {
      clear: raw(CLEAR_FRAGMENT, this.clearU),
      splat: raw(SPLAT_FRAGMENT, { ...this.splatU, ...this.obstacleU }),
      vortex: raw(VORTEX_FRAGMENT, this.vortexU),
      text: raw(TEXT_FRAGMENT, this.textU),
      advection: raw(ADVECTION_FRAGMENT, { ...this.advectionU, ...this.obstacleU }),
      divergence: raw(DIVERGENCE_FRAGMENT, this.divergenceU),
      curl: raw(CURL_FRAGMENT, this.curlU),
      vorticity: raw(VORTICITY_FRAGMENT, this.vorticityU),
      pressure: raw(PRESSURE_FRAGMENT, { ...this.pressureU, ...this.obstacleU }),
      gradient: raw(GRADIENT_SUBTRACT_FRAGMENT, { ...this.gradientU, ...this.obstacleU }),
    };
    this.displayU.uDye.value = this.dye.read.texture;
    this.displayU.dyeTexel.value.copy(this.dye.texelSize);
    this.displayMaterial = new THREE.ShaderMaterial({
      vertexShader: DISPLAY_VERTEX,
      fragmentShader: DISPLAY_FRAGMENT,
      uniforms: this.displayU,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(this.geometry, this.materials.clear);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private simSize(): [number, number] {
    const rows = Math.max(32, Math.round(SIM_HEIGHT * this.scale));
    return [Math.max(16, Math.round(rows * this.aspect)), rows];
  }
  private dyeSize(): [number, number] {
    const rows = Math.max(64, Math.round(DYE_HEIGHT * this.scale));
    return [Math.max(16, Math.round(rows * this.aspect)), rows];
  }

  /** Follow the stage's aspect; the water starts clear when it really moved. */
  resize(aspect: number): void {
    const next = Math.max(aspect, 0.2);
    if (Math.abs(next - this.aspect) < 0.01) return;
    this.aspect = next;
    const [simW, simH] = this.simSize();
    const [dyeW, dyeH] = this.dyeSize();
    this.velocity.dispose();
    this.pressure.dispose();
    this.dye.dispose();
    this.divergence.dispose();
    this.curl.dispose();
    this.velocity = makeDouble(simW, simH);
    this.pressure = makeDouble(simW, simH);
    this.dye = makeDouble(dyeW, dyeH);
    this.divergence = makeTarget(simW, simH);
    this.curl = makeTarget(simW, simH);
    this.displayU.dyeTexel.value.copy(this.dye.texelSize);
  }

  /** Queue a push of ink: x, y in 0..1 with y up, velocity in field units per second. */
  splat(
    x: number,
    y: number,
    dx: number,
    dy: number,
    radius: number,
    color: THREE.Color,
    ink: number,
  ): void {
    this.pendingSplats.push({ x, y, dx, dy, radius, color: color.clone(), ink });
  }
  vortex(x: number, y: number, spin: number, radius: number): void {
    this.pendingVortices.push({ x, y, spin, radius });
  }
  /** Queue a line of words: a texture whose alpha is the letters, over a box (0..1, y up). */
  stampText(
    texture: THREE.Texture,
    cx: number,
    cy: number,
    w: number,
    h: number,
    color: THREE.Color,
    ink: number,
  ): void {
    this.pendingText.push({ texture, cx, cy, w, h, color: color.clone(), ink });
  }
  /** The latest dye and velocity, for a layer drawn over the water (the words) to read. */
  get dyeTexture(): THREE.Texture {
    return this.dye.read.texture;
  }
  get velocityTexture(): THREE.Texture {
    return this.velocity.read.texture;
  }
  /** The solid the fluid flows around: a texture whose alpha is the shape, over a box (0..1, y up); null opens every cell. */
  setObstacle(texture: THREE.Texture | null, cx: number, cy: number, w: number, h: number): void {
    const u = this.obstacleU;
    u.uObstacleOn.value = texture ? 1 : 0;
    if (!texture) return;
    u.uObstacle.value = texture;
    u.uObstacleOrigin.value.set(cx - w / 2, cy - h / 2);
    u.uObstacleSize.value.set(Math.max(w, 0.0001), Math.max(h, 0.0001));
  }
  setWater(color: THREE.Color, light: boolean): void {
    this.displayU.uWater.value.copy(color);
    this.displayU.uLight.value = light ? 1 : 0;
  }
  setExposure(exposure: number): void {
    this.displayU.uExposure.value = exposure;
  }

  /** One frame: apply what has been queued, then advance the water. Leaves the renderer as found. */
  step(gl: THREE.WebGLRenderer, dt: number, params: FluidParams): void {
    const previousTarget = gl.getRenderTarget();
    const previousAutoClear = gl.autoClear;
    gl.autoClear = false;
    for (const s of this.pendingSplats) this.applySplat(gl, s);
    this.pendingSplats.length = 0;
    for (const v of this.pendingVortices) this.applyVortex(gl, v);
    this.pendingVortices.length = 0;
    for (const t of this.pendingText) this.applyText(gl, t);
    this.pendingText.length = 0;

    const velTexel = this.velocity.texelSize;
    this.curlU.uVelocity.value = this.velocity.read.texture;
    this.blit(gl, this.curl, this.materials.curl, velTexel);
    this.vorticityU.uVelocity.value = this.velocity.read.texture;
    this.vorticityU.uCurl.value = this.curl.texture;
    this.vorticityU.curl.value = params.curl;
    this.vorticityU.dt.value = dt;
    this.blit(gl, this.velocity.write, this.materials.vorticity, velTexel);
    this.velocity.swap();
    this.divergenceU.uVelocity.value = this.velocity.read.texture;
    this.blit(gl, this.divergence, this.materials.divergence, velTexel);
    this.clearU.uTexture.value = this.pressure.read.texture;
    this.clearU.value.value = 0.8;
    this.blit(gl, this.pressure.write, this.materials.clear, velTexel);
    this.pressure.swap();
    this.pressureU.uDivergence.value = this.divergence.texture;
    for (let i = 0; i < params.pressureIterations; i++) {
      this.pressureU.uPressure.value = this.pressure.read.texture;
      this.blit(gl, this.pressure.write, this.materials.pressure, velTexel);
      this.pressure.swap();
    }
    this.gradientU.uPressure.value = this.pressure.read.texture;
    this.gradientU.uVelocity.value = this.velocity.read.texture;
    this.blit(gl, this.velocity.write, this.materials.gradient, velTexel);
    this.velocity.swap();
    this.advectionU.velocityTexel.value.copy(velTexel);
    this.advectionU.dt.value = dt;
    this.advectionU.uVelocity.value = this.velocity.read.texture;
    this.advectionU.uSource.value = this.velocity.read.texture;
    this.advectionU.dissipation.value = params.velocityDissipation;
    this.blit(gl, this.velocity.write, this.materials.advection, velTexel);
    this.velocity.swap();
    this.advectionU.uVelocity.value = this.velocity.read.texture;
    this.advectionU.uSource.value = this.dye.read.texture;
    this.advectionU.dissipation.value = params.dyeDissipation;
    this.blit(gl, this.dye.write, this.materials.advection, this.dye.texelSize);
    this.dye.swap();
    this.displayU.uDye.value = this.dye.read.texture;
    gl.setRenderTarget(previousTarget);
    gl.autoClear = previousAutoClear;
  }

  private applySplat(gl: THREE.WebGLRenderer, s: PendingSplat): void {
    const u = this.splatU;
    u.aspectRatio.value = this.aspect;
    u.point.value.set(s.x, s.y);
    u.radius.value = s.radius;
    u.uTarget.value = this.velocity.read.texture;
    u.color.value.set(s.dx, s.dy, 0);
    this.blit(gl, this.velocity.write, this.materials.splat, this.velocity.texelSize);
    this.velocity.swap();
    if (s.ink > 0) {
      u.uTarget.value = this.dye.read.texture;
      this.splatColor.copy(s.color).multiplyScalar(s.ink);
      u.color.value.set(this.splatColor.r, this.splatColor.g, this.splatColor.b);
      this.blit(gl, this.dye.write, this.materials.splat, this.dye.texelSize);
      this.dye.swap();
    }
  }

  private applyVortex(gl: THREE.WebGLRenderer, v: PendingVortex): void {
    const u = this.vortexU;
    u.aspectRatio.value = this.aspect;
    u.point.value.set(v.x, v.y);
    u.radius.value = v.radius;
    u.spin.value = v.spin;
    u.uTarget.value = this.velocity.read.texture;
    this.blit(gl, this.velocity.write, this.materials.vortex, this.velocity.texelSize);
    this.velocity.swap();
  }

  private applyText(gl: THREE.WebGLRenderer, t: PendingText): void {
    const u = this.textU;
    u.uTarget.value = this.dye.read.texture;
    u.uText.value = t.texture;
    u.origin.value.set(t.cx - t.w / 2, t.cy - t.h / 2);
    u.size.value.set(t.w, t.h);
    this.splatColor.copy(t.color).multiplyScalar(t.ink);
    u.color.value.set(this.splatColor.r, this.splatColor.g, this.splatColor.b);
    this.blit(gl, this.dye.write, this.materials.text, this.dye.texelSize);
    this.dye.swap();
  }

  private blit(
    gl: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    material: THREE.RawShaderMaterial,
    texelSize: THREE.Vector2,
  ): void {
    const texel = material.uniforms.texelSize as THREE.IUniform<THREE.Vector2> | undefined;
    texel?.value.copy(texelSize);
    this.quad.material = material;
    gl.setRenderTarget(target);
    gl.render(this.scene, this.camera);
  }

  dispose(): void {
    this.velocity.dispose();
    this.pressure.dispose();
    this.dye.dispose();
    this.divergence.dispose();
    this.curl.dispose();
    this.geometry.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
    this.displayMaterial.dispose();
  }
}
