/**
 * THE CATHODE FINISH. A display-wide post pass in the faceplate's voice: the picture is
 * shown through the glass of an old tube, with scanlines, a slight curve, phosphors that
 * converge imperfectly toward the edges and leak a little light into their neighbours,
 * and a vignette where the tube's edge falls away.
 *
 * It is its own WebGL2 canvas laid over the stage, not a pass inside any one scene: the
 * stage draws 2D scenes, raw GL scenes and three.js scenes, each on its own canvas with
 * an optional 2D overlay for words, and the glass must sit over all of them the same way.
 * Each frame the scene canvas (and the overlay, when there is one) are uploaded as
 * textures, which Chromium does as a copy on the GPU, and one triangle draws the result.
 * A frame's drawing buffer is intact until the compositor takes it, so uploading right
 * after the scene draws needs no preserveDrawingBuffer. No pow() anywhere.
 */

/** The barrel's strength by name: deep is the original look, gentle about a real tube's. */
export const CATHODE_CURVES: Record<string, number> = { gentle: 0.05, deep: 0.09 };

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  // one triangle covers the viewport; uv runs 0..1 inside it
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uOverlay;
uniform float uHasOverlay;
uniform vec2 uSize;
uniform float uTime;
uniform float uFlicker;
uniform float uCurve;
uniform float uScale;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  // the glass: a barrel (uCurve, 0.09 deep or 0.05 gentle), the picture bulging toward the
  // viewer; uScale overscans it so the edges meet the frame (Fill); black past its edge
  vec2 uv = (p * (1.0 + uCurve * r2) * uScale) * 0.5 + 0.5;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  // the glass has rounded corners and darkens toward its edge
  vec2 corner = abs(p) - vec2(0.88);
  float edge = length(max(corner, 0.0)) - 0.12;
  inside *= 1.0 - smoothstep(-0.01, 0.005, edge);
  // the phosphors converge imperfectly toward the edge: red and blue part by a pixel or two
  vec2 fringe = p * r2 * (3.0 / uSize);
  vec3 col;
  col.r = texture(uScene, uv + fringe).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - fringe).b;
  // the words and marks of the 2D overlay, premultiplied
  if (uHasOverlay > 0.5) {
    vec4 ov = texture(uOverlay, uv);
    col = col * (1.0 - ov.a) + ov.rgb;
  }
  // phosphor glow: light leaks a little into the neighbours
  vec2 px = 2.5 / uSize;
  vec3 leak = texture(uScene, uv + vec2(px.x, 0.0)).rgb + texture(uScene, uv - vec2(px.x, 0.0)).rgb
    + texture(uScene, uv + vec2(0.0, px.y)).rgb + texture(uScene, uv - vec2(0.0, px.y)).rgb;
  col += leak * 0.05;
  // scanlines, one every four device pixels, on the glass rather than in the picture
  float line = 0.5 + 0.5 * sin(gl_FragCoord.y * 1.5707963);
  col *= 0.62 + 0.38 * line;
  // an aperture grille: each phosphor brighter on its own column, the mean unchanged
  float c = mod(gl_FragCoord.x, 3.0);
  vec3 grille = vec3(step(c, 1.0), step(1.0, c) * step(c, 2.0), step(2.0, c));
  col *= 0.85 + 0.45 * grille;
  // the tube's edge
  col *= 1.0 - 0.75 * smoothstep(0.3, 1.9, r2);
  col *= 1.0 - 0.6 * smoothstep(-0.15, 0.0, edge);
  // a sheen on the glass, upper left
  col += vec3(0.05) * (1.0 - smoothstep(0.1, 1.5, length(p - vec2(-0.6, 0.7))));
  // a breath of mains hum in the brightness (none under reduced motion)
  col *= 1.0 + uFlicker * 0.03 * sin(uTime * 62.8);
  // the lines and the grille take light; give it back
  col *= 1.12;
  outColor = vec4(col * inside, 1.0);
}
`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[cathode] shader failed:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export class CathodeFinish {
  readonly canvas: HTMLCanvasElement;
  /** False when the machine gave no context or the program failed; render() then does nothing. */
  readonly ok: boolean;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private scene: WebGLTexture | null = null;
  private overlay: WebGLTexture | null = null;
  private uSize: WebGLUniformLocation | null = null;
  private uTime: WebGLUniformLocation | null = null;
  private uFlicker: WebGLUniformLocation | null = null;
  private uHasOverlay: WebGLUniformLocation | null = null;
  private uCurve: WebGLUniformLocation | null = null;
  private uScale: WebGLUniformLocation | null = null;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pointer-events-none absolute inset-0 block h-full w-full";
    this.canvas.dataset.displayFinish = "cathode";
    parent.appendChild(this.canvas);
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.ok = gl ? this.setup(gl) : false;
  }

  private setup(gl: WebGL2RenderingContext): boolean {
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return false;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[cathode] link failed:", gl.getProgramInfoLog(program));
      return false;
    }
    gl.useProgram(program);
    const texture = (): WebGLTexture | null => {
      const t = gl.createTexture();
      if (!t) return null;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.scene = texture();
    this.overlay = texture();
    if (!this.scene || !this.overlay) return false;
    gl.uniform1i(gl.getUniformLocation(program, "uScene"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uOverlay"), 1);
    this.uSize = gl.getUniformLocation(program, "uSize");
    this.uTime = gl.getUniformLocation(program, "uTime");
    this.uFlicker = gl.getUniformLocation(program, "uFlicker");
    this.uHasOverlay = gl.getUniformLocation(program, "uHasOverlay");
    this.uCurve = gl.getUniformLocation(program, "uCurve");
    this.uScale = gl.getUniformLocation(program, "uScale");
    // canvases upload top row first, and the overlay's pixels come premultiplied
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.gl = gl;
    this.program = program;
    return true;
  }

  /**
   * Draw the glass over what the scene just drew. `seconds` drives the hum (none when reduced);
   * `curve` is the barrel's strength and `fill` overscans the picture to the frame's edges.
   */
  render(
    scene: HTMLCanvasElement,
    overlay: HTMLCanvasElement | null,
    seconds: number,
    reduced: boolean,
    curve: number,
    fill: boolean,
  ): void {
    const gl = this.gl;
    if (!gl || !this.ok || scene.width === 0 || scene.height === 0) return;
    if (this.canvas.width !== scene.width || this.canvas.height !== scene.height) {
      this.canvas.width = scene.width;
      this.canvas.height = scene.height;
    }
    gl.viewport(0, 0, scene.width, scene.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
    const hasOverlay = overlay != null && overlay.width > 0 && overlay.height > 0;
    if (hasOverlay) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.overlay);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
    }
    gl.useProgram(this.program);
    gl.uniform2f(this.uSize, scene.width, scene.height);
    gl.uniform1f(this.uTime, seconds);
    gl.uniform1f(this.uFlicker, reduced ? 0 : 1);
    gl.uniform1f(this.uHasOverlay, hasOverlay ? 1 : 0);
    gl.uniform1f(this.uCurve, curve);
    // with the fill, the point on the middle of an edge (r² = 1) lands exactly on the frame
    gl.uniform1f(this.uScale, fill ? 1 / (1 + curve) : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Leave the DOM now; lose the context a beat later (see SceneCanvas on why). */
  dispose(): void {
    this.canvas.remove();
    const gl = this.gl;
    this.gl = null;
    setTimeout(() => {
      if (!gl) return;
      gl.deleteTexture(this.scene);
      gl.deleteTexture(this.overlay);
      gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.canvas.width = 0;
      this.canvas.height = 0;
    }, 150);
  }
}
