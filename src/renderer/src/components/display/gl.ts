/**
 * ONE FULL-SCREEN QUAD, ONE FRAGMENT SHADER: the plumbing a GL scene needs
 * and nothing more. No scene graph, no library; a scene that wants WebGL is
 * a fragment shader plus the uniforms it sets each frame. Compile errors
 * are logged and the program is null, so a scene degrades rather than
 * throws (the canvas shows its fallback caption).
 *
 * The one law carried over from packscape's aurora: NO pow() in a shader on
 * a base that can graze below zero. On the ANGLE/Metal path it killed the
 * whole GL context, a black scene rather than a NaN. a * sqrt(a) is a^1.5
 * and safe on a clamped base.
 */
export const QUAD_VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export interface QuadProgram {
  readonly program: WebGLProgram;
  use(): void;
  set1f(name: string, x: number): void;
  set2f(name: string, x: number, y: number): void;
  set3f(name: string, x: number, y: number, z: number): void;
  draw(): void;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[display] shader failed to compile:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function createQuadProgram(
  gl: WebGL2RenderingContext,
  fragment: string,
): QuadProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[display] program failed to link:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const loc = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const locations = new Map<string, WebGLUniformLocation | null>();
  const at = (name: string): WebGLUniformLocation | null => {
    if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
    return locations.get(name) ?? null;
  };
  return {
    program,
    use: () => gl.useProgram(program),
    set1f: (n, x) => gl.uniform1f(at(n), x),
    set2f: (n, x, y) => gl.uniform2f(at(n), x, y),
    set3f: (n, x, y, z) => gl.uniform3f(at(n), x, y, z),
    draw: () => {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    dispose: () => {
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
