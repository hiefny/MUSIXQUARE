import {
  IMAGE_BACKGROUND_MANIFEST,
  type BackgroundImageScene,
  type BackgroundImageVariant,
} from '../screensaver-backgrounds';

type CanvasContext = CanvasRenderingContext2D;
type Stops = ReadonlyArray<readonly number[]>;
type Curve = number[];
type Contour = Curve[];
interface VectorDigit {
  glyph?: string;
  advance: number;
  bounds: number[];
  contours: Contour[];
}
interface MorphPair {
  from: Contour[];
  to: Contour[];
  fromAdvance: number;
  toAdvance: number;
}
interface Layer {
  canvas: HTMLCanvasElement;
  ctx: CanvasContext;
  width: number;
  height: number;
}
interface GlyphTile extends Layer {
  offsetX: number;
  offsetY: number;
  fontSize: number;
  dpr: number;
}
interface ClockDigit {
  char: string;
  x: number;
  metrics: TextMetrics;
}
type ClockLayout = ReturnType<typeof buildClockLayout>;
type ClockScene = ReturnType<typeof buildClockScene>;
type DigitTile = ReturnType<typeof buildDigitTile>;
type ColonTile = ReturnType<typeof buildColonTile>;
type SecondsTile = Omit<ReturnType<typeof buildSecondsTile>, 'renderedText'> & {
  renderedText: string | null;
};
interface ClockTransition {
  from: ClockScene;
  to: ClockScene;
  start: number;
  mixedDigits?: DigitTile[];
}
interface SecondsMorph {
  start: number;
  fromText: string;
  toText: string;
  pairs: MorphPair[];
  fromPlacement: { left: number; second: number };
  toPlacement: { left: number; second: number };
}
interface FittedFont {
  w: number;
  h: number;
  fontSize: number;
  fontSpec: string;
  secondsFontSize: number;
  secondsFontSpec: string;
  secondsWidth: number;
  secondsGap: number;
  secondsDescent: number;
}
interface ClockMetrics {
  ready: boolean;
  topRightEdgeX: number;
  topRightEdgeY: number;
  bottomLeftEdgeX: number;
  bottomLeftEdgeY: number;
  glyphLeft: number;
  glyphRight: number;
  groupLeft: number;
  groupRight: number;
  glyphTop: number;
  glyphBottom: number;
  glyphWidth: number;
  glyphHeight: number;
  colonCenterX: number;
  colonCenterY: number;
  colonDotRadius: number;
  colonDotOffset: number;
}
type Speckle = ReturnType<typeof spawnSpeckle>;
type MoonPhase = ReturnType<typeof getMoonPhase>;
type DataStatus = 'idle' | 'locating' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'error';
interface LocalDataState {
  status: DataStatus;
  temperature: number | null;
  weatherCode: number | null;
  isDay: boolean;
  description: string;
  aqi: number | null;
  updatedAt: number | null;
  observedAt: number | null;
  stale: boolean;
  message: string;
}
type SceneName = 'clock' | 'date' | 'weather' | 'air' | 'moon';
interface InfoContent {
  kind: 'date' | 'moon' | 'number' | 'status';
  text: string;
  label: string;
  ready: boolean;
  unit?: string;
  scene?: SceneName;
  retry?: boolean;
  stale?: boolean;
  updatedAt?: number | null;
  source?: 'air' | 'weather';
  moon?: MoonPhase;
  southernHemisphere?: boolean;
}
interface InfoLayout extends InfoContent {
  w: number;
  h: number;
  fontSize: number;
  mainX: number;
  baseline: number;
  primaryLines: { text: string; x: number; baseline: number }[];
  primaryLeft: number;
  primaryRight: number;
  primaryTop: number;
  primaryBottom: number;
  primaryUnit: string;
  unitSize: number;
  unitX: number;
  unitBaseline: number;
  labelSize: number;
  lines: string[];
  labelY: number;
  actionY: number;
  tailText: string;
  tailLines: string[];
  tailSize: number;
  tailX: number;
  tailBaseline: number;
  radius: number;
  moonX: number;
  moonY: number;
  bounds: number[];
}
interface InfoGlyph {
  char: string;
  role: string;
  key: string;
  x: number;
  y: number;
  fontSize: number;
  weight: number;
  alpha: number;
  optical: boolean;
  metrics: Pick<
    TextMetrics,
    | 'width'
    | 'actualBoundingBoxLeft'
    | 'actualBoundingBoxRight'
    | 'actualBoundingBoxAscent'
    | 'actualBoundingBoxDescent'
  >;
  tile?: GlyphTile;
  moon?: MoonPhase;
  southernHemisphere?: boolean;
}
interface InfoScene {
  name: SceneName;
  layout: InfoLayout;
  dpr: number;
  tileDpr: number;
  glyphs: InfoGlyph[];
}
interface InfoPair {
  from?: InfoGlyph | null;
  to?: InfoGlyph | null;
  unchanged: boolean;
  mixed?: GlyphTile;
}
interface InfoTransition {
  start: number;
  from: InfoScene;
  to: InfoScene;
  pairs: InfoPair[];
  mixDpr: number;
}
interface BackgroundSpec {
  key: string;
  asset: string | null;
  gradient: string;
  brightness: number;
  pending?: boolean;
}
function element<K extends keyof HTMLElementTagNameMap>(
  id: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const node = document.getElementById(id);
  if (!node || node.tagName.toLowerCase() !== tag)
    throw new Error('Missing screensaver element: ' + id);
  return node as HTMLElementTagNameMap[K];
}
function context(canvas: HTMLCanvasElement): CanvasContext {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  return ctx;
}

const blurEngine = (() => {
  const PAIRS = 32;
  const MAX_SIGMA = 20;
  const kernels = new Map<
    string,
    {
      radius: number;
      weights: Float32Array;
      pairedWeights: Float32Array;
      offsets: Float32Array;
      count: number;
    }
  >();
  const stats = {
    calls: 0,
    gpuCalls: 0,
    cpuCalls: 0,
    solidCalls: 0,
    contextLosses: 0,
    gpuFailures: 0,
    lastGpuError: '',
  };
  let gpu: ReturnType<typeof initializeGpu> = null;
  let attemptedGpu = false;
  let gpuLost = false;
  let backend = 'not initialized';
  let cpu: {
    input: HTMLCanvasElement;
    output: HTMLCanvasElement;
    inputCtx: CanvasContext;
    outputCtx: CanvasContext;
    a: Float32Array;
    b: Float32Array;
  } | null = null;
  let solidCanvas: HTMLCanvasElement | null = null;
  let solidContext: CanvasContext | null = null;

  function kernel(sigma: number) {
    const key = sigma.toFixed(6);
    const cached = kernels.get(key);
    if (cached) return cached;
    const radius = Math.ceil(sigma * 3);
    const weights = new Float32Array(radius + 1);
    let sum = 0;
    for (let i = 0; i <= radius; i++) {
      weights[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += weights[i] * (i ? 2 : 1);
    }
    for (let i = 0; i <= radius; i++) weights[i] /= sum;
    const pairedWeights = new Float32Array(PAIRS);
    const offsets = new Float32Array(PAIRS);
    let count = 0;
    for (let i = 1; i <= radius; i += 2) {
      const next = i + 1 <= radius ? weights[i + 1] : 0;
      const pair = weights[i] + next;
      if (!(pair > 0)) continue;
      pairedWeights[count] = pair;
      offsets[count] = i + next / pair;
      count++;
    }
    const value = { radius, weights, pairedWeights, offsets, count };
    const oldest = kernels.keys().next().value;
    if (kernels.size >= 16 && oldest !== undefined) kernels.delete(oldest);
    kernels.set(key, value);
    return value;
  }

  function dimensions(source: HTMLCanvasElement, sigma: number) {
    const divisor = Math.max(1, Math.ceil(sigma / MAX_SIGMA));
    const width = source.width;
    const height = source.height;
    const workWidth = Math.max(1, Math.ceil(width / divisor));
    const workHeight = Math.max(1, Math.ceil(height / divisor));
    return {
      width,
      height,
      workWidth,
      workHeight,
      sigmaX: (sigma * workWidth) / width,
      sigmaY: (sigma * workHeight) / height,
    };
  }

  function initializeGpu() {
    attemptedGpu = true;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return null;
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      gpuLost = true;
      stats.contextLosses++;
      backend = 'CPU premultiplied Gaussian (WebGL context lost)';
    });
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Blur shader could not be created');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(message || 'Blur shader compilation failed');
      }
      return shader;
    };
    const vertex = compile(
      gl.VERTEX_SHADER,
      `
      attribute vec2 aPosition;
      varying vec2 vUv;
      void main() {
        vUv = aPosition * 0.5 + 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `,
    );
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision
      ? 'highp'
      : 'mediump';
    const fragment = compile(
      gl.FRAGMENT_SHADER,
      `
      precision ${precision} float;
      uniform sampler2D uSource;
      uniform vec2 uSize;
      uniform vec2 uDirection;
      uniform float uCenter;
      uniform float uWeights[${PAIRS}];
      uniform float uOffsets[${PAIRS}];
      uniform int uCount;
      varying vec2 vUv;
      vec4 sampleTransparent(vec2 uv) {
        vec2 pixel = uv * uSize - 0.5;
        vec2 clampedPixel = clamp(pixel, vec2(0.0), uSize - 1.0);
        vec2 coverage = clamp(min(pixel + 1.0, uSize - pixel), vec2(0.0), vec2(1.0));
        return texture2D(uSource, (clampedPixel + 0.5) / uSize) * coverage.x * coverage.y;
      }
      void main() {
        vec4 color = sampleTransparent(vUv) * uCenter;
        for (int i = 0; i < ${PAIRS}; i++) {
          if (i < uCount) {
            vec2 offset = uDirection * uOffsets[i];
            color += (sampleTransparent(vUv + offset) + sampleTransparent(vUv - offset)) * uWeights[i];
          }
        }
        gl_FragColor = color;
      }
    `,
    );
    const program = gl.createProgram();
    if (!program) throw new Error('Blur program could not be created');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message || 'Blur shader linking failed');
    }
    gl.useProgram(program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.disable(gl.DEPTH_TEST);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Blur buffer could not be created');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of [
      'uSource',
      'uSize',
      'uDirection',
      'uCenter',
      'uWeights',
      'uOffsets',
      'uCount',
    ]) {
      uniforms[name] = gl.getUniformLocation(
        program,
        name === 'uWeights' || name === 'uOffsets' ? name + '[0]' : name,
      );
    }
    gl.uniform1i(uniforms.uSource, 0);
    const texture = () => {
      const value = gl.createTexture();
      if (!value) throw new Error('Blur texture could not be created');
      gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return value;
    };
    return {
      canvas,
      gl,
      program,
      buffer,
      uniforms,
      source: texture(),
      ping: [texture(), texture()],
      framebuffers: [gl.createFramebuffer(), gl.createFramebuffer()],
      workWidth: 0,
      workHeight: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      maxViewport: gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array,
    };
  }

  function gpuBlur(source: HTMLCanvasElement, sigma: number) {
    const state = gpu;
    if (!state) return cpuBlur(source, sigma);
    const { gl, canvas, uniforms } = state;
    const size = dimensions(source, sigma);
    const { width, height, workWidth, workHeight } = size;
    if (
      width > state.maxTexture ||
      height > state.maxTexture ||
      width > state.maxViewport[0] ||
      height > state.maxViewport[1]
    ) {
      return cpuBlur(source, sigma, 'CPU premultiplied Gaussian (canvas exceeds GPU limits)');
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (state.sourceWidth !== width || state.sourceHeight !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      state.sourceWidth = width;
      state.sourceHeight = height;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    if (state.workWidth !== workWidth || state.workHeight !== workHeight) {
      for (let i = 0; i < 2; i++) {
        gl.bindTexture(gl.TEXTURE_2D, state.ping[i]);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          workWidth,
          workHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.framebuffers[i]);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          state.ping[i],
          0,
        );
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw new Error('Incomplete blur framebuffer');
      }
      state.workWidth = workWidth;
      state.workHeight = workHeight;
    }
    const pass = (
      input: WebGLTexture,
      inputWidth: number,
      inputHeight: number,
      destination: WebGLFramebuffer | null,
      outputWidth: number,
      outputHeight: number,
      radius: number,
      horizontal: boolean,
    ) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
      gl.viewport(0, 0, outputWidth, outputHeight);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform2f(uniforms.uSize, inputWidth, inputHeight);
      if (radius > 0.01) {
        const weights = kernel(radius);
        gl.uniform1f(uniforms.uCenter, weights.weights[0]);
        gl.uniform1fv(uniforms.uWeights, weights.pairedWeights);
        gl.uniform1fv(uniforms.uOffsets, weights.offsets);
        gl.uniform1i(uniforms.uCount, weights.count);
        gl.uniform2f(
          uniforms.uDirection,
          horizontal ? 1 / inputWidth : 0,
          horizontal ? 0 : 1 / inputHeight,
        );
      } else {
        gl.uniform1f(uniforms.uCenter, 1);
        gl.uniform1i(uniforms.uCount, 0);
        gl.uniform2f(uniforms.uDirection, 0, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    if (workWidth === width && workHeight === height) {
      pass(state.source, width, height, state.framebuffers[0], workWidth, workHeight, sigma, true);
      pass(state.ping[0], workWidth, workHeight, null, width, height, sigma, false);
    } else {
      pass(state.source, width, height, state.framebuffers[0], workWidth, workHeight, 0, true);
      pass(
        state.ping[0],
        workWidth,
        workHeight,
        state.framebuffers[1],
        workWidth,
        workHeight,
        size.sigmaX,
        true,
      );
      pass(
        state.ping[1],
        workWidth,
        workHeight,
        state.framebuffers[0],
        workWidth,
        workHeight,
        size.sigmaY,
        false,
      );
      pass(state.ping[0], workWidth, workHeight, null, width, height, 0, true);
    }
    if (gl.isContextLost()) throw new Error('Blur WebGL context lost');
    stats.gpuCalls++;
    backend = 'WebGL premultiplied Gaussian';
    return canvas;
  }

  function cpuBlur(
    source: HTMLCanvasElement,
    sigma: number,
    description = 'CPU premultiplied Gaussian',
  ) {
    if (!cpu) {
      const input = document.createElement('canvas');
      const output = document.createElement('canvas');
      cpu = {
        input,
        output,
        inputCtx: context(input),
        outputCtx: context(output),
        a: new Float32Array(),
        b: new Float32Array(),
      };
    }
    const size = dimensions(source, sigma);
    const { width, height, workWidth, workHeight } = size;
    const length = workWidth * workHeight * 4;
    if (cpu.input.width !== workWidth || cpu.input.height !== workHeight) {
      cpu.input.width = workWidth;
      cpu.input.height = workHeight;
    }
    if (!cpu.a || cpu.a.length !== length) {
      cpu.a = new Float32Array(length);
      cpu.b = new Float32Array(length);
    }
    const ctx = cpu.inputCtx;
    ctx.clearRect(0, 0, workWidth, workHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(source, 0, 0, workWidth, workHeight);
    const pixels = ctx.getImageData(0, 0, workWidth, workHeight);
    const data = pixels.data;
    for (let i = 0; i < length; i += 4) {
      const alpha = data[i + 3] / 255;
      cpu.a[i] = data[i] * alpha;
      cpu.a[i + 1] = data[i + 1] * alpha;
      cpu.a[i + 2] = data[i + 2] * alpha;
      cpu.a[i + 3] = data[i + 3];
    }
    const convolve = (
      input: Float32Array,
      output: Float32Array,
      horizontal: boolean,
      radius: number,
    ) => {
      const values = kernel(radius);
      const stride = horizontal ? 4 : workWidth * 4;
      const dimension = horizontal ? workWidth : workHeight;
      for (let y = 0; y < workHeight; y++) {
        for (let x = 0; x < workWidth; x++) {
          const index = (y * workWidth + x) * 4;
          const position = horizontal ? x : y;
          const start = Math.max(-values.radius, -position);
          const end = Math.min(values.radius, dimension - 1 - position);
          let red = 0,
            green = 0,
            blue = 0,
            alpha = 0;
          for (let offset = start; offset <= end; offset++) {
            const weight = values.weights[Math.abs(offset)];
            const sample = index + offset * stride;
            red += input[sample] * weight;
            green += input[sample + 1] * weight;
            blue += input[sample + 2] * weight;
            alpha += input[sample + 3] * weight;
          }
          output[index] = red;
          output[index + 1] = green;
          output[index + 2] = blue;
          output[index + 3] = alpha;
        }
      }
    };
    convolve(cpu.a, cpu.b, true, size.sigmaX);
    convolve(cpu.b, cpu.a, false, size.sigmaY);
    for (let i = 0; i < length; i += 4) {
      const alpha = cpu.a[i + 3];
      const inverse = alpha > 0.0001 ? 255 / alpha : 0;
      data[i] = cpu.a[i] * inverse;
      data[i + 1] = cpu.a[i + 1] * inverse;
      data[i + 2] = cpu.a[i + 2] * inverse;
      data[i + 3] = alpha;
    }
    ctx.putImageData(pixels, 0, 0);
    if (cpu.output.width !== width || cpu.output.height !== height) {
      cpu.output.width = width;
      cpu.output.height = height;
    }
    cpu.outputCtx.clearRect(0, 0, width, height);
    cpu.outputCtx.imageSmoothingEnabled = true;
    cpu.outputCtx.imageSmoothingQuality = 'low';
    cpu.outputCtx.drawImage(cpu.input, 0, 0, width, height);
    stats.cpuCalls++;
    backend = description;
    return cpu.output;
  }

  return {
    solid(source: HTMLCanvasElement, sigmaBackingPixels: number, opaqueTint = '#ffffff') {
      if (!source.width || !source.height) return source;
      if (!solidCanvas) {
        solidCanvas = document.createElement('canvas');
        solidContext = context(solidCanvas);
      }
      const sigma = Math.max(0, Number(sigmaBackingPixels) || 0);
      const width = source.width,
        height = source.height;
      if (solidCanvas.width !== width || solidCanvas.height !== height) {
        solidCanvas.width = width;
        solidCanvas.height = height;
      }
      const ctx = solidContext || context(solidCanvas);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);
      const offset = Math.ceil(width + 4 * sigma + 16);
      ctx.shadowColor = opaqueTint;
      ctx.shadowBlur = 2 * sigma;
      ctx.shadowOffsetX = offset;
      ctx.shadowOffsetY = 0;
      ctx.drawImage(source, -offset, 0);
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      stats.solidCalls++;
      backend = 'Canvas shadow Gaussian';
      return solidCanvas;
    },
    blur(source: HTMLCanvasElement, sigmaBackingPixels: number) {
      const sigma = Math.max(0, Number(sigmaBackingPixels) || 0);
      if (!(sigma > 0.01) || !source.width || !source.height) return source;
      stats.calls++;
      if (!attemptedGpu) {
        try {
          gpu = initializeGpu();
        } catch (error) {
          stats.gpuFailures++;
          stats.lastGpuError = String(error instanceof Error ? error.message : error);
        }
      }
      if (gpu && !gpuLost) {
        try {
          return gpuBlur(source, sigma);
        } catch (error) {
          gpuLost = true;
          stats.gpuFailures++;
          stats.lastGpuError = String(error instanceof Error ? error.message : error);
        }
      }
      return cpuBlur(source, sigma);
    },
    dispose() {
      if (gpu) {
        const { gl } = gpu;
        gl.deleteTexture(gpu.source);
        gpu.ping.forEach((texture) => gl.deleteTexture(texture));
        gpu.framebuffers.forEach((framebuffer) => gl.deleteFramebuffer(framebuffer));
        gl.deleteBuffer(gpu.buffer);
        gl.deleteProgram(gpu.program);
        gpu.canvas.width = gpu.canvas.height = 0;
      }
      if (cpu) {
        cpu.input.width = cpu.input.height = 0;
        cpu.output.width = cpu.output.height = 0;
      }
      if (solidCanvas) solidCanvas.width = solidCanvas.height = 0;
      gpu = null;
      cpu = null;
      solidCanvas = null;
      solidContext = null;
      attemptedGpu = false;
      gpuLost = false;
      kernels.clear();
    },
    get backend() {
      return backend;
    },
    stats,
  };
})();

interface CompositorText {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  left: number;
  top: number;
  used: number;
}
interface CompositorEntry {
  state: CompositorState;
  source: HTMLCanvasElement;
  node: HTMLDivElement;
  image: HTMLCanvasElement;
  copied: boolean;
  lastFrame: number;
  originalStyle: string;
  removed: boolean;
}
interface CompositorState {
  canvas: HTMLCanvasElement;
  root: HTMLDivElement;
  frame: number;
  order: number;
  entries: Set<CompositorEntry>;
  bySource: WeakMap<HTMLCanvasElement, CompositorEntry[]>;
  uses: WeakMap<HTMLCanvasElement, number>;
  texts: Map<string, CompositorText>;
  ratioX: number;
  ratioY: number;
  defaultOpacity: string;
}
type CompositorStyle =
  | 'display'
  | 'width'
  | 'height'
  | 'left'
  | 'top'
  | 'transform'
  | 'opacity'
  | 'filter'
  | 'zIndex'
  | 'visibility';
const compositor = (() => {
  let targets = new WeakMap<HTMLCanvasElement, CompositorState>();
  const states = new Set<CompositorState>();
  const sourceEntries = new WeakMap<HTMLCanvasElement, Set<CompositorEntry>>();
  const owners = new WeakMap<HTMLCanvasElement, CompositorEntry>();
  const requestedStyles = new WeakMap<CSSStyleDeclaration, Map<CompositorStyle, string>>();
  function assign(style: CSSStyleDeclaration, name: CompositorStyle, value: string) {
    let requested = requestedStyles.get(style);
    if (!requested) requestedStyles.set(style, (requested = new Map()));
    if (requested.get(name) === value) return;
    style[name] = value;
    requested.set(name, value);
  }
  function stateFor(target: CanvasContext): CompositorState {
    const canvas = target.canvas;
    const found = targets.get(canvas);
    if (found) return found;
    const root = document.createElement('div');
    root.setAttribute('aria-hidden', 'true');
    root.dataset.compatCompositor = canvas.id;
    root.style.cssText =
      'position:absolute;pointer-events:none;overflow:visible;isolation:isolate;';
    const computed = getComputedStyle(canvas);
    root.style.zIndex = computed.zIndex;
    canvas.insertAdjacentElement('afterend', root);
    const state: CompositorState = {
      canvas,
      root,
      frame: 0,
      order: 0,
      entries: new Set(),
      bySource: new WeakMap(),
      uses: new WeakMap(),
      texts: new Map(),
      ratioX: 1,
      ratioY: 1,
      defaultOpacity: computed.opacity,
    };
    targets.set(canvas, state);
    states.add(state);
    return state;
  }
  function sync(target: CanvasContext) {
    const state = targets.get(target.canvas);
    if (!state) return;
    const { canvas, root } = state;
    assign(root.style, 'opacity', canvas.style.opacity || state.defaultOpacity);
    assign(root.style, 'visibility', canvas.style.visibility || 'visible');
    assign(
      root.style,
      'display',
      canvas.hidden || canvas.style.display === 'none' ? 'none' : 'block',
    );
  }
  function begin(target: CanvasContext) {
    const state = stateFor(target),
      { canvas, root } = state;
    const rect = canvas.getBoundingClientRect();
    state.frame++;
    state.order = 0;
    state.uses = new WeakMap();
    state.ratioX = canvas.width / Math.max(0.001, rect.width);
    state.ratioY = canvas.height / Math.max(0.001, rect.height);
    assign(root.style, 'left', canvas.offsetLeft + 'px');
    assign(root.style, 'top', canvas.offsetTop + 'px');
    assign(root.style, 'width', rect.width + 'px');
    assign(root.style, 'height', rect.height + 'px');
    sync(target);
  }
  function remove(entry: CompositorEntry) {
    if (entry.removed) return;
    entry.removed = true;
    entry.node.remove();
    entry.state.entries.delete(entry);
    sourceEntries.get(entry.source)?.delete(entry);
    if (owners.get(entry.source) === entry) {
      owners.delete(entry.source);
      entry.source.style.cssText = entry.originalStyle;
    }
    if (entry.copied) entry.image.width = entry.image.height = 0;
  }
  function createEntry(state: CompositorState, source: HTMLCanvasElement) {
    const node = document.createElement('div');
    node.style.cssText =
      'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;will-change:transform,opacity,filter;';
    const copied = owners.has(source);
    const image = copied ? document.createElement('canvas') : source;
    const entry: CompositorEntry = {
      state,
      source,
      node,
      image,
      copied,
      lastFrame: state.frame,
      originalStyle: image.style.cssText,
      removed: false,
    };
    if (!copied) owners.set(source, entry);
    image.style.cssText =
      'position:absolute;display:block;left:0;top:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;pointer-events:none;';
    node.append(image);
    state.root.append(node);
    state.entries.add(entry);
    let all = sourceEntries.get(source);
    if (!all) sourceEntries.set(source, (all = new Set()));
    all.add(entry);
    return entry;
  }
  function draw(
    target: CanvasContext,
    source: HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number,
    blur = 0,
  ) {
    if (
      !source.width ||
      !source.height ||
      !(width > 0) ||
      !(height > 0) ||
      !(target.globalAlpha > 0)
    )
      return;
    const state = stateFor(target);
    const occurrence = state.uses.get(source) || 0;
    state.uses.set(source, occurrence + 1);
    let list = state.bySource.get(source);
    if (!list) state.bySource.set(source, (list = []));
    let entry = list[occurrence];
    if (!entry || entry.removed) list[occurrence] = entry = createEntry(state, source);
    entry.lastFrame = state.frame;
    if (entry.copied) {
      const image = entry.image;
      if (image.width !== source.width || image.height !== source.height) {
        image.width = source.width;
        image.height = source.height;
      }
      const ctx = context(image);
      ctx.clearRect(0, 0, image.width, image.height);
      ctx.drawImage(source, 0, 0);
    }
    const matrix = target.getTransform();
    const a = matrix.a / state.ratioX,
      b = matrix.b / state.ratioY;
    const c = matrix.c / state.ratioX,
      d = matrix.d / state.ratioY;
    const tx = (matrix.a * x + matrix.c * y + matrix.e) / state.ratioX;
    const ty = (matrix.b * x + matrix.d * y + matrix.f) / state.ratioY;
    const sigma = Math.max(0, blur) / Math.max(0.001, Math.hypot(matrix.a, matrix.b));
    const style = entry.node.style;
    assign(style, 'display', 'block');
    assign(style, 'width', width + 'px');
    assign(style, 'height', height + 'px');
    assign(style, 'transform', `matrix(${a},${b},${c},${d},${tx},${ty}) translateZ(0)`);
    assign(style, 'opacity', String(Math.min(1, target.globalAlpha)));
    assign(style, 'filter', sigma > 0.005 ? `blur(${sigma}px)` : 'none');
    assign(style, 'zIndex', String(++state.order));
  }
  function text(target: CanvasContext, value: string, x: number, y: number, blur = 0) {
    const state = stateFor(target),
      transform = target.getTransform();
    const scale = Math.max(0.1, Math.hypot(transform.a, transform.b));
    const key = JSON.stringify([
      value,
      target.font,
      target.textAlign,
      target.textBaseline,
      target.fontKerning,
      target.direction,
      target.fillStyle,
      scale,
    ]);
    let tile = state.texts.get(key);
    if (!tile) {
      const measure = target.measureText(value),
        padding = 4;
      const left = Math.ceil(measure.actualBoundingBoxLeft || 0) + padding;
      const top = Math.ceil(measure.actualBoundingBoxAscent || 0) + padding;
      const width = Math.max(
        1,
        Math.ceil(left + (measure.actualBoundingBoxRight || measure.width) + padding),
      );
      const height = Math.max(
        1,
        Math.ceil(top + (measure.actualBoundingBoxDescent || 0) + padding),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = context(canvas);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.font = target.font;
      ctx.textAlign = target.textAlign;
      ctx.textBaseline = target.textBaseline;
      ctx.fontKerning = target.fontKerning;
      ctx.direction = target.direction;
      ctx.fillStyle = target.fillStyle;
      ctx.fillText(value, left, top);
      tile = {
        canvas,
        width: canvas.width / scale,
        height: canvas.height / scale,
        left,
        top,
        used: state.frame,
      };
      state.texts.set(key, tile);
    }
    tile.used = state.frame;
    draw(target, tile.canvas, x - tile.left, y - tile.top, tile.width, tile.height, blur);
  }
  function forget(source: HTMLCanvasElement) {
    const entries = sourceEntries.get(source);
    if (entries) for (const entry of entries) remove(entry);
    sourceEntries.delete(source);
  }
  function end(target: CanvasContext) {
    const state = stateFor(target);
    for (const entry of state.entries) {
      if (!entry.source.width || !entry.source.height || entry.lastFrame < state.frame - 2)
        remove(entry);
      else if (entry.lastFrame !== state.frame) assign(entry.node.style, 'display', 'none');
    }
    for (const [key, tile] of state.texts) {
      if (tile.used >= state.frame - 2) continue;
      forget(tile.canvas);
      tile.canvas.width = tile.canvas.height = 0;
      state.texts.delete(key);
    }
    sync(target);
  }
  function dispose() {
    for (const state of states) {
      for (const entry of state.entries) remove(entry);
      for (const tile of state.texts.values()) tile.canvas.width = tile.canvas.height = 0;
      state.texts.clear();
      state.root.remove();
    }
    states.clear();
    targets = new WeakMap();
  }
  return { begin, draw, text, end, sync, forget, dispose };
})();
const compatPaintCanvas = document.createElement('canvas');
const compatPaintContext = context(compatPaintCanvas);
function opaqueCompatColor(color: string) {
  if (!color.startsWith('rgba(')) return color;
  return 'rgb(' + color.slice(5, -1).split(',').slice(0, 3).join(',') + ')';
}
function paintCompatBlur(
  target: CanvasContext,
  sigma: number,
  paint: (target: CanvasContext) => void,
  solidTint: string | null = null,
) {
  if (!(sigma > 0.01)) {
    paint(target);
    return;
  }
  const width = target.canvas.width,
    height = target.canvas.height;
  if (compatPaintCanvas.width !== width || compatPaintCanvas.height !== height) {
    compatPaintCanvas.width = width;
    compatPaintCanvas.height = height;
  }
  const temporary = compatPaintContext;
  temporary.resetTransform();
  temporary.clearRect(0, 0, width, height);
  temporary.save();
  temporary.setTransform(target.getTransform());
  temporary.globalAlpha = 1;
  temporary.globalCompositeOperation = 'source-over';
  temporary.font = target.font;
  temporary.fontKerning = target.fontKerning;
  temporary.textAlign = target.textAlign;
  temporary.textBaseline = target.textBaseline;
  temporary.direction = target.direction;
  temporary.fillStyle = target.fillStyle;
  temporary.strokeStyle = target.strokeStyle;
  temporary.lineWidth = target.lineWidth;
  temporary.lineCap = target.lineCap;
  temporary.lineJoin = target.lineJoin;
  temporary.miterLimit = target.miterLimit;
  temporary.shadowBlur = target.shadowBlur;
  temporary.shadowColor = target.shadowColor;
  temporary.shadowOffsetX = target.shadowOffsetX;
  temporary.shadowOffsetY = target.shadowOffsetY;
  paint(temporary);
  temporary.restore();
  const blurred = solidTint
    ? blurEngine.solid(compatPaintCanvas, sigma, solidTint)
    : blurEngine.blur(compatPaintCanvas, sigma);
  target.save();
  target.resetTransform();
  target.drawImage(blurred, 0, 0);
  target.restore();
}
function drawCompatImage(
  target: CanvasContext,
  source: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
  sigma = 0,
  solidTint: string | null = null,
) {
  if (target === clockCtx || target === weatherCtx) {
    compositor.draw(target, source, x, y, width, height, sigma);
    return;
  }
  if (!(sigma > 0.01)) {
    target.drawImage(source, x, y, width, height);
    return;
  }
  const transform = target.getTransform();
  const physicalScale = (Math.hypot(transform.a, transform.b) * width) / source.width;
  const radius = sigma / Math.max(0.0001, physicalScale);
  const blurred = solidTint
    ? blurEngine.solid(source, radius, solidTint)
    : blurEngine.blur(source, radius);
  target.drawImage(blurred, x, y, width, height);
}

interface DisplayUpdate {
  backLabel: string;
  title: string;
  subtitle: string;
  lang: string;
  dir: 'ltr' | 'rtl';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

let disposed = false;
let animationFrame = 0;
let lifecycleGeneration = 0;
let controlsTimer: ReturnType<typeof setTimeout> | null = null;
let keyboardInteraction = false;
let displayState: DisplayUpdate = {
  backLabel: 'Back to MUSIXQUARE',
  title: '',
  subtitle: '',
  lang: 'en',
  dir: 'ltr',
};
const displayChrome = element('displayChrome', 'div');
const backButton = element('displayBack', 'button');
const musicInfo = element('displayMusicInfo', 'div');
const musicTitle = element('musicTitle', 'div');
const musicSubtitle = element('musicSubtitle', 'div');
let fontWarmupTimer: ReturnType<typeof setTimeout> | null = null;
function postToHost(type: 'ready' | 'close') {
  if (window.parent === window) return;
  window.parent.postMessage({ type: `mxqr:screensaver:${type}` }, location.origin);
}

function isDisplayUpdate(value: unknown): value is DisplayUpdate {
  return (
    isRecord(value) &&
    typeof value.backLabel === 'string' &&
    value.backLabel.length <= 500 &&
    typeof value.title === 'string' &&
    value.title.length <= 2000 &&
    typeof value.subtitle === 'string' &&
    value.subtitle.length <= 2000 &&
    typeof value.lang === 'string' &&
    value.lang.length <= 35 &&
    (value.dir === 'ltr' || value.dir === 'rtl')
  );
}

function applyDisplayUpdate(update: DisplayUpdate) {
  displayState = { ...update, title: update.title.trim(), subtitle: update.subtitle.trim() };
  displayChrome.lang = update.lang;
  displayChrome.dir = update.dir;
  backButton.setAttribute('aria-label', update.backLabel);
  const brandAt = update.backLabel.indexOf('MUSIXQUARE');
  element('backBefore', 'span').textContent =
    brandAt < 0 ? update.backLabel : update.backLabel.slice(0, brandAt).trim();
  element('backAfter', 'span').textContent =
    brandAt < 0 ? '' : update.backLabel.slice(brandAt + 'MUSIXQUARE'.length).trim();
  musicTitle.textContent = displayState.title;
  musicSubtitle.textContent = displayState.subtitle;
  musicSubtitle.hidden = !displayState.subtitle;
  musicInfo.hidden = !displayState.title;
}

function showControls() {
  if (disposed) return;
  document.body.classList.remove('chrome-hidden');
  if (controlsTimer !== null) clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    controlsTimer = null;
    if (keyboardInteraction && displayChrome.contains(document.activeElement)) {
      showControls();
      return;
    }
    document.body.classList.add('chrome-hidden');
  }, 5000);
}

function initializeDisplayControls() {
  applyDisplayUpdate(displayState);
  const pointerActivity = () => {
    keyboardInteraction = false;
    showControls();
  };
  for (const type of ['pointermove', 'pointerdown', 'touchstart', 'click', 'wheel'] as const) {
    window.addEventListener(type, pointerActivity, { passive: true });
  }
  window.addEventListener('focusin', showControls);
  window.addEventListener('keydown', (event) => {
    keyboardInteraction = true;
    showControls();
    if (event.key === 'Escape') {
      event.preventDefault();
      postToHost('close');
      return;
    }
    if (event.key !== 'Tab' || window.parent === window) return;
    const focusable = [
      ...document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button,a[href]'),
    ].filter((node) => !node.hidden && node.tabIndex >= 0 && node.getClientRects().length > 0);
    const first = focusable[0],
      last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !focusable.some((node) => node === document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !focusable.some((node) => node === document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  });
  backButton.addEventListener('click', () => postToHost('close'));
  showControls();
  postToHost('ready');
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    disposed ||
    window.parent === window ||
    event.source !== window.parent ||
    event.origin !== location.origin
  )
    return;
  if (
    !isRecord(event.data) ||
    event.data.type !== 'mxqr:screensaver:update' ||
    !isDisplayUpdate(event.data.payload)
  )
    return;
  applyDisplayUpdate(event.data.payload);
});

window.addEventListener('pagehide', () => {
  disposed = true;
  lifecycleGeneration++;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (controlsTimer !== null) clearTimeout(controlsTimer);
  if (fontWarmupTimer !== null) clearTimeout(fontWarmupTimer);
  if (weatherRefreshTimer !== null) clearInterval(weatherRefreshTimer);
  weatherGeneration++;
  for (const controller of weatherFetchControllers) controller.abort();
  weatherFetchControllers.clear();
  settleInfoTransition();
  releaseInfoScene(currentInfoScene);
  if (clockTransition) releaseClockTransition(clockTransition);
  releaseClockScene(currentClockScene);
  if (currentSecondsTile) {
    compositor.forget(currentSecondsTile.canvas);
    currentSecondsTile.canvas.width = currentSecondsTile.canvas.height = 0;
    compositor.forget(currentSecondsTile.ink.canvas);
    currentSecondsTile.ink.canvas.width = currentSecondsTile.ink.canvas.height = 0;
  }
  compositor.dispose();
  blurEngine.dispose();
  compatPaintCanvas.width = compatPaintCanvas.height = 0;
  imageBackgrounds.dispose();
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !disposed) return;
  disposed = false;
  currentClockScene = null;
  clockTransition = null;
  currentSecondsTile = null;
  secondsMorph = null;
  secondsLastFrame = null;
  currentInfoScene = null;
  currentInfoLayout = null;
  invalidateFontLayouts();
  weatherInitialized = false;
  initializeWeather();
  showControls();
  startAnimationLoop();
});

const WEATHER_REFRESH_MS = 10 * 60 * 1000;
const WEATHER_REQUEST_TIMEOUT_MS = 12000;
const weatherState: LocalDataState = {
  aqi: null,
  status: 'idle',
  temperature: null,
  weatherCode: null,
  isDay: true,
  description: '',
  updatedAt: null,
  observedAt: null,
  stale: false,
  message: '',
};
const airState: LocalDataState = {
  temperature: null,
  weatherCode: null,
  isDay: true,
  description: '',
  status: 'idle',
  aqi: null,
  updatedAt: null,
  observedAt: null,
  stale: false,
  message: '',
};
let weatherCoordinates: { latitude: number; longitude: number } | null = null;
let weatherGeneration = 0;
const weatherFetchControllers = new Set<AbortController>();
let weatherFetchPromise: Promise<LocalDataState> | null = null;
let weatherLocationSettler: ((state: LocalDataState) => void) | null = null;
let weatherRefreshTimer: ReturnType<typeof setInterval> | null = null;
let weatherLastAttemptAt = 0;
let weatherInitialized = false;
let weatherListenersRegistered = false;

function getWeatherDescription(code: number | null, isDay = true) {
  if (code === 0) return isDay ? 'Clear sky' : 'Clear night';
  const descriptions: Record<number, string> = {
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Heavy freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Heavy freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    97: 'Heavy thunderstorm',
    99: 'Heavy thunderstorm with hail',
  };
  return descriptions[code ?? -1] || 'Current weather';
}

function getAirQualityDescription(aqi: number | null) {
  if (!finite(aqi) || aqi < 0) return 'Air quality';
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function setLocalDataFailure(state: LocalDataState, message: string) {
  if (state.updatedAt !== null) {
    state.status = 'ready';
    state.stale = true;
    state.message = 'Waiting for an update · Last available data';
  } else {
    state.status = 'error';
    state.message = message;
  }
}

async function fetchLocalData(url: string) {
  const controller = new AbortController();
  weatherFetchControllers.add(controller);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WEATHER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Request failed');
    const data: unknown = await response.json();
    if (!isRecord(data) || data.error || controller.signal.aborted)
      throw new Error('Invalid response');
    return data;
  } catch (error) {
    if (timedOut) throw new Error('Request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
    weatherFetchControllers.delete(controller);
  }
}

function applyForecastData(data: Record<string, unknown>) {
  const current = isRecord(data.current) ? data.current : null;
  if (
    current &&
    finite(current.temperature_2m) &&
    finite(current.weather_code) &&
    Number.isInteger(current.weather_code) &&
    (current.is_day === 0 || current.is_day === 1) &&
    (!data.current_units ||
      (isRecord(data.current_units) ? data.current_units.temperature_2m : null) === '°C')
  ) {
    Object.assign(weatherState, {
      status: 'ready',
      temperature: current.temperature_2m,
      weatherCode: current.weather_code,
      isDay: current.is_day === 1,
      description: getWeatherDescription(current.weather_code, current.is_day === 1),
      updatedAt: Date.now(),
      observedAt: finite(current.time) ? current.time * 1000 : null,
      stale: false,
      message: '',
    });
  } else {
    setLocalDataFailure(weatherState, 'Weather is unavailable');
  }
}

function applyAirQualityData(data: Record<string, unknown>) {
  const current = isRecord(data.current) ? data.current : null;
  if (
    !current ||
    !finite(current.us_aqi) ||
    current.us_aqi < 0 ||
    (data.current_units &&
      (isRecord(data.current_units) ? data.current_units.us_aqi : null) !== 'USAQI')
  ) {
    setLocalDataFailure(airState, 'Air quality is unavailable');
    return;
  }
  Object.assign(airState, {
    status: 'ready',
    aqi: current.us_aqi,
    updatedAt: Date.now(),
    observedAt: finite(current.time) ? current.time * 1000 : null,
    stale: false,
    message: '',
  });
}

function refreshWeather() {
  if (!weatherCoordinates) return Promise.resolve(weatherState);
  if (weatherFetchPromise) return weatherFetchPromise;
  const generation = weatherGeneration;
  const coordinates = { ...weatherCoordinates };
  weatherLastAttemptAt = Date.now();
  for (const state of [weatherState, airState] as const) {
    if (state.status !== 'ready') {
      state.status = 'loading';
      state.message = 'Loading local conditions';
    }
  }

  weatherFetchPromise = Promise.resolve()
    .then(async () => {
      if (generation !== weatherGeneration) return weatherState;
      const common = {
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        timezone: 'auto',
        timeformat: 'unixtime',
      };
      const forecastParams = new URLSearchParams({
        ...common,
        current: 'temperature_2m,weather_code,is_day',
        temperature_unit: 'celsius',
      });
      const airParams = new URLSearchParams({ ...common, current: 'us_aqi' });
      const forecastRequest = fetchLocalData(
        'https://api.open-meteo.com/v1/forecast?' + forecastParams,
      )
        .then((data) => {
          if (generation === weatherGeneration) applyForecastData(data);
        })
        .catch((error) => {
          if (generation !== weatherGeneration) return;
          const message =
            error.message === 'Request timed out'
              ? 'The weather service is taking a moment'
              : 'Weather is unavailable';
          setLocalDataFailure(weatherState, message);
        });
      const airRequest = fetchLocalData(
        'https://air-quality-api.open-meteo.com/v1/air-quality?' + airParams,
      )
        .then((data) => {
          if (generation === weatherGeneration) applyAirQualityData(data);
        })
        .catch(() => {
          if (generation === weatherGeneration)
            setLocalDataFailure(airState, 'Air quality is unavailable');
        });
      await Promise.all([forecastRequest, airRequest]);
      return weatherState;
    })
    .finally(() => {
      if (generation === weatherGeneration) weatherFetchPromise = null;
    });
  return weatherFetchPromise;
}

function requestWeatherLocation() {
  const generation = ++weatherGeneration;
  for (const controller of weatherFetchControllers) controller.abort();
  weatherFetchControllers.clear();
  weatherFetchPromise = null;
  weatherCoordinates = null;
  if (weatherLocationSettler) weatherLocationSettler(weatherState);
  weatherLocationSettler = null;

  Object.assign(weatherState, {
    temperature: null,
    weatherCode: null,
    description: '',
    observedAt: null,
  });
  Object.assign(airState, { aqi: null, observedAt: null });
  for (const state of [weatherState, airState] as const) {
    Object.assign(state, {
      status: 'locating',
      updatedAt: null,
      stale: false,
      message: 'Finding your location',
    });
  }

  if (
    typeof navigator === 'undefined' ||
    !navigator.geolocation ||
    (typeof window !== 'undefined' && window.isSecureContext === false)
  ) {
    for (const state of [weatherState, airState] as const) {
      state.status = 'unavailable';
      state.message =
        typeof window !== 'undefined' && window.isSecureContext === false
          ? 'Location needs a secure HTTPS connection'
          : 'Location is unavailable in this browser';
    }
    return Promise.resolve(weatherState);
  }

  return new Promise<LocalDataState>((resolve) => {
    weatherLocationSettler = resolve;
    const settle = () => {
      if (weatherLocationSettler === resolve) weatherLocationSettler = null;
      resolve(weatherState);
    };
    const failure = (error: Pick<GeolocationPositionError, 'code'>) => {
      if (generation !== weatherGeneration) return settle();
      const denied = error && error.code === 1;
      for (const state of [weatherState, airState] as const) {
        state.status = denied ? 'denied' : 'unavailable';
        state.message = denied
          ? 'Allow location in your browser'
          : error && error.code === 3
            ? 'Finding your location is taking a moment'
            : 'Your location is unavailable';
      }
      settle();
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (generation !== weatherGeneration) return settle();
          const coordinates = position && position.coords;
          if (
            !coordinates ||
            !finite(coordinates.latitude) ||
            !finite(coordinates.longitude) ||
            Math.abs(coordinates.latitude) > 90 ||
            Math.abs(coordinates.longitude) > 180
          )
            return failure({ code: 2 });
          weatherCoordinates = {
            latitude: Math.round(coordinates.latitude * 1000) / 1000,
            longitude: Math.round(coordinates.longitude * 1000) / 1000,
          };
          refreshWeather().then(settle, () => {
            if (generation === weatherGeneration) {
              for (const state of [weatherState, airState] as const) {
                setLocalDataFailure(state, 'Local conditions are unavailable');
              }
            }
            settle();
          });
        },
        failure,
        {
          enableHighAccuracy: false,
          maximumAge: WEATHER_REFRESH_MS,
          timeout: 15000,
        },
      );
    } catch {
      failure({ code: 2 });
    }
  });
}

function initializeWeather() {
  if (weatherInitialized) return;
  weatherInitialized = true;
  requestWeatherLocation().catch(handleLocalDataError);
  weatherRefreshTimer = setInterval(() => {
    if (typeof document === 'undefined' || !document.hidden)
      refreshWeather().catch(handleLocalDataError);
  }, WEATHER_REFRESH_MS);
  if (weatherListenersRegistered) return;
  weatherListenersRegistered = true;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (
        !document.hidden &&
        weatherCoordinates &&
        Date.now() - weatherLastAttemptAt >= WEATHER_REFRESH_MS
      )
        refreshWeather().catch(handleLocalDataError);
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
      if (
        weatherCoordinates &&
        [weatherState, airState].some((state) => state.stale || state.status === 'error') &&
        Date.now() - weatherLastAttemptAt >= 30000
      )
        refreshWeather().catch(handleLocalDataError);
    });
  }
}

function handleLocalDataError(error: unknown) {
  if (disposed) return;
  console.warn('Local conditions could not update.', error);
  for (const state of [weatherState, airState])
    setLocalDataFailure(state, 'Local conditions are unavailable');
}

function getMoonPhase(date = new Date()) {
  const rad = Math.PI / 180;
  const d = date.valueOf() / 86400000 + 2440587.5 - 2451545;
  const e = rad * 23.4397;
  const rightAscension = (l: number, b: number) =>
    Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const declination = (l: number, b: number) =>
    Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  const solarMeanAnomaly = rad * (357.5291 + 0.98560028 * d);
  const solarLongitude =
    solarMeanAnomaly +
    rad *
      (1.9148 * Math.sin(solarMeanAnomaly) +
        0.02 * Math.sin(2 * solarMeanAnomaly) +
        0.0003 * Math.sin(3 * solarMeanAnomaly) +
        102.9372) +
    Math.PI;
  const sun = { ra: rightAscension(solarLongitude, 0), dec: declination(solarLongitude, 0) };
  const moonMeanLongitude = rad * (218.316 + 13.176396 * d);
  const moonMeanAnomaly = rad * (134.963 + 13.064993 * d);
  const moonMeanDistance = rad * (93.272 + 13.22935 * d);
  const moonLongitude = moonMeanLongitude + rad * 6.289 * Math.sin(moonMeanAnomaly);
  const moonLatitude = rad * 5.128 * Math.sin(moonMeanDistance);
  const moon = {
    ra: rightAscension(moonLongitude, moonLatitude),
    dec: declination(moonLongitude, moonLatitude),
    distance: 385001 - 20905 * Math.cos(moonMeanAnomaly),
  };
  const separationCos =
    Math.sin(sun.dec) * Math.sin(moon.dec) +
    Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra);
  const separation = Math.acos(Math.max(-1, Math.min(1, separationCos)));
  const incidence = Math.atan2(
    149598000 * Math.sin(separation),
    moon.distance - 149598000 * Math.cos(separation),
  );
  const angle = Math.atan2(
    Math.cos(sun.dec) * Math.sin(sun.ra - moon.ra),
    Math.sin(sun.dec) * Math.cos(moon.dec) -
      Math.cos(sun.dec) * Math.sin(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const fraction = Math.max(0, Math.min(1, (1 + Math.cos(incidence)) / 2));
  const phase = 0.5 + (0.5 * incidence * (angle < 0 ? -1 : 1)) / Math.PI;
  const labels = [
    'New Moon',
    'Waxing Crescent',
    'First Quarter',
    'Waxing Gibbous',
    'Full Moon',
    'Waning Gibbous',
    'Last Quarter',
    'Waning Crescent',
  ];
  return { fraction, phase, waxing: phase < 0.5, label: labels[Math.round(phase * 8) % 8] };
}

function drawMoon(
  ctx: CanvasContext,
  cx: number,
  cy: number,
  radius: number,
  phaseData: MoonPhase,
  southernHemisphere = false,
) {
  if (!(radius > 0)) return;
  const fraction = Math.max(0, Math.min(1, phaseData.fraction));
  const direction = (phaseData.waxing ? 1 : -1) * (southernHemisphere ? -1 : 1);
  const k = 0.552284749831;
  const r = radius;
  const terminatorX = direction * (1 - 2 * fraction) * r;
  const brightPath = () => {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.bezierCurveTo(
      cx + direction * k * r,
      cy - r,
      cx + direction * r,
      cy - k * r,
      cx + direction * r,
      cy,
    );
    ctx.bezierCurveTo(cx + direction * r, cy + k * r, cx + direction * k * r, cy + r, cx, cy + r);
    ctx.bezierCurveTo(
      cx + k * terminatorX,
      cy + r,
      cx + terminatorX,
      cy + k * r,
      cx + terminatorX,
      cy,
    );
    ctx.bezierCurveTo(cx + terminatorX, cy - k * r, cx + k * terminatorX, cy - r, cx, cy - r);
    ctx.closePath();
  };
  ctx.save();

  const earthshine = ctx.createRadialGradient(cx - r * 0.32, cy - r * 0.36, r * 0.05, cx, cy, r);
  earthshine.addColorStop(0, 'rgba(96,150,207,0.22)');
  earthshine.addColorStop(1, 'rgba(17,44,91,0.34)');
  ctx.fillStyle = earthshine;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  if (fraction > 0.00001) {
    const lunarLight = ctx.createRadialGradient(
      cx + direction * r * 0.32,
      cy - r * 0.38,
      r * 0.08,
      cx,
      cy,
      r * 1.18,
    );
    lunarLight.addColorStop(0, '#ffffff');
    lunarLight.addColorStop(0.6, '#edf6ff');
    lunarLight.addColorStop(1, '#a9ccef');
    brightPath();
    ctx.fillStyle = lunarLight;
    ctx.shadowColor = 'rgba(157,210,255,0.2)';
    ctx.shadowBlur = r * 0.1;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.save();
    brightPath();
    ctx.clip();
    const marks = [
      [-0.29, -0.3, 0.23, 0.18, -0.45, 0.065],
      [0.08, -0.42, 0.17, 0.22, 0.4, 0.045],
      [0.35, -0.03, 0.2, 0.15, -0.25, 0.045],
      [-0.38, 0.12, 0.12, 0.16, 0.22, 0.04],
      [0.13, 0.34, 0.085, 0.07, 0, 0.065],
      [-0.16, 0.56, 0.06, 0.045, -0.4, 0.05],
    ];
    for (const [x, y, rx, ry, rotation, opacity] of marks) {
      const px = cx + x * r;
      const py = cy + y * r;
      const shade = ctx.createRadialGradient(px, py, 0, px, py, Math.max(rx, ry) * r);
      shade.addColorStop(0, 'rgba(52,83,119,' + opacity + ')');
      shade.addColorStop(1, 'rgba(52,83,119,0)');
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.ellipse(px, py, rx * r, ry * r, rotation, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

function createFilmGrainTile() {
  const size = 190;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = context(canvas);
  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  for (let i = 0; i < data.length; i += 4) {
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.random();
    const normal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const v = Math.min(255, Math.max(0, Math.round(128 + normal * 38)));
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = Math.min(255, v + 8);
    data[i + 3] = 215;
  }

  ctx.putImageData(imgData, 0, 0);
  const grainEl = element('grainLayer', 'div');
  if (grainEl) {
    grainEl.style.backgroundImage = `url(${canvas.toDataURL('image/png')})`;
  }
}

const clockCanvas = element('opticalClockCanvas', 'canvas');
const clockCtx = context(clockCanvas);

const DIGIT_TRANSITION_MS = 1000;
const SECONDS_FONT_SCALE = 0.24;
const SECONDS_GAP_SCALE = 0.16;
const SECONDS_CENTER_WEIGHT = 0.7;
const SECONDS_MORPH_MS = 320;

const SECONDS_DIGITS: Record<string, VectorDigit> = {
  '0': {
    glyph: 'zero',
    advance: 0.672,
    bounds: [0.049, -0.732, 0.623, 0.016],
    contours: [
      [
        [0.336, 0.016, 0.292, 0.016, 0.25233333333333335, 0.0065, 0.217, -0.0125],
        [
          0.217, -0.0125, 0.18166666666666667, -0.0315, 0.1515, -0.057833333333333334, 0.1265,
          -0.0915,
        ],
        [
          0.1265, -0.0915, 0.1015, -0.12516666666666665, 0.08233333333333333, -0.16466666666666666,
          0.069, -0.21,
        ],
        [
          0.069, -0.21, 0.05566666666666666, -0.25533333333333336, 0.049, -0.3043333333333333,
          0.049, -0.357,
        ],
        [0.049, -0.357, 0.049, -0.411, 0.05566666666666666, -0.46066666666666667, 0.069, -0.506],
        [0.069, -0.506, 0.08233333333333333, -0.5513333333333333, 0.1015, -0.591, 0.1265, -0.625],
        [0.1265, -0.625, 0.1515, -0.659, 0.18166666666666667, -0.6853333333333333, 0.217, -0.704],
        [0.217, -0.704, 0.25233333333333335, -0.7226666666666667, 0.292, -0.732, 0.336, -0.732],
        [0.336, -0.732, 0.38, -0.732, 0.4196666666666667, -0.7226666666666667, 0.455, -0.704],
        [0.455, -0.704, 0.4903333333333333, -0.6853333333333333, 0.5205, -0.659, 0.5455, -0.625],
        [0.5455, -0.625, 0.5705, -0.591, 0.5896666666666667, -0.5513333333333333, 0.603, -0.506],
        [0.603, -0.506, 0.6163333333333334, -0.46066666666666667, 0.623, -0.411, 0.623, -0.357],
        [
          0.623, -0.357, 0.623, -0.3043333333333333, 0.6163333333333334, -0.25533333333333336,
          0.603, -0.21,
        ],
        [
          0.603, -0.21, 0.5896666666666667, -0.16466666666666666, 0.5705, -0.12516666666666665,
          0.5455, -0.0915,
        ],
        [
          0.5455, -0.0915, 0.5205, -0.057833333333333334, 0.4903333333333333, -0.0315, 0.455,
          -0.0125,
        ],
        [0.455, -0.0125, 0.4196666666666667, 0.0065, 0.38, 0.016, 0.336, 0.016],
      ],
      [
        [0.336, -0.107, 0.3686666666666667, -0.107, 0.39666666666666667, -0.118, 0.42, -0.14],
        [0.42, -0.14, 0.4433333333333333, -0.162, 0.46116666666666667, -0.192, 0.4735, -0.23],
        [0.4735, -0.23, 0.48583333333333334, -0.268, 0.492, -0.3106666666666667, 0.492, -0.358],
        [
          0.492, -0.358, 0.492, -0.4066666666666667, 0.48583333333333334, -0.4498333333333333,
          0.4735, -0.4875,
        ],
        [
          0.4735, -0.4875, 0.46116666666666667, -0.5251666666666667, 0.4433333333333333,
          -0.5548333333333334, 0.42, -0.5765,
        ],
        [
          0.42, -0.5765, 0.39666666666666667, -0.5981666666666666, 0.3686666666666667, -0.609,
          0.336, -0.609,
        ],
        [0.336, -0.609, 0.304, -0.609, 0.2763333333333333, -0.5981666666666666, 0.253, -0.5765],
        [
          0.253, -0.5765, 0.22966666666666666, -0.5548333333333334, 0.21183333333333335,
          -0.5251666666666667, 0.1995, -0.4875,
        ],
        [
          0.1995, -0.4875, 0.18716666666666665, -0.4498333333333333, 0.181, -0.4066666666666667,
          0.181, -0.358,
        ],
        [0.181, -0.358, 0.181, -0.3106666666666667, 0.18716666666666665, -0.268, 0.1995, -0.23],
        [0.1995, -0.23, 0.21183333333333335, -0.192, 0.22966666666666666, -0.162, 0.253, -0.14],
        [0.253, -0.14, 0.2763333333333333, -0.118, 0.304, -0.107, 0.336, -0.107],
      ],
    ],
  },
  '1': {
    glyph: 'one',
    advance: 0.46,
    bounds: [0.04, -0.716, 0.34, 0],
    contours: [
      [
        [0.209, 0, 0.209, -0.18166666666666667, 0.209, -0.36333333333333334, 0.209, -0.545],
        [0.209, -0.545, 0.17466666666666666, -0.52, 0.1403333333333333, -0.495, 0.106, -0.47],
        [0.106, -0.47, 0.084, -0.5036666666666667, 0.062, -0.5373333333333333, 0.04, -0.571],
        [0.04, -0.571, 0.107, -0.6193333333333334, 0.174, -0.6676666666666666, 0.241, -0.716],
        [0.241, -0.716, 0.274, -0.716, 0.307, -0.716, 0.34, -0.716],
        [0.34, -0.716, 0.34, -0.4773333333333334, 0.34, -0.2386666666666667, 0.34, 0],
        [0.34, 0, 0.29633333333333334, 0, 0.2526666666666667, 0, 0.209, 0],
      ],
    ],
  },
  '2': {
    glyph: 'two',
    advance: 0.554,
    bounds: [0.045, -0.732, 0.505, 0],
    contours: [
      [
        [0.051, 0, 0.051, -0.03966666666666666, 0.051, -0.07933333333333333, 0.051, -0.119],
        [
          0.051, -0.119, 0.052333333333333336, -0.12033333333333333, 0.058333333333333334, -0.1265,
          0.069, -0.1375,
        ],
        [
          0.069, -0.1375, 0.07966666666666668, -0.1485, 0.09316666666666668, -0.16266666666666665,
          0.1095, -0.18,
        ],
        [0.1095, -0.18, 0.12583333333333332, -0.19733333333333333, 0.1435, -0.216, 0.1625, -0.236],
        [0.1625, -0.236, 0.1815, -0.256, 0.20016666666666666, -0.2755, 0.2185, -0.2945],
        [
          0.2185, -0.2945, 0.23683333333333334, -0.3135, 0.25333333333333335, -0.33066666666666666,
          0.268, -0.346,
        ],
        [
          0.268, -0.346, 0.2826666666666667, -0.36133333333333334, 0.29333333333333333,
          -0.3726666666666667, 0.3, -0.38,
        ],
        [
          0.3, -0.38, 0.3233333333333333, -0.4046666666666667, 0.3396666666666667, -0.4275, 0.349,
          -0.4485,
        ],
        [0.349, -0.4485, 0.35833333333333334, -0.4695, 0.363, -0.4913333333333333, 0.363, -0.514],
        [
          0.363, -0.514, 0.363, -0.5286666666666666, 0.35933333333333334, -0.5433333333333333,
          0.352, -0.558,
        ],
        [
          0.352, -0.558, 0.3446666666666667, -0.5726666666666667, 0.3338333333333333,
          -0.5848333333333333, 0.3195, -0.5945,
        ],
        [0.3195, -0.5945, 0.3051666666666667, -0.6041666666666666, 0.288, -0.609, 0.268, -0.609],
        [0.268, -0.609, 0.248, -0.609, 0.231, -0.605, 0.217, -0.597],
        [0.217, -0.597, 0.203, -0.589, 0.19166666666666665, -0.5786666666666667, 0.183, -0.566],
        [
          0.183, -0.566, 0.17433333333333334, -0.5533333333333333, 0.16766666666666666,
          -0.5396666666666666, 0.163, -0.525,
        ],
        [
          0.163, -0.525, 0.12366666666666666, -0.5413333333333333, 0.08433333333333333,
          -0.5576666666666666, 0.045, -0.574,
        ],
        [0.045, -0.574, 0.050333333333333334, -0.592, 0.059, -0.6103333333333334, 0.071, -0.629],
        [
          0.071, -0.629, 0.083, -0.6476666666666666, 0.09833333333333333, -0.6648333333333334,
          0.117, -0.6805,
        ],
        [
          0.117, -0.6805, 0.13566666666666666, -0.6961666666666666, 0.15783333333333335,
          -0.7086666666666667, 0.1835, -0.718,
        ],
        [0.1835, -0.718, 0.20916666666666667, -0.7273333333333334, 0.238, -0.732, 0.27, -0.732],
        [0.27, -0.732, 0.3166666666666667, -0.732, 0.35683333333333334, -0.722, 0.3905, -0.702],
        [0.3905, -0.702, 0.4241666666666667, -0.682, 0.45016666666666666, -0.656, 0.4685, -0.624],
        [0.4685, -0.624, 0.48683333333333334, -0.592, 0.496, -0.5573333333333333, 0.496, -0.52],
        [0.496, -0.52, 0.496, -0.492, 0.4911666666666667, -0.4645, 0.4815, -0.4375],
        [0.4815, -0.4375, 0.4718333333333333, -0.4105, 0.4588333333333333, -0.385, 0.4425, -0.361],
        [0.4425, -0.361, 0.4261666666666667, -0.337, 0.408, -0.3143333333333333, 0.388, -0.293],
        [
          0.388, -0.293, 0.3786666666666667, -0.2823333333333333, 0.3678333333333333,
          -0.27066666666666667, 0.3555, -0.258,
        ],
        [
          0.3555, -0.258, 0.3431666666666667, -0.24533333333333335, 0.33066666666666666,
          -0.23216666666666666, 0.318, -0.2185,
        ],
        [
          0.318, -0.2185, 0.3053333333333333, -0.20483333333333334, 0.293, -0.19166666666666665,
          0.281, -0.179,
        ],
        [
          0.281, -0.179, 0.269, -0.16633333333333333, 0.2581666666666667, -0.15483333333333335,
          0.2485, -0.1445,
        ],
        [
          0.2485, -0.1445, 0.23883333333333334, -0.13416666666666666, 0.231, -0.12633333333333333,
          0.225, -0.121,
        ],
        [0.225, -0.121, 0.226, -0.119, 0.227, -0.117, 0.228, -0.115],
        [0.228, -0.115, 0.3203333333333333, -0.115, 0.4126666666666666, -0.115, 0.505, -0.115],
        [0.505, -0.115, 0.505, -0.07666666666666666, 0.505, -0.03833333333333333, 0.505, 0],
        [0.505, 0, 0.35366666666666663, 0, 0.2023333333333333, 0, 0.051, 0],
      ],
    ],
  },
  '3': {
    glyph: 'three',
    advance: 0.578,
    bounds: [0.039, -0.732, 0.524, 0.016],
    contours: [
      [
        [0.284, 0.016, 0.24733333333333335, 0.016, 0.2125, 0.009333333333333334, 0.1795, -0.004],
        [
          0.1795, -0.004, 0.1465, -0.017333333333333336, 0.11783333333333333, -0.03733333333333333,
          0.0935, -0.064,
        ],
        [0.0935, -0.064, 0.06916666666666667, -0.09066666666666667, 0.051, -0.124, 0.039, -0.164],
        [
          0.039, -0.164, 0.08033333333333334, -0.18033333333333335, 0.12166666666666667,
          -0.19666666666666666, 0.163, -0.213,
        ],
        [0.163, -0.213, 0.171, -0.18033333333333335, 0.1855, -0.15516666666666665, 0.2065, -0.1375],
        [0.2065, -0.1375, 0.2275, -0.11983333333333333, 0.25333333333333335, -0.111, 0.284, -0.111],
        [0.284, -0.111, 0.3026666666666667, -0.111, 0.32, -0.115, 0.336, -0.123],
        [0.336, -0.123, 0.352, -0.131, 0.365, -0.14216666666666666, 0.375, -0.1565],
        [0.375, -0.1565, 0.385, -0.17083333333333334, 0.39, -0.188, 0.39, -0.208],
        [0.39, -0.208, 0.39, -0.22866666666666666, 0.3848333333333333, -0.2465, 0.3745, -0.2615],
        [
          0.3745, -0.2615, 0.3641666666666667, -0.2765, 0.34983333333333333, -0.2881666666666667,
          0.3315, -0.2965,
        ],
        [
          0.3315, -0.2965, 0.3131666666666667, -0.3048333333333333, 0.29133333333333333, -0.309,
          0.266, -0.309,
        ],
        [0.266, -0.309, 0.24633333333333335, -0.309, 0.22666666666666666, -0.309, 0.207, -0.309],
        [0.207, -0.309, 0.207, -0.3486666666666667, 0.207, -0.3883333333333333, 0.207, -0.428],
        [0.207, -0.428, 0.225, -0.428, 0.243, -0.428, 0.261, -0.428],
        [
          0.261, -0.428, 0.2796666666666667, -0.428, 0.29683333333333334, -0.4318333333333333,
          0.3125, -0.4395,
        ],
        [
          0.3125, -0.4395, 0.32816666666666666, -0.4471666666666667, 0.341, -0.4583333333333333,
          0.351, -0.473,
        ],
        [0.351, -0.473, 0.361, -0.4876666666666667, 0.366, -0.5046666666666667, 0.366, -0.524],
        [
          0.366, -0.524, 0.366, -0.5406666666666666, 0.36233333333333334, -0.5556666666666666,
          0.355, -0.569,
        ],
        [
          0.355, -0.569, 0.3476666666666667, -0.5823333333333334, 0.3373333333333333,
          -0.5928333333333333, 0.324, -0.6005,
        ],
        [0.324, -0.6005, 0.3106666666666667, -0.6081666666666666, 0.295, -0.612, 0.277, -0.612],
        [0.277, -0.612, 0.257, -0.612, 0.24033333333333334, -0.6075, 0.227, -0.5985],
        [
          0.227, -0.5985, 0.21366666666666664, -0.5895, 0.20283333333333334, -0.5783333333333334,
          0.1945, -0.565,
        ],
        [
          0.1945, -0.565, 0.18616666666666665, -0.5516666666666666, 0.18, -0.5383333333333333,
          0.176, -0.525,
        ],
        [
          0.176, -0.525, 0.13633333333333333, -0.5413333333333333, 0.09666666666666666,
          -0.5576666666666666, 0.057, -0.574,
        ],
        [
          0.057, -0.574, 0.065, -0.5966666666666667, 0.07833333333333332, -0.6201666666666666,
          0.097, -0.6445,
        ],
        [0.097, -0.6445, 0.11566666666666667, -0.6688333333333334, 0.14, -0.6895, 0.17, -0.7065],
        [0.17, -0.7065, 0.2, -0.7235, 0.236, -0.732, 0.278, -0.732],
        [0.278, -0.732, 0.322, -0.732, 0.3605, -0.7231666666666666, 0.3935, -0.7055],
        [
          0.3935, -0.7055, 0.4265, -0.6878333333333334, 0.4523333333333333, -0.6643333333333333,
          0.471, -0.635,
        ],
        [
          0.471, -0.635, 0.4896666666666667, -0.6056666666666666, 0.499, -0.5736666666666667, 0.499,
          -0.539,
        ],
        [
          0.499, -0.539, 0.499, -0.5123333333333334, 0.4946666666666667, -0.4881666666666667, 0.486,
          -0.4665,
        ],
        [
          0.486, -0.4665, 0.47733333333333333, -0.4448333333333333, 0.4665, -0.4265, 0.4535,
          -0.4115,
        ],
        [0.4535, -0.4115, 0.4405, -0.3965, 0.4266666666666667, -0.3853333333333333, 0.412, -0.378],
        [0.412, -0.378, 0.412, -0.3753333333333333, 0.412, -0.3726666666666667, 0.412, -0.37],
        [
          0.412, -0.37, 0.4333333333333333, -0.362, 0.4523333333333333, -0.3496666666666667, 0.469,
          -0.333,
        ],
        [0.469, -0.333, 0.4856666666666667, -0.3163333333333333, 0.499, -0.2965, 0.509, -0.2735],
        [0.509, -0.2735, 0.519, -0.2505, 0.524, -0.22466666666666665, 0.524, -0.196],
        [0.524, -0.196, 0.524, -0.15666666666666665, 0.514, -0.12083333333333335, 0.494, -0.0885],
        [0.494, -0.0885, 0.474, -0.05616666666666666, 0.446, -0.03066666666666667, 0.41, -0.012],
        [0.41, -0.012, 0.374, 0.006666666666666668, 0.332, 0.016, 0.284, 0.016],
      ],
    ],
  },
  '4': {
    glyph: 'four',
    advance: 0.624,
    bounds: [0.045, -0.716, 0.576, 0],
    contours: [
      [
        [0.045, -0.146, 0.045, -0.18133333333333335, 0.045, -0.21666666666666667, 0.045, -0.252],
        [
          0.045, -0.252, 0.14633333333333332, -0.4066666666666666, 0.24766666666666665,
          -0.5613333333333332, 0.349, -0.716,
        ],
        [0.349, -0.716, 0.3963333333333333, -0.716, 0.4436666666666667, -0.716, 0.491, -0.716],
        [0.491, -0.716, 0.491, -0.4773333333333334, 0.491, -0.2386666666666667, 0.491, 0],
        [0.491, 0, 0.4473333333333333, 0, 0.4036666666666667, 0, 0.36, 0],
        [0.36, 0, 0.36, -0.17366666666666666, 0.36, -0.3473333333333333, 0.36, -0.521],
        [0.36, -0.521, 0.35733333333333334, -0.521, 0.3546666666666667, -0.521, 0.352, -0.521],
        [0.352, -0.521, 0.298, -0.4366666666666667, 0.244, -0.3523333333333334, 0.19, -0.268],
        [0.19, -0.268, 0.31866666666666665, -0.268, 0.4473333333333333, -0.268, 0.576, -0.268],
        [0.576, -0.268, 0.576, -0.22733333333333333, 0.576, -0.18666666666666668, 0.576, -0.146],
        [0.576, -0.146, 0.399, -0.146, 0.222, -0.146, 0.045, -0.146],
      ],
    ],
  },
  '5': {
    glyph: 'five',
    advance: 0.575,
    bounds: [0.045, -0.716, 0.53, 0.016],
    contours: [
      [
        [0.288, 0.016, 0.254, 0.016, 0.22016666666666665, 0.009, 0.1865, -0.005],
        [0.1865, -0.005, 0.15283333333333335, -0.019, 0.12333333333333332, -0.04, 0.098, -0.068],
        [0.098, -0.068, 0.07266666666666667, -0.096, 0.055, -0.13133333333333333, 0.045, -0.174],
        [
          0.045, -0.174, 0.08433333333333334, -0.18933333333333335, 0.12366666666666667,
          -0.20466666666666666, 0.163, -0.22,
        ],
        [
          0.163, -0.22, 0.17033333333333334, -0.18733333333333335, 0.18466666666666665, -0.16,
          0.206, -0.138,
        ],
        [0.206, -0.138, 0.22733333333333333, -0.116, 0.25433333333333336, -0.105, 0.287, -0.105],
        [0.287, -0.105, 0.3183333333333333, -0.105, 0.3448333333333333, -0.1165, 0.3665, -0.1395],
        [0.3665, -0.1395, 0.38816666666666666, -0.1625, 0.399, -0.19033333333333335, 0.399, -0.223],
        [
          0.399, -0.223, 0.399, -0.24433333333333335, 0.3943333333333333, -0.26416666666666666,
          0.385, -0.2825,
        ],
        [
          0.385, -0.2825, 0.3756666666666667, -0.30083333333333334, 0.3625, -0.3155, 0.3455,
          -0.3265,
        ],
        [0.3455, -0.3265, 0.3285, -0.3375, 0.309, -0.343, 0.287, -0.343],
        [0.287, -0.343, 0.2663333333333333, -0.343, 0.248, -0.33866666666666667, 0.232, -0.33],
        [
          0.232, -0.33, 0.216, -0.3213333333333333, 0.20233333333333334, -0.3103333333333333, 0.191,
          -0.297,
        ],
        [0.191, -0.297, 0.14866666666666667, -0.316, 0.10633333333333334, -0.335, 0.064, -0.354],
        [0.064, -0.354, 0.077, -0.4746666666666667, 0.09, -0.5953333333333334, 0.103, -0.716],
        [0.103, -0.716, 0.23166666666666666, -0.716, 0.36033333333333334, -0.716, 0.489, -0.716],
        [0.489, -0.716, 0.489, -0.6776666666666666, 0.489, -0.6393333333333334, 0.489, -0.601],
        [0.489, -0.601, 0.39666666666666667, -0.601, 0.30433333333333334, -0.601, 0.212, -0.601],
        [0.212, -0.601, 0.20366666666666666, -0.541, 0.19533333333333333, -0.481, 0.187, -0.421],
        [
          0.187, -0.421, 0.18966666666666665, -0.42033333333333334, 0.19233333333333336,
          -0.4196666666666667, 0.195, -0.419,
        ],
        [
          0.195, -0.419, 0.20833333333333334, -0.4303333333333333, 0.22483333333333333, -0.44,
          0.2445, -0.448,
        ],
        [0.2445, -0.448, 0.26416666666666666, -0.456, 0.28733333333333333, -0.46, 0.314, -0.46],
        [0.314, -0.46, 0.352, -0.46, 0.3873333333333333, -0.4498333333333333, 0.42, -0.4295],
        [
          0.42, -0.4295, 0.45266666666666666, -0.4091666666666667, 0.4791666666666667,
          -0.3811666666666667, 0.4995, -0.3455,
        ],
        [0.4995, -0.3455, 0.5198333333333334, -0.3098333333333333, 0.53, -0.269, 0.53, -0.223],
        [
          0.53, -0.223, 0.53, -0.17766666666666667, 0.5196666666666666, -0.13683333333333333, 0.499,
          -0.1005,
        ],
        [
          0.499, -0.1005, 0.47833333333333333, -0.06416666666666666, 0.4498333333333333,
          -0.03566666666666667, 0.4135, -0.015,
        ],
        [
          0.4135, -0.015, 0.3771666666666667, 0.005666666666666668, 0.3353333333333333, 0.016,
          0.288, 0.016,
        ],
      ],
    ],
  },
  '6': {
    glyph: 'six',
    advance: 0.577,
    bounds: [0.045, -0.738, 0.532, 0.016],
    contours: [
      [
        [0.291, 0.016, 0.253, 0.016, 0.2185, 0.009166666666666667, 0.1875, -0.0045],
        [
          0.1875, -0.0045, 0.1565, -0.018166666666666664, 0.13033333333333336, -0.03633333333333333,
          0.109, -0.059,
        ],
        [
          0.109, -0.059, 0.08833333333333333, -0.08033333333333333, 0.0725, -0.10616666666666667,
          0.0615, -0.1365,
        ],
        [0.0615, -0.1365, 0.0505, -0.16683333333333333, 0.045, -0.19733333333333333, 0.045, -0.228],
        [0.045, -0.228, 0.045, -0.274, 0.05466666666666667, -0.317, 0.074, -0.357],
        [0.074, -0.357, 0.09333333333333332, -0.397, 0.116, -0.4376666666666667, 0.142, -0.479],
        [0.142, -0.479, 0.15466666666666665, -0.499, 0.16766666666666666, -0.52, 0.181, -0.542],
        [
          0.181, -0.542, 0.19433333333333333, -0.564, 0.20816666666666667, -0.5861666666666666,
          0.2225, -0.6085,
        ],
        [0.2225, -0.6085, 0.23683333333333334, -0.6308333333333334, 0.251, -0.653, 0.265, -0.675],
        [0.265, -0.675, 0.279, -0.697, 0.293, -0.718, 0.307, -0.738],
        [0.307, -0.738, 0.341, -0.7146666666666667, 0.375, -0.6913333333333334, 0.409, -0.668],
        [0.409, -0.668, 0.399, -0.652, 0.388, -0.6345, 0.376, -0.6155],
        [0.376, -0.6155, 0.364, -0.5965, 0.3515, -0.577, 0.3385, -0.557],
        [0.3385, -0.557, 0.3255, -0.537, 0.313, -0.5176666666666666, 0.301, -0.499],
        [0.301, -0.499, 0.289, -0.48033333333333333, 0.278, -0.4633333333333333, 0.268, -0.448],
        [0.268, -0.448, 0.27, -0.446, 0.272, -0.444, 0.274, -0.442],
        [
          0.274, -0.442, 0.2813333333333333, -0.4453333333333333, 0.28933333333333333,
          -0.4478333333333333, 0.298, -0.4495,
        ],
        [0.298, -0.4495, 0.3066666666666667, -0.45116666666666666, 0.316, -0.452, 0.326, -0.452],
        [0.326, -0.452, 0.3606666666666667, -0.452, 0.39366666666666666, -0.442, 0.425, -0.422],
        [0.425, -0.422, 0.4563333333333333, -0.402, 0.482, -0.3748333333333333, 0.502, -0.3405],
        [0.502, -0.3405, 0.522, -0.3061666666666667, 0.532, -0.267, 0.532, -0.223],
        [0.532, -0.223, 0.532, -0.189, 0.5255, -0.15733333333333335, 0.5125, -0.128],
        [
          0.5125, -0.128, 0.4995, -0.09866666666666667, 0.4816666666666667, -0.07333333333333333,
          0.459, -0.052,
        ],
        [0.459, -0.052, 0.4363333333333333, -0.03066666666666667, 0.4105, -0.014, 0.3815, -0.002],
        [0.3815, -0.002, 0.3525, 0.01, 0.3223333333333333, 0.016, 0.291, 0.016],
      ],
      [
        [
          0.288, -0.104, 0.3086666666666667, -0.104, 0.32766666666666666, -0.10916666666666668,
          0.345, -0.1195,
        ],
        [0.345, -0.1195, 0.36233333333333334, -0.12983333333333336, 0.3765, -0.144, 0.3875, -0.162],
        [0.3875, -0.162, 0.3985, -0.18, 0.404, -0.2, 0.404, -0.222],
        [0.404, -0.222, 0.404, -0.24466666666666664, 0.3985, -0.26516666666666666, 0.3875, -0.2835],
        [
          0.3875, -0.2835, 0.3765, -0.3018333333333333, 0.3621666666666667, -0.3163333333333333,
          0.3445, -0.327,
        ],
        [0.3445, -0.327, 0.3268333333333333, -0.33766666666666667, 0.308, -0.343, 0.288, -0.343],
        [
          0.288, -0.343, 0.26866666666666666, -0.343, 0.25016666666666665, -0.33766666666666667,
          0.2325, -0.327,
        ],
        [
          0.2325, -0.327, 0.21483333333333335, -0.3163333333333333, 0.2005, -0.3018333333333333,
          0.1895, -0.2835,
        ],
        [0.1895, -0.2835, 0.1785, -0.26516666666666666, 0.173, -0.24466666666666664, 0.173, -0.222],
        [0.173, -0.222, 0.173, -0.2, 0.1785, -0.18, 0.1895, -0.162],
        [0.1895, -0.162, 0.2005, -0.144, 0.21466666666666664, -0.12983333333333336, 0.232, -0.1195],
        [0.232, -0.1195, 0.24933333333333335, -0.10916666666666668, 0.268, -0.104, 0.288, -0.104],
      ],
    ],
  },
  '7': {
    glyph: 'seven',
    advance: 0.555,
    bounds: [0.045, -0.716, 0.51, 0.016],
    contours: [
      [
        [
          0.184, 0.016, 0.14733333333333334, -0.004333333333333332, 0.11066666666666668,
          -0.024666666666666663, 0.074, -0.045,
        ],
        [0.074, -0.045, 0.106, -0.105, 0.138, -0.16516666666666666, 0.17, -0.2255],
        [
          0.17, -0.2255, 0.202, -0.28583333333333333, 0.23416666666666666, -0.3461666666666667,
          0.2665, -0.4065,
        ],
        [0.2665, -0.4065, 0.29883333333333334, -0.4668333333333333, 0.331, -0.527, 0.363, -0.587],
        [0.363, -0.587, 0.3616666666666667, -0.589, 0.36033333333333334, -0.591, 0.359, -0.593],
        [0.359, -0.593, 0.2543333333333333, -0.593, 0.14966666666666667, -0.593, 0.045, -0.593],
        [0.045, -0.593, 0.045, -0.634, 0.045, -0.675, 0.045, -0.716],
        [0.045, -0.716, 0.2, -0.716, 0.355, -0.716, 0.51, -0.716],
        [0.51, -0.716, 0.51, -0.673, 0.51, -0.63, 0.51, -0.587],
        [0.51, -0.587, 0.4826666666666667, -0.537, 0.4555, -0.48683333333333334, 0.4285, -0.4365],
        [
          0.4285, -0.4365, 0.4015, -0.38616666666666666, 0.3743333333333333, -0.3358333333333333,
          0.347, -0.2855,
        ],
        [
          0.347, -0.2855, 0.3196666666666667, -0.23516666666666666, 0.2925, -0.18483333333333335,
          0.2655, -0.1345,
        ],
        [0.2655, -0.1345, 0.2385, -0.08416666666666665, 0.21133333333333335, -0.034, 0.184, 0.016],
      ],
    ],
  },
  '8': {
    glyph: 'eight',
    advance: 0.604,
    bounds: [0.054, -0.732, 0.55, 0.016],
    contours: [
      [
        [0.302, 0.016, 0.25333333333333335, 0.016, 0.21033333333333334, 0.0065, 0.173, -0.0125],
        [0.173, -0.0125, 0.13566666666666666, -0.0315, 0.1065, -0.057, 0.0855, -0.089],
        [0.0855, -0.089, 0.0645, -0.121, 0.054, -0.15633333333333335, 0.054, -0.195],
        [0.054, -0.195, 0.054, -0.22366666666666665, 0.059, -0.24916666666666665, 0.069, -0.2715],
        [
          0.069, -0.2715, 0.079, -0.29383333333333334, 0.09183333333333332, -0.3133333333333333,
          0.1075, -0.33,
        ],
        [
          0.1075, -0.33, 0.12316666666666667, -0.3466666666666667, 0.14, -0.3596666666666667, 0.158,
          -0.369,
        ],
        [0.158, -0.369, 0.158, -0.3716666666666667, 0.158, -0.3743333333333333, 0.158, -0.377],
        [0.158, -0.377, 0.144, -0.387, 0.13083333333333333, -0.3998333333333333, 0.1185, -0.4155],
        [
          0.1185, -0.4155, 0.10616666666666667, -0.4311666666666667, 0.09616666666666668,
          -0.4488333333333333, 0.0885, -0.4685,
        ],
        [
          0.0885, -0.4685, 0.08083333333333333, -0.4881666666666667, 0.077, -0.5083333333333333,
          0.077, -0.529,
        ],
        [
          0.077, -0.529, 0.077, -0.5656666666666667, 0.08666666666666667, -0.5993333333333334,
          0.106, -0.63,
        ],
        [
          0.106, -0.63, 0.12533333333333332, -0.6606666666666666, 0.152, -0.6853333333333333, 0.186,
          -0.704,
        ],
        [0.186, -0.704, 0.22, -0.7226666666666667, 0.2586666666666667, -0.732, 0.302, -0.732],
        [
          0.302, -0.732, 0.3453333333333333, -0.732, 0.3838333333333333, -0.7226666666666667,
          0.4175, -0.704,
        ],
        [
          0.4175, -0.704, 0.45116666666666666, -0.6853333333333333, 0.47783333333333333,
          -0.6606666666666666, 0.4975, -0.63,
        ],
        [
          0.4975, -0.63, 0.5171666666666667, -0.5993333333333334, 0.527, -0.5656666666666667, 0.527,
          -0.529,
        ],
        [
          0.527, -0.529, 0.527, -0.5083333333333333, 0.5231666666666667, -0.4881666666666667,
          0.5155, -0.4685,
        ],
        [
          0.5155, -0.4685, 0.5078333333333334, -0.4488333333333333, 0.4978333333333333,
          -0.4311666666666667, 0.4855, -0.4155,
        ],
        [
          0.4855, -0.4155, 0.4731666666666667, -0.3998333333333333, 0.45966666666666667, -0.387,
          0.445, -0.377,
        ],
        [0.445, -0.377, 0.445, -0.3743333333333333, 0.445, -0.3716666666666667, 0.445, -0.369],
        [
          0.445, -0.369, 0.4643333333333333, -0.36033333333333334, 0.48183333333333334,
          -0.3476666666666667, 0.4975, -0.331,
        ],
        [
          0.4975, -0.331, 0.5131666666666667, -0.3143333333333333, 0.5258333333333334,
          -0.2946666666666667, 0.5355, -0.272,
        ],
        [
          0.5355, -0.272, 0.5451666666666666, -0.24933333333333335, 0.55, -0.22366666666666665,
          0.55, -0.195,
        ],
        [0.55, -0.195, 0.55, -0.15633333333333335, 0.5395, -0.121, 0.5185, -0.089],
        [0.5185, -0.089, 0.4975, -0.057, 0.4685, -0.0315, 0.4315, -0.0125],
        [0.4315, -0.0125, 0.3945, 0.0065, 0.35133333333333333, 0.016, 0.302, 0.016],
      ],
      [
        [0.302, -0.105, 0.32466666666666666, -0.105, 0.3446666666666667, -0.1095, 0.362, -0.1185],
        [0.362, -0.1185, 0.3793333333333333, -0.1275, 0.393, -0.13983333333333334, 0.403, -0.1555],
        [0.403, -0.1555, 0.413, -0.17116666666666666, 0.418, -0.18866666666666665, 0.418, -0.208],
        [
          0.418, -0.208, 0.418, -0.22666666666666666, 0.41283333333333333, -0.24383333333333335,
          0.4025, -0.2595,
        ],
        [
          0.4025, -0.2595, 0.39216666666666666, -0.27516666666666667, 0.3783333333333333,
          -0.2876666666666667, 0.361, -0.297,
        ],
        [0.361, -0.297, 0.3436666666666667, -0.3063333333333333, 0.324, -0.311, 0.302, -0.311],
        [0.302, -0.311, 0.28, -0.311, 0.2601666666666667, -0.3063333333333333, 0.2425, -0.297],
        [
          0.2425, -0.297, 0.22483333333333333, -0.2876666666666667, 0.21083333333333334,
          -0.27516666666666667, 0.2005, -0.2595,
        ],
        [
          0.2005, -0.2595, 0.19016666666666665, -0.24383333333333335, 0.185, -0.22666666666666666,
          0.185, -0.208,
        ],
        [0.185, -0.208, 0.185, -0.18866666666666665, 0.19, -0.17116666666666666, 0.2, -0.1555],
        [0.2, -0.1555, 0.21, -0.13983333333333334, 0.22383333333333336, -0.1275, 0.2415, -0.1185],
        [0.2415, -0.1185, 0.2591666666666667, -0.1095, 0.2793333333333333, -0.105, 0.302, -0.105],
      ],
      [
        [0.302, -0.426, 0.3293333333333333, -0.426, 0.3525, -0.4355, 0.3715, -0.4545],
        [0.3715, -0.4545, 0.3905, -0.4735, 0.4, -0.4956666666666667, 0.4, -0.521],
        [0.4, -0.521, 0.4, -0.547, 0.3905, -0.5691666666666666, 0.3715, -0.5875],
        [0.3715, -0.5875, 0.3525, -0.6058333333333333, 0.3293333333333333, -0.615, 0.302, -0.615],
        [0.302, -0.615, 0.274, -0.615, 0.2505, -0.6058333333333333, 0.2315, -0.5875],
        [0.2315, -0.5875, 0.2125, -0.5691666666666666, 0.203, -0.547, 0.203, -0.521],
        [
          0.203, -0.521, 0.203, -0.5043333333333333, 0.20733333333333334, -0.4886666666666667,
          0.216, -0.474,
        ],
        [
          0.216, -0.474, 0.22466666666666665, -0.4593333333333333, 0.2365, -0.4476666666666667,
          0.2515, -0.439,
        ],
        [0.2515, -0.439, 0.2665, -0.4303333333333333, 0.2833333333333333, -0.426, 0.302, -0.426],
      ],
    ],
  },
  '9': {
    glyph: 'nine',
    advance: 0.577,
    bounds: [0.045, -0.732, 0.532, 0.02],
    contours: [
      [
        [0.27, 0.02, 0.236, -0.0033333333333333322, 0.202, -0.026666666666666665, 0.168, -0.05],
        [
          0.168, -0.05, 0.17933333333333334, -0.06733333333333333, 0.191, -0.08533333333333333,
          0.203, -0.104,
        ],
        [0.203, -0.104, 0.215, -0.12266666666666667, 0.22716666666666666, -0.1415, 0.2395, -0.1605],
        [0.2395, -0.1605, 0.25183333333333335, -0.1795, 0.2638333333333333, -0.198, 0.2755, -0.216],
        [
          0.2755, -0.216, 0.2871666666666667, -0.234, 0.29833333333333334, -0.25133333333333335,
          0.309, -0.268,
        ],
        [0.309, -0.268, 0.307, -0.27, 0.305, -0.272, 0.303, -0.274],
        [0.303, -0.274, 0.29633333333333334, -0.2713333333333333, 0.2885, -0.269, 0.2795, -0.267],
        [0.2795, -0.267, 0.2705, -0.265, 0.261, -0.264, 0.251, -0.264],
        [0.251, -0.264, 0.21633333333333335, -0.264, 0.18333333333333335, -0.274, 0.152, -0.294],
        [0.152, -0.294, 0.12066666666666667, -0.314, 0.095, -0.3413333333333333, 0.075, -0.376],
        [0.075, -0.376, 0.055, -0.4106666666666667, 0.045, -0.44966666666666666, 0.045, -0.493],
        [0.045, -0.493, 0.045, -0.539, 0.056333333333333326, -0.58, 0.079, -0.616],
        [
          0.079, -0.616, 0.10166666666666667, -0.652, 0.13133333333333333, -0.6803333333333333,
          0.168, -0.701,
        ],
        [0.168, -0.701, 0.20466666666666666, -0.7216666666666667, 0.244, -0.732, 0.286, -0.732],
        [
          0.286, -0.732, 0.3253333333333333, -0.732, 0.36083333333333334, -0.7248333333333333,
          0.3925, -0.7105,
        ],
        [
          0.3925, -0.7105, 0.4241666666666667, -0.6961666666666666, 0.45066666666666666, -0.677,
          0.472, -0.653,
        ],
        [
          0.472, -0.653, 0.4913333333333333, -0.6316666666666666, 0.5061666666666667, -0.6065,
          0.5165, -0.5775,
        ],
        [0.5165, -0.5775, 0.5268333333333334, -0.5485, 0.532, -0.5186666666666666, 0.532, -0.488],
        [0.532, -0.488, 0.532, -0.442, 0.5223333333333333, -0.399, 0.503, -0.359],
        [0.503, -0.359, 0.4836666666666667, -0.319, 0.461, -0.2783333333333333, 0.435, -0.237],
        [0.435, -0.237, 0.41833333333333333, -0.211, 0.4005, -0.18316666666666664, 0.3815, -0.1535],
        [
          0.3815, -0.1535, 0.3625, -0.12383333333333332, 0.3433333333333333, -0.09416666666666668,
          0.324, -0.0645,
        ],
        [
          0.324, -0.0645, 0.3046666666666667, -0.03483333333333333, 0.2866666666666667,
          -0.006666666666666668, 0.27, 0.02,
        ],
      ],
      [
        [0.289, -0.373, 0.309, -0.373, 0.32766666666666666, -0.3783333333333333, 0.345, -0.389],
        [
          0.345, -0.389, 0.36233333333333334, -0.39966666666666667, 0.3765, -0.4141666666666667,
          0.3875, -0.4325,
        ],
        [0.3875, -0.4325, 0.3985, -0.4508333333333333, 0.404, -0.4713333333333333, 0.404, -0.494],
        [0.404, -0.494, 0.404, -0.5166666666666666, 0.3985, -0.5368333333333334, 0.3875, -0.5545],
        [
          0.3875, -0.5545, 0.3765, -0.5721666666666666, 0.36233333333333334, -0.5861666666666666,
          0.345, -0.5965,
        ],
        [0.345, -0.5965, 0.32766666666666666, -0.6068333333333333, 0.309, -0.612, 0.289, -0.612],
        [0.289, -0.612, 0.269, -0.612, 0.25016666666666665, -0.6068333333333333, 0.2325, -0.5965],
        [
          0.2325, -0.5965, 0.21483333333333335, -0.5861666666666666, 0.2005, -0.5721666666666666,
          0.1895, -0.5545,
        ],
        [0.1895, -0.5545, 0.1785, -0.5368333333333334, 0.173, -0.5166666666666666, 0.173, -0.494],
        [0.173, -0.494, 0.173, -0.4713333333333333, 0.1785, -0.4508333333333333, 0.1895, -0.4325],
        [
          0.1895, -0.4325, 0.2005, -0.4141666666666667, 0.21483333333333335, -0.39966666666666667,
          0.2325, -0.389,
        ],
        [0.2325, -0.389, 0.25016666666666665, -0.3783333333333333, 0.269, -0.373, 0.289, -0.373],
      ],
    ],
  },
};
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const BLUR_RADII = [0, 1.8, 4.5, 10, 19, 30];
const PASS_STOPS = [
  [
    [0, 0.1],
    [0.09, 0.55],
    [0.2, 1],
    [0.71, 1],
    [0.84, 0.25],
    [0.92, 0],
    [1, 0],
  ],
  [
    [0, 0.45],
    [0.1, 0.65],
    [0.24, 0],
    [0.64, 0],
    [0.77, 0.78],
    [0.91, 0.22],
    [1, 0],
  ],
  [
    [0, 0.52],
    [0.08, 0.38],
    [0.2, 0],
    [0.7, 0],
    [0.83, 0.82],
    [0.95, 0.46],
    [1, 0.16],
  ],
  [
    [0, 0.34],
    [0.06, 0.18],
    [0.15, 0],
    [0.75, 0],
    [0.88, 0.84],
    [1, 0.68],
  ],
  [
    [0, 0.16],
    [0.08, 0],
    [0.8, 0],
    [0.92, 0.76],
    [1, 0.85],
  ],
  [
    [0, 0.08],
    [0.06, 0],
    [0.84, 0],
    [0.95, 0.66],
    [1, 0.82],
  ],
];
const clockMetrics: ClockMetrics = {
  ready: false,
  topRightEdgeX: 0,
  topRightEdgeY: 0,
  bottomLeftEdgeX: 0,
  bottomLeftEdgeY: 0,
  glyphLeft: 0,
  glyphRight: 0,
  groupLeft: 0,
  groupRight: 0,
  glyphTop: 0,
  glyphBottom: 0,
  glyphWidth: 0,
  glyphHeight: 0,
  colonCenterX: 0,
  colonCenterY: 0,
  colonDotRadius: 0,
  colonDotOffset: 0,
};
let currentHourStr = '';
let currentMinuteStr = '';
let currentSecondStr = '';
let currentSecondsTile: SecondsTile | null = null;
let secondsMorph: SecondsMorph | null = null;
let secondsLastFrame: number | null = null;
let lastViewportW = 0;
let lastViewportH = 0;
let lastDpr = 0;
let currentClockScene: ClockScene | null = null;
let clockTransition: ClockTransition | null = null;
let fittedFont: FittedFont | null = null;

function getFormattedTimeParts() {
  const now = new Date();
  return {
    hours: String(now.getHours()).padStart(2, '0'),
    minutes: String(now.getMinutes()).padStart(2, '0'),
    seconds: String(now.getSeconds()).padStart(2, '0'),
  };
}

function smoothProgress(value: number) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function inkWidth(
  metrics: Pick<TextMetrics, 'width' | 'actualBoundingBoxLeft' | 'actualBoundingBoxRight'>,
) {
  return finite(metrics.actualBoundingBoxLeft) && finite(metrics.actualBoundingBoxRight)
    ? metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
    : metrics.width;
}

function useClockFont(ctx: CanvasContext, fontSpec: string) {
  ctx.font = fontSpec;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
}

function buildClockLayout(hoursStr: string, minutesStr: string, w: number, h: number) {
  if (!fittedFont || fittedFont.w !== w || fittedFont.h !== h) {
    let fontSize = Math.max(1, Math.min(w * 0.255, h * 0.44, 1200));
    useClockFont(clockCtx, `700 ${fontSize}px "Google Sans", sans-serif`);
    let widestPair = 0;
    for (let pair = 0; pair < 100; pair++) {
      widestPair = Math.max(
        widestPair,
        inkWidth(clockCtx.measureText(String(pair).padStart(2, '0'))),
      );
    }
    useClockFont(clockCtx, `700 ${fontSize * SECONDS_FONT_SCALE}px "Google Sans", sans-serif`);
    let widestSeconds = 0;
    for (let second = 0; second < 60; second++) {
      widestSeconds = Math.max(
        widestSeconds,
        inkWidth(clockCtx.measureText(String(second).padStart(2, '0'))),
      );
    }
    const widestClock = widestPair * 2 + fontSize * (0.27 + SECONDS_GAP_SCALE) + widestSeconds;
    fontSize *= Math.min(1, (w * 0.8) / widestClock);
    const secondsFontSize = fontSize * SECONDS_FONT_SCALE;
    const secondsFontSpec = `700 ${secondsFontSize}px "Google Sans", sans-serif`;
    useClockFont(clockCtx, secondsFontSpec);
    let secondsWidth = 0;
    for (let second = 0; second < 60; second++) {
      secondsWidth = Math.max(
        secondsWidth,
        inkWidth(clockCtx.measureText(String(second).padStart(2, '0'))),
      );
    }
    const secondsReference = clockCtx.measureText('0123456789');
    fittedFont = {
      w,
      h,
      fontSize,
      fontSpec: `700 ${fontSize}px "Google Sans", sans-serif`,
      secondsFontSize,
      secondsFontSpec,
      secondsWidth,
      secondsGap: fontSize * SECONDS_GAP_SCALE,
      secondsDescent: secondsReference.actualBoundingBoxDescent || secondsFontSize * 0.36,
    };
  }
  const {
    fontSize,
    fontSpec,
    secondsFontSize,
    secondsFontSpec,
    secondsWidth,
    secondsGap,
    secondsDescent,
  } = fittedFont;
  useClockFont(clockCtx, fontSpec);
  const hh = clockCtx.measureText(hoursStr);
  const mm = clockCtx.measureText(minutesStr);
  const hhWidth = inkWidth(hh);
  const mmWidth = inkWidth(mm);
  const colonGap = fontSize * 0.27;
  const width = hhWidth + colonGap + mmWidth;

  const reference = clockCtx.measureText('0123456789');
  const ascent = reference.actualBoundingBoxAscent || fontSize * 0.36;
  const descent = reference.actualBoundingBoxDescent || fontSize * 0.36;
  const anchorY = h * 0.5;
  const drawY = anchorY + (ascent - descent) * 0.5;

  const opticalCenterOffset = (secondsGap + secondsWidth) * (1 - SECONDS_CENTER_WEIGHT) * 0.5;
  const glyphLeft = (w - width - secondsGap - secondsWidth) * 0.5 + opticalCenterOffset;
  const glyphRight = glyphLeft + width;
  const glyphTop = anchorY - (ascent + descent) * 0.5;
  const glyphBottom = anchorY + (ascent + descent) * 0.5;
  const digits: ClockDigit[] = [];
  function addPair(text: string, x: number, pairMetrics: TextMetrics) {
    const first = clockCtx.measureText(text[0]);
    const second = clockCtx.measureText(text[1]);

    digits.push({ char: text[0], x, metrics: first });
    digits.push({ char: text[1], x: x + pairMetrics.width - second.width, metrics: second });
  }
  addPair(hoursStr, glyphLeft + (hh.actualBoundingBoxLeft || 0), hh);
  addPair(minutesStr, glyphLeft + hhWidth + colonGap + (mm.actualBoundingBoxLeft || 0), mm);
  return {
    fontSize,
    fontSpec,
    anchorY,
    drawY,
    glyphLeft,
    glyphRight,
    glyphTop,
    glyphBottom,
    digits,
    groupLeft: glyphLeft,
    groupRight: glyphRight + secondsGap + secondsWidth,
    opticalCenterOffset,
    secondsFontSize,
    secondsFontSpec,
    secondsWidth,
    secondsGap,
    secondsDescent,
    colonCenterX: glyphLeft + hhWidth + colonGap * 0.5,
    colonDotRadius: Math.max(4.5, fontSize * 0.036),
    colonDotOffset: fontSize * 0.142,
  };
}

function makeLayer(w: number, h: number, dpr: number) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = context(canvas);
  ctx.scale(dpr, dpr);
  return { canvas, ctx, width: canvas.width / dpr, height: canvas.height / dpr };
}

function diagonalMask(
  ctx: CanvasContext,
  layout: ClockLayout,
  left: number,
  top: number,
  stops: Stops,
) {
  const gradient = ctx.createLinearGradient(
    layout.glyphLeft - left,
    layout.glyphBottom - top,
    layout.glyphRight - left,
    layout.glyphTop - top,
  );
  stops.forEach(([stop, alpha]) => gradient.addColorStop(stop, `rgba(0,0,0,${alpha})`));
  return gradient;
}

function buildDigitTile(digit: ClockDigit, layout: ClockLayout, dpr: number) {
  const padding = 128;
  const offsetX = -(digit.metrics.actualBoundingBoxLeft || 0) - padding;
  const offsetY = layout.glyphTop - layout.drawY - padding;
  const width = inkWidth(digit.metrics) + padding * 2;
  const height = layout.glyphBottom - layout.glyphTop + padding * 2;
  const left = digit.x + offsetX;
  const top = layout.drawY + offsetY;
  const ink = makeLayer(width, height, dpr);
  const glow = makeLayer(width, height, dpr);
  const scratch = makeLayer(width, height, dpr);
  const drawGlyph = (ctx: CanvasContext, color: string) => {
    useClockFont(ctx, layout.fontSpec);
    ctx.fillStyle = color;
    ctx.fillText(digit.char, -offsetX, -offsetY);
  };
  const resetScratch = () => {
    const ctx = scratch.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    return ctx;
  };
  const mask = (ctx: CanvasContext, stops: Stops) => {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = diagonalMask(ctx, layout, left, top, stops);
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.globalCompositeOperation = 'source-over';
  };
  BLUR_RADII.forEach((radius, index) => {
    const ctx = resetScratch();
    paintCompatBlur(ctx, radius, (target) => drawGlyph(target, '#ffffff'), '#ffffff');
    mask(ctx, PASS_STOPS[index]);
    ink.ctx.drawImage(scratch.canvas, 0, 0, scratch.width, scratch.height);
  });
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    paintCompatBlur(glow.ctx, blur, (target) => drawGlyph(target, color), opaqueCompatColor(color));
  }
  glow.ctx.filter = 'none';
  mask(glow.ctx, [
    [0, 0.38],
    [0.14, 1],
    [0.84, 1],
    [1, 0.32],
  ]);

  const rightMask = [
    [0, 0],
    [0.76, 0],
    [0.9, 0.55],
    [1, 1],
  ];
  const leftMask = [
    [0, 0.85],
    [0.11, 0.35],
    [0.22, 0],
    [1, 0],
  ];
  for (const [stops, color, blur, alpha, dx, dy] of [
    [rightMask, '#ffffff', 16, 0.25, 8, -7],
    [rightMask, '#80c8ff', 30, 0.2, 18, -15],
    [leftMask, '#ffffff', 13, 0.16, -6, 5],
  ] as const) {
    const ctx = resetScratch();
    drawGlyph(ctx, color);
    mask(ctx, stops);
    ink.ctx.save();
    ink.ctx.globalAlpha = alpha;
    drawCompatImage(
      ink.ctx,
      scratch.canvas,
      dx,
      dy,
      scratch.width,
      scratch.height,
      blur,
      opaqueCompatColor(color),
    );
    ink.ctx.restore();
  }

  compositor.forget(scratch.canvas);

  scratch.canvas.width = scratch.canvas.height = 0;
  return { ink, glow, offsetX, offsetY };
}

function buildColonTile(layout: ClockLayout, dpr: number) {
  const padding = 64;
  const radius = layout.colonDotRadius;
  const offset = layout.colonDotOffset;
  const halfW = radius * 1.45 + padding;
  const halfH = offset + radius * 1.45 + padding;
  const tile = makeLayer(halfW * 2, halfH * 2, dpr);
  for (const [blur, color, scale] of [
    [18, 'rgba(115,195,255,.34)', 1.45],
    [5.5, 'rgba(255,255,255,.38)', 1.08],
    [0, '#ffffff', 1],
  ] as const) {
    paintCompatBlur(
      tile.ctx,
      blur,
      (ctx) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(halfW, halfH - offset, radius * scale, 0, Math.PI * 2);
        ctx.arc(halfW, halfH + offset, radius * scale, 0, Math.PI * 2);
        ctx.fill();
      },
      opaqueCompatColor(color),
    );
  }
  return { ...tile, offsetX: -halfW, offsetY: -halfH };
}

function buildClockScene(hoursStr: string, minutesStr: string, w: number, h: number, dpr: number) {
  const layout = buildClockLayout(hoursStr, minutesStr, w, h);
  return {
    hoursStr,
    minutesStr,
    layout,
    digits: layout.digits.map((digit) => buildDigitTile(digit, layout, dpr)),
    colon: buildColonTile(layout, dpr),
  };
}

const buildSecondsMorphPair = (() => {
  const ARC_STEPS = 32;
  const MATCH_SAMPLES = 96;
  const EPSILON = 1e-10;
  const cache = new Map<string, MorphPair>();
  const glyphs: Record<string, VectorDigit> = {
    ...SECONDS_DIGITS,
    '4': canonicalFour(SECONDS_DIGITS['4']),
  };

  function lines(points: number[][]) {
    return points.map((a, index) => {
      const b = points[(index + 1) % points.length];
      return [
        a[0],
        a[1],
        a[0] + (b[0] - a[0]) / 3,
        a[1] + (b[1] - a[1]) / 3,
        a[0] + (2 * (b[0] - a[0])) / 3,
        a[1] + (2 * (b[1] - a[1])) / 3,
        b[0],
        b[1],
      ];
    });
  }

  function canonicalFour(glyph: VectorDigit) {
    const p = glyph.contours[0].map((segment) => segment.slice(0, 2));
    const rightTop = [p[3][0], p[8][1]],
      rightBottom = [p[3][0], p[0][1]];
    const leftTop = [p[5][0], p[8][1]],
      leftBottom = [p[5][0], p[0][1]];
    return {
      ...glyph,
      contours: [
        lines([p[0], p[1], p[2], p[3], rightTop, p[9], p[10], rightBottom, p[4], p[5], leftBottom]),
        lines([leftTop, p[6], p[7], p[8]]),
      ],
    };
  }

  function pointAt(segment: Curve, t: number) {
    const u = 1 - t;
    return [
      u * u * u * segment[0] +
        3 * u * u * t * segment[2] +
        3 * u * t * t * segment[4] +
        t * t * t * segment[6],
      u * u * u * segment[1] +
        3 * u * u * t * segment[3] +
        3 * u * t * t * segment[5] +
        t * t * t * segment[7],
    ];
  }

  function split(segment: Curve, t: number) {
    const mix = (a: number, b: number) => a + (b - a) * t;
    const ax = mix(segment[0], segment[2]),
      ay = mix(segment[1], segment[3]);
    const bx = mix(segment[2], segment[4]),
      by = mix(segment[3], segment[5]);
    const cx = mix(segment[4], segment[6]),
      cy = mix(segment[5], segment[7]);
    const dx = mix(ax, bx),
      dy = mix(ay, by);
    const ex = mix(bx, cx),
      ey = mix(by, cy);
    const fx = mix(dx, ex),
      fy = mix(dy, ey);
    return [
      [segment[0], segment[1], ax, ay, dx, dy, fx, fy],
      [fx, fy, ex, ey, cx, cy, segment[6], segment[7]],
    ];
  }

  function slice(segment: Curve, from: number, to: number) {
    if (from <= EPSILON && to >= 1 - EPSILON) return segment.slice();
    const left = to >= 1 - EPSILON ? segment : split(segment, to)[0];
    return from <= EPSILON ? left.slice() : split(left, from / to)[1];
  }

  function model(contour: Contour) {
    let total = 0;
    const segments = contour.map((segment) => {
      const table = [0];
      let previous = pointAt(segment, 0),
        length = 0;
      for (let i = 1; i <= ARC_STEPS; i++) {
        const next = pointAt(segment, i / ARC_STEPS);
        length += Math.hypot(next[0] - previous[0], next[1] - previous[1]);
        table.push(length);
        previous = next;
      }
      const result = { segment, table, length, start: total };
      total += length;
      return result;
    });
    return { segments, total };
  }

  function parameterAt(entry: ReturnType<typeof model>['segments'][number], distance: number) {
    if (distance <= EPSILON) return 0;
    if (distance >= entry.length - EPSILON) return 1;
    let low = 0,
      high = ARC_STEPS;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (entry.table[middle] < distance) low = middle;
      else high = middle;
    }
    const stepLength = entry.table[high] - entry.table[low];
    return (
      (low + (stepLength > EPSILON ? (distance - entry.table[low]) / stepLength : 0)) / ARC_STEPS
    );
  }

  function locate(shape: ReturnType<typeof model>, fraction: number) {
    const distance = Math.max(0, Math.min(1, fraction)) * shape.total;
    const entries = shape.segments;
    let index = 0;
    while (index < entries.length - 1 && distance > entries[index].start + entries[index].length)
      index++;
    return { index, t: parameterAt(entries[index], distance - entries[index].start) };
  }

  function pointOn(shape: ReturnType<typeof model>, fraction: number) {
    const wrapped = ((fraction % 1) + 1) % 1;
    const hit = locate(shape, wrapped);
    return pointAt(shape.segments[hit.index].segment, hit.t);
  }

  function sampled(shape: ReturnType<typeof model>, count = MATCH_SAMPLES) {
    return Array.from({ length: count }, (_, index) => pointOn(shape, index / count));
  }

  function bounds(points: number[][]) {
    const xs = points.map((point) => point[0]),
      ys = points.map((point) => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function normalizedSamples(shape: ReturnType<typeof model>) {
    const points = sampled(shape);
    const box = bounds(points);
    const width = Math.max(EPSILON, box[2] - box[0]);
    const height = Math.max(EPSILON, box[3] - box[1]);
    return points.map((point) => [(point[0] - box[0]) / width, (point[1] - box[1]) / height]);
  }

  function rotate(contour: Contour, fraction: number) {
    if (fraction <= EPSILON) return contour;
    const shape = model(contour);
    const hit = locate(shape, fraction);
    const parts = split(contour[hit.index], hit.t);
    const rotated = [];
    if (hit.t < 1 - EPSILON) rotated.push(parts[1]);
    rotated.push(...contour.slice(hit.index + 1), ...contour.slice(0, hit.index));
    if (hit.t > EPSILON) rotated.push(parts[0]);
    return rotated;
  }

  function align(fromContour: Contour, toContour: Contour, phaseOverride?: number) {
    if (phaseOverride !== undefined) return rotate(toContour, phaseOverride);
    const from = normalizedSamples(model(fromContour));
    const to = normalizedSamples(model(toContour));
    let best = 0,
      bestCost = Infinity;
    for (let offset = 0; offset < MATCH_SAMPLES; offset++) {
      let cost = 0;
      for (let index = 0; index < MATCH_SAMPLES; index++) {
        const other = to[(index + offset) % MATCH_SAMPLES];
        const dx = from[index][0] - other[0],
          dy = from[index][1] - other[1];
        cost += dx * dx + dy * dy;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = offset;
      }
    }
    return rotate(toContour, best / MATCH_SAMPLES);
  }

  function compatibleContours(fromContour: Contour, toContour: Contour, phaseOverride?: number) {
    const from = model(fromContour),
      to = model(align(fromContour, toContour, phaseOverride));

    const values = [0, 1];
    for (const shape of [from, to] as const) {
      for (const entry of shape.segments) values.push(entry.start / shape.total);
    }
    for (let index = 1; index < 64; index++) values.push(index / 64);
    values.sort((a, b) => a - b);
    const stops = values.filter(
      (value, index) => index === 0 || value - values[index - 1] > EPSILON,
    );
    const resample = (shape: ReturnType<typeof model>) =>
      stops.slice(0, -1).map((start, index) => {
        const end = stops[index + 1];
        const hit = locate(shape, (start + end) / 2);
        const entry = shape.segments[hit.index];
        const fromT = parameterAt(entry, start * shape.total - entry.start);
        const toT = parameterAt(entry, end * shape.total - entry.start);
        return slice(entry.segment, fromT, toT);
      });
    return [resample(from), resample(to)];
  }

  function center(contour: Contour) {
    const points = sampled(model(contour), 64);
    return [
      points.reduce((sum, point) => sum + point[0], 0) / points.length,
      points.reduce((sum, point) => sum + point[1], 0) / points.length,
    ];
  }

  function contains(polygon: number[][], point: number[]) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i],
        b = polygon[j];
      if (
        a[1] > point[1] !== b[1] > point[1] &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
      )
        inside = !inside;
    }
    return inside;
  }

  function distanceToEdge(point: number[], a: number[], b: number[]) {
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const denominator = dx * dx + dy * dy;
    const t =
      denominator > 0
        ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator))
        : 0;
    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
  }

  function collapsePoint(glyph: VectorDigit, reference: number[]) {
    const polygons = glyph.contours.map((contour) => sampled(model(contour), 128));
    const box = glyph.bounds;
    let winner = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
      bestCost = Infinity;

    for (let y = 0; y < 36; y++) {
      for (let x = 0; x < 28; x++) {
        const point = [
          box[0] + ((box[2] - box[0]) * (x + 0.5)) / 28,
          box[1] + ((box[3] - box[1]) * (y + 0.5)) / 36,
        ];
        if (
          !contains(polygons[0], point) ||
          polygons.slice(1).some((polygon) => contains(polygon, point))
        )
          continue;
        let clearance = Infinity;
        for (const polygon of polygons) {
          for (let index = 0; index < polygon.length; index++) {
            clearance = Math.min(
              clearance,
              distanceToEdge(point, polygon[index], polygon[(index + 1) % polygon.length]),
            );
          }
        }
        const dx = point[0] - reference[0],
          dy = point[1] - reference[1];
        const edgePenalty = Math.max(0, 0.025 - clearance);
        const cost = dx * dx + dy * dy + 4 * edgePenalty * edgePenalty;
        if (cost < bestCost) {
          bestCost = cost;
          winner = point;
        }
      }
    }
    return winner;
  }

  function collapsed(contour: Contour, point: number[]) {
    return contour.map(() => [
      point[0],
      point[1],
      point[0],
      point[1],
      point[0],
      point[1],
      point[0],
      point[1],
    ]);
  }

  return function buildSecondsMorphPair(fromChar: string, toChar: string) {
    const key = `${fromChar}:${toChar}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const fromGlyph = glyphs[fromChar],
      toGlyph = glyphs[toChar];
    if (!fromGlyph || !toGlyph) throw new Error(`Unknown second digit: ${key}`);
    if (String(fromChar) === String(toChar)) {
      const contours = fromGlyph.contours.map((contour) =>
        contour.map((segment) => segment.slice()),
      );
      const pair = {
        from: contours,
        to: contours,
        fromAdvance: fromGlyph.advance,
        toAdvance: toGlyph.advance,
      };
      cache.set(key, pair);
      return pair;
    }

    const phaseOverride = key === '4:5' ? 31 / 96 : undefined;
    const outer = compatibleContours(fromGlyph.contours[0], toGlyph.contours[0], phaseOverride);
    const from = [outer[0]],
      to = [outer[1]];
    const fromHoles = fromGlyph.contours
      .slice(1)
      .map((contour) => ({ contour, center: center(contour) }));
    const toHoles = toGlyph.contours
      .slice(1)
      .map((contour) => ({ contour, center: center(contour) }));

    while (fromHoles.length && toHoles.length) {
      let bestFrom = 0,
        bestTo = 0,
        bestDistance = Infinity;
      for (let i = 0; i < fromHoles.length; i++) {
        for (let j = 0; j < toHoles.length; j++) {
          const a = fromHoles[i].center,
            b = toHoles[j].center;
          const distance = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            bestFrom = i;
            bestTo = j;
          }
        }
      }
      const source = fromHoles.splice(bestFrom, 1)[0];
      const target = toHoles.splice(bestTo, 1)[0];
      const holes = compatibleContours(source.contour, target.contour);
      from.push(holes[0]);
      to.push(holes[1]);
    }
    for (const hole of fromHoles) {
      from.push(hole.contour);
      to.push(collapsed(hole.contour, collapsePoint(toGlyph, hole.center)));
    }
    for (const hole of toHoles) {
      from.push(collapsed(hole.contour, collapsePoint(fromGlyph, hole.center)));
      to.push(hole.contour);
    }
    const pair = { from, to, fromAdvance: fromGlyph.advance, toAdvance: toGlyph.advance };
    cache.set(key, pair);
    return pair;
  };
})();

function secondsPairPlacement(text: string, layout: ClockLayout) {
  useClockFont(clockCtx, layout.secondsFontSpec);
  return {
    left: SECONDS_DIGITS[text[0]].bounds[0],

    second:
      (clockCtx.measureText(text).width - clockCtx.measureText(text[1]).width) /
      layout.secondsFontSize,
  };
}

function buildSecondsTile(layout: ClockLayout, dpr: number) {
  const padding = 32;
  const size = layout.secondsFontSize;
  const width = Math.max(layout.secondsWidth, size * 1.5) + padding * 2;
  const height = size * 0.8 + padding * 2;
  const ink = makeLayer(width, height, dpr);
  const tile = makeLayer(width, height, dpr);
  return {
    ...tile,
    ink,
    fontSpec: layout.secondsFontSpec,
    fontSize: size,
    dpr,
    offsetX: -padding,
    offsetY: -size * 0.76 - padding,
    padding,
    renderedText: null,
  };
}

function traceSecondsContour(
  ctx: CanvasContext,
  from: Contour,
  to: Contour,
  t: number,
  originX: number,
  originY: number,
  size: number,
) {
  const x = (a: number, b: number) => originX + lerp(a, b, t) * size;
  const y = (a: number, b: number) => originY + lerp(a, b, t) * size;
  ctx.beginPath();
  ctx.moveTo(x(from[0][0], to[0][0]), y(from[0][1], to[0][1]));
  for (let i = 0; i < from.length; i++) {
    const a = from[i],
      b = to[i];
    ctx.bezierCurveTo(
      x(a[2], b[2]),
      y(a[3], b[3]),
      x(a[4], b[4]),
      y(a[5], b[5]),
      x(a[6], b[6]),
      y(a[7], b[7]),
    );
  }
  ctx.closePath();
  ctx.fill();
}

function paintSecondsTile(
  tile: SecondsTile,
  text: string,
  layout: ClockLayout,
  morph: SecondsMorph | null,
  progress: number,
) {
  const t = smoothProgress(progress);
  const fromPlacement = morph ? morph.fromPlacement : secondsPairPlacement(text, layout);
  const toPlacement = morph ? morph.toPlacement : fromPlacement;
  const left = lerp(fromPlacement.left, toPlacement.left, t);
  const second = lerp(fromPlacement.second, toPlacement.second, t);
  const ctx = tile.ink.ctx;
  ctx.clearRect(0, 0, tile.ink.width, tile.ink.height);
  for (let index = 0; index < 2; index++) {
    const pair = morph && morph.pairs[index];
    const from = pair ? pair.from : SECONDS_DIGITS[text[index]].contours;
    const to = pair ? pair.to : from;
    const originX = tile.padding + ((index ? second : 0) - left) * tile.fontSize;
    const originY = -tile.offsetY;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.globalCompositeOperation = 'source-over';
    traceSecondsContour(ctx, from[0], to[0], t, originX, originY, tile.fontSize);

    ctx.globalCompositeOperation = 'destination-out';
    for (let contour = 1; contour < from.length; contour++) {
      traceSecondsContour(ctx, from[contour], to[contour], t, originX, originY, tile.fontSize);
    }
    ctx.restore();
  }
  tile.ctx.clearRect(0, 0, tile.width, tile.height);
  tile.ctx.save();
  drawCompatImage(tile.ctx, tile.ink.canvas, 0, 0, tile.ink.width, tile.ink.height, 7, '#ffffff');
  tile.ctx.globalCompositeOperation = 'source-in';
  tile.ctx.fillStyle = 'rgba(140,205,255,.22)';
  tile.ctx.fillRect(0, 0, tile.width, tile.height);
  tile.ctx.globalCompositeOperation = 'source-over';
  tile.ctx.drawImage(tile.ink.canvas, 0, 0, tile.ink.width, tile.ink.height);
  tile.ctx.restore();
  tile.renderedText = morph ? null : text;
}

function drawSeconds(text: string, layout: ClockLayout, dpr: number, now: number, settle = false) {
  const resized =
    !currentSecondsTile ||
    currentSecondsTile.fontSpec !== layout.secondsFontSpec ||
    currentSecondsTile.dpr !== dpr;
  const continuous =
    secondsLastFrame !== null && now >= secondsLastFrame && now - secondsLastFrame < 1500;
  secondsLastFrame = now;
  if (resized) {
    if (currentSecondsTile) {
      compositor.forget(currentSecondsTile.canvas);
      currentSecondsTile.canvas.width = currentSecondsTile.canvas.height = 0;
      compositor.forget(currentSecondsTile.ink.canvas);
      currentSecondsTile.ink.canvas.width = currentSecondsTile.ink.canvas.height = 0;
    }
    currentSecondsTile = buildSecondsTile(layout, dpr);
  }
  if (text !== currentSecondStr) {
    const consecutive =
      currentSecondStr !== '' && (Number(currentSecondStr) + 1) % 60 === Number(text);
    secondsMorph =
      !resized && !settle && !reducedMotion.matches && continuous && consecutive
        ? {
            start: now,
            fromText: currentSecondStr,
            toText: text,
            pairs: [...text].map((digit, index) =>
              buildSecondsMorphPair(currentSecondStr[index], digit),
            ),
            fromPlacement: secondsPairPlacement(currentSecondStr, layout),
            toPlacement: secondsPairPlacement(text, layout),
          }
        : null;
    currentSecondStr = text;
  }
  if (
    resized ||
    settle ||
    reducedMotion.matches ||
    !continuous ||
    (secondsMorph && now - secondsMorph.start >= SECONDS_MORPH_MS)
  )
    secondsMorph = null;
  const tile = currentSecondsTile;
  if (!tile) return;
  if (secondsMorph || tile.renderedText !== text) {
    paintSecondsTile(
      tile,
      text,
      layout,
      secondsMorph,
      secondsMorph ? (now - secondsMorph.start) / SECONDS_MORPH_MS : 1,
    );
  }
  const x = clockMetrics.glyphRight + layout.secondsGap;

  const y = clockMetrics.glyphBottom - tile.fontSize * 0.02;
  clockCtx.save();
  clockCtx.globalAlpha = 0.76;
  drawCompatImage(
    clockCtx,
    tile.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.width,
    tile.height,
  );
  clockCtx.restore();
}

function releaseClockScene(scene: ClockScene | null) {
  if (!scene) return;
  for (const tile of scene.digits) {
    compositor.forget(tile.ink.canvas);
    tile.ink.canvas.width = tile.ink.canvas.height = 0;
    compositor.forget(tile.glow.canvas);
    tile.glow.canvas.width = tile.glow.canvas.height = 0;
  }
  compositor.forget(scene.colon.canvas);
  scene.colon.canvas.width = scene.colon.canvas.height = 0;
}

function releaseClockTransition(transition: ClockTransition) {
  releaseClockScene(transition.from);
  for (const tile of transition.mixedDigits || []) {
    if (!tile) continue;
    compositor.forget(tile.ink.canvas);
    tile.ink.canvas.width = tile.ink.canvas.height = 0;
    compositor.forget(tile.glow.canvas);
    tile.glow.canvas.width = tile.glow.canvas.height = 0;
  }
}

function blendUnchangedDigit(transition: ClockTransition, index: number, progress: number) {
  const previous = transition.from.digits[index];
  const next = transition.to.digits[index];
  if (progress <= 0) return previous;
  if (progress >= 1) return next;

  transition.mixedDigits ||= [];
  let mixed = transition.mixedDigits[index];
  if (!mixed) {
    const width = Math.max(previous.ink.width, next.ink.width);
    const height = Math.max(previous.ink.height, next.ink.height);
    mixed = {
      ink: makeLayer(width, height, lastDpr),
      glow: makeLayer(width, height, lastDpr),
      offsetX: previous.offsetX,
      offsetY: previous.offsetY,
    };
    transition.mixedDigits[index] = mixed;
  }
  for (const key of ['ink', 'glow'] as const) {
    const layer = mixed[key];
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, layer.width, layer.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(previous[key].canvas, 0, 0, previous[key].width, previous[key].height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = progress;
    ctx.drawImage(
      next[key].canvas,
      next.offsetX - previous.offsetX,
      next.offsetY - previous.offsetY,
      next[key].width,
      next[key].height,
    );
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  return mixed;
}

function updateClockMetrics(layout: ClockLayout, offsetX = 0) {
  const height = layout.glyphBottom - layout.glyphTop;
  const next = {
    topRightEdgeX: layout.glyphRight + offsetX - layout.fontSize * 0.1,
    topRightEdgeY: layout.glyphTop + height * 0.24,
    bottomLeftEdgeX: layout.glyphLeft + offsetX + layout.fontSize * 0.08,
    bottomLeftEdgeY: layout.glyphBottom - height * 0.22,
    glyphLeft: layout.glyphLeft + offsetX,
    glyphRight: layout.glyphRight + offsetX,
    groupLeft: layout.glyphLeft + offsetX,
    groupRight: layout.glyphRight + offsetX + layout.secondsGap + layout.secondsWidth,
    glyphTop: layout.glyphTop,
    glyphBottom: layout.glyphBottom,
    glyphWidth: layout.glyphRight - layout.glyphLeft,
    glyphHeight: height,
    colonCenterX: layout.colonCenterX + offsetX,
    colonCenterY: layout.anchorY,
    colonDotRadius: layout.colonDotRadius,
    colonDotOffset: layout.colonDotOffset,
    ready: true,
  };
  if (clockMetrics.ready) {
    for (const particle of speckles) {
      const edge = particle.isBottomLeft ? 'bottomLeftEdge' : 'topRightEdge';
      particle.x += next[`${edge}X`] - clockMetrics[`${edge}X`];
      particle.y += next[`${edge}Y`] - clockMetrics[`${edge}Y`];
    }
  }
  Object.assign(clockMetrics, next);
}

function drawDigitTile(tile: DigitTile, x: number, y: number, wave: number, alpha = 1, blur = 0) {
  if (alpha <= 0) return;
  clockCtx.save();
  clockCtx.globalAlpha = alpha * (0.9 + 0.1 * wave);
  drawCompatImage(
    clockCtx,
    tile.glow.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.glow.width,
    tile.glow.height,
    blur,
  );
  clockCtx.globalAlpha = alpha;
  drawCompatImage(
    clockCtx,
    tile.ink.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.ink.width,
    tile.ink.height,
    blur,
  );
  clockCtx.restore();
}

function drawColonTile(tile: ColonTile, x: number, y: number, wave: number) {
  clockCtx.save();
  clockCtx.globalAlpha = 0.78 + 0.22 * wave;
  drawCompatImage(
    clockCtx,
    tile.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.width,
    tile.height,
  );
  clockCtx.restore();
}

function drawClockScene(scene: ClockScene, offsetX: number, wave: number) {
  scene.digits.forEach((tile, index) => {
    drawDigitTile(tile, scene.layout.digits[index].x + offsetX, scene.layout.drawY, wave);
  });
  drawColonTile(scene.colon, scene.layout.colonCenterX + offsetX, scene.layout.anchorY, wave);
  updateClockMetrics(scene.layout, offsetX);
}

function drawDigitTransition(transition: ClockTransition, progress: number, wave: number) {
  const { from, to } = transition;
  const t = smoothProgress(progress);
  const oldLayout = from.layout;
  const layout = to.layout;
  const y = lerp(oldLayout.drawY, layout.drawY, t);
  const size = layout.fontSize;
  to.digits.forEach((tile, index) => {
    const oldDigit = oldLayout.digits[index];
    const digit = layout.digits[index];
    const x = lerp(oldDigit.x, digit.x, t);
    if (oldDigit.char === digit.char) {
      drawDigitTile(blendUnchangedDigit(transition, index, t), x, y, wave);
      return;
    }
    const exit = Math.min(1, t / 0.6);
    const entry = Math.max(0, (t - 0.15) / 0.85);
    drawDigitTile(
      from.digits[index],
      x + size * 0.07 * t,
      y - size * 0.07 * t,
      wave,
      1 - exit,
      12 * t,
    );
    drawDigitTile(
      tile,
      x - size * 0.045 * (1 - entry),
      y + size * 0.045 * (1 - entry),
      wave,
      entry,
      8 * (1 - entry),
    );
  });
  const interpolated = { ...layout };
  for (const key of ['glyphLeft', 'glyphRight', 'colonCenterX'] as const) {
    interpolated[key] = lerp(oldLayout[key], layout[key], t);
  }
  for (const key of ['glyphTop', 'glyphBottom', 'anchorY'] as const) {
    interpolated[key] = lerp(oldLayout[key], layout[key], t);
  }
  drawColonTile(to.colon, interpolated.colonCenterX, interpolated.anchorY, wave);
  updateClockMetrics(interpolated);
}

function renderFrame(now: number) {
  const { hours, minutes, seconds } = getFormattedTimeParts();
  const rect = clockCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = getRenderDpr(rect.width, rect.height);
  const resized = rect.width !== lastViewportW || rect.height !== lastViewportH || dpr !== lastDpr;
  const timeChanged = hours !== currentHourStr || minutes !== currentMinuteStr;
  const minuteStep =
    (Number(hours) * 60 +
      Number(minutes) -
      Number(currentHourStr) * 60 -
      Number(currentMinuteStr) +
      1440) %
    1440;
  const clockJump =
    !!currentClockScene &&
    timeChanged &&
    !(minuteStep === 1 && currentSecondStr === '59' && seconds === '00');
  if (resized || timeChanged || !currentClockScene) {
    const next = buildClockScene(hours, minutes, rect.width, rect.height, dpr);
    if (currentClockScene && !resized && !reducedMotion.matches && !clockTransition) {
      clockTransition = {
        start: now,
        from: currentClockScene,
        to: next,
      };
    } else {
      if (clockTransition) releaseClockTransition(clockTransition);
      releaseClockScene(currentClockScene);
      clockTransition = null;
    }
    currentClockScene = next;
    currentHourStr = hours;
    currentMinuteStr = minutes;
    lastViewportW = rect.width;
    lastViewportH = rect.height;
    lastDpr = dpr;
    if (resized) {
      clockCanvas.width = Math.round(rect.width * dpr);
      clockCanvas.height = Math.round(rect.height * dpr);
      resizeSpeckleCanvas();
    }
  }
  if (clockTransition && reducedMotion.matches) {
    releaseClockTransition(clockTransition);
    clockTransition = null;
  }
  clockCtx.setTransform(1, 0, 0, 1, 0, 0);
  clockCtx.clearRect(0, 0, clockCanvas.width, clockCanvas.height);
  clockCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  compositor.begin(clockCtx);
  const wave = 0.5 + 0.5 * Math.cos((now * Math.PI) / 1000);
  if (clockTransition) {
    const elapsed = now - clockTransition.start;
    if (elapsed < DIGIT_TRANSITION_MS) {
      drawDigitTransition(clockTransition, elapsed / DIGIT_TRANSITION_MS, wave);
    } else {
      drawClockScene(currentClockScene, 0, wave);
      releaseClockTransition(clockTransition);
      clockTransition = null;
    }
  } else {
    drawClockScene(currentClockScene, 0, wave);
  }
  if (timeChanged || resized || seconds !== currentSecondStr)
    clockCanvas.setAttribute('aria-label', `${hours}:${minutes}:${seconds}`);
  drawSeconds(seconds, currentClockScene.layout, dpr, now, resized || clockJump);
  if (!speckles.length) initSpeckles();
  compositor.end(clockCtx);
}

const speckleCanvas = element('speckleFieldCanvas', 'canvas');
const sctx = context(speckleCanvas);
let speckles: Speckle[] = [];
let sw = 0;
let sh = 0;

function resizeSpeckleCanvas() {
  const rect = speckleCanvas.getBoundingClientRect();
  const dpr = getRenderDpr(rect.width, rect.height);
  sw = rect.width;
  sh = rect.height;
  speckleCanvas.width = Math.round(sw * dpr);
  speckleCanvas.height = Math.round(sh * dpr);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawnSpeckle() {
  const topRightOriginX = clockMetrics.ready ? clockMetrics.topRightEdgeX : sw * 0.74;
  const topRightOriginY = clockMetrics.ready ? clockMetrics.topRightEdgeY : sh * 0.38;
  const bottomLeftOriginX = clockMetrics.ready ? clockMetrics.bottomLeftEdgeX : sw * 0.26;
  const bottomLeftOriginY = clockMetrics.ready ? clockMetrics.bottomLeftEdgeY : sh * 0.62;
  const spanH = clockMetrics.ready ? clockMetrics.glyphHeight : sh * 0.26;

  const isBottomLeft = Math.random() < 0.2;
  const spread = Math.pow(Math.random(), 1.35);

  if (isBottomLeft) {
    return {
      isBottomLeft: true,
      x: bottomLeftOriginX - spread * (sw * 0.08) + (Math.random() - 0.5) * 18,
      y: bottomLeftOriginY + spread * (sh * 0.06) + (Math.random() - 0.35) * (spanH * 0.42),
      r: Math.random() < 0.84 ? Math.random() * 1.1 + 0.35 : Math.random() * 1.6 + 0.9,
      alpha: (1 - spread * 0.78) * (Math.random() * 0.42 + 0.08),
      vx: -(Math.random() * 0.14 + 0.03),
      vy: Math.random() * 0.11 + 0.02,
      phase: Math.random() * Math.PI * 2,
      tint: Math.random() > 0.45 ? '255, 255, 255' : '168, 222, 255',
    };
  }

  return {
    isBottomLeft: false,
    x: topRightOriginX + spread * (sw * 0.16) + (Math.random() - 0.5) * 24,
    y: topRightOriginY - spread * (sh * 0.12) + (Math.random() - 0.65) * (spanH * 0.48),
    r: Math.random() < 0.8 ? Math.random() * 1.25 + 0.35 : Math.random() * 1.9 + 1.0,
    alpha: (1 - spread * 0.72) * (Math.random() * 0.66 + 0.14),
    vx: Math.random() * 0.2 + 0.04,
    vy: -(Math.random() * 0.15 + 0.03),
    phase: Math.random() * Math.PI * 2,
    tint: Math.random() > 0.38 ? '255, 255, 255' : '168, 222, 255',
  };
}

function initSpeckles() {
  const count = 96;
  speckles = [];
  for (let i = 0; i < count; i++) {
    speckles.push(spawnSpeckle());
  }
}

function updateAndDrawSpeckles(now: number) {
  sctx.clearRect(0, 0, sw, sh);

  const topRightOriginX = clockMetrics.ready ? clockMetrics.topRightEdgeX : sw * 0.74;
  const topRightOriginY = clockMetrics.ready ? clockMetrics.topRightEdgeY : sh * 0.38;
  const bottomLeftOriginX = clockMetrics.ready ? clockMetrics.bottomLeftEdgeX : sw * 0.26;
  const bottomLeftOriginY = clockMetrics.ready ? clockMetrics.bottomLeftEdgeY : sh * 0.62;
  const spanH = clockMetrics.ready ? clockMetrics.glyphHeight : sh * 0.26;

  for (let i = 0; i < speckles.length; i++) {
    const p = speckles[i];
    p.x += p.vx;
    p.y += p.vy;

    if (p.isBottomLeft) {
      if (p.x < bottomLeftOriginX - sw * 0.11 || p.y > bottomLeftOriginY + sh * 0.1) {
        p.x = bottomLeftOriginX + (Math.random() - 0.5) * 14;
        p.y = bottomLeftOriginY + (Math.random() - 0.35) * (spanH * 0.38);
      }
    } else {
      if (p.x > topRightOriginX + sw * 0.2 || p.y < topRightOriginY - sh * 0.15) {
        p.x = topRightOriginX + (Math.random() - 0.5) * 16;
        p.y = topRightOriginY + (Math.random() - 0.65) * (spanH * 0.42);
      }
    }

    const twinkle = 0.68 + 0.32 * Math.sin(now * 0.002 + p.phase);
    const finalAlpha = Math.max(0, Math.min(1, p.alpha * twinkle));

    sctx.beginPath();
    sctx.fillStyle = `rgba(${p.tint}, ${finalAlpha.toFixed(3)})`;
    sctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    sctx.fill();
  }
}

const SCENE_NAMES: SceneName[] = ['clock', 'date', 'weather', 'air', 'moon'];
const SCENE_DURATION_MS = 10000;
const SCENE_FADE_MS = 450;
const INFO_TRANSITION_MS = 1000;

const INFO_TILE_PIXEL_BUDGET = 4000000;
let sceneStartedAt: number | null = null;
let sceneHiddenAt: number | null = null;
let activeSceneName: SceneName = 'clock';
const weatherCanvas = element('weatherCanvas', 'canvas');
const weatherCtx = context(weatherCanvas);
const weatherRetry = element('weatherRetry', 'button');
const weatherAttribution = element('weatherAttribution', 'a');
const mainStage = element('mainStage', 'main');
let infoRenderKey = '';
let infoControlsKey = '';
let currentInfoLayout: InfoLayout | null = null;
let currentInfoScene: InfoScene | null = null;
let infoTransition: InfoTransition | null = null;
let infoWasHidden = false;
let moonPhaseCache: { minute: number; data: MoonPhase } | null = null;

function getRenderDpr(w: number, h: number) {
  return Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12000000 / Math.max(1, w * h)));
}

function getSceneState(now: number) {
  if (sceneStartedAt === null) sceneStartedAt = now;
  const elapsed = Math.max(0, (sceneHiddenAt === null ? now : sceneHiddenAt) - sceneStartedAt);
  const index = Math.floor(elapsed / SCENE_DURATION_MS);
  const phase = elapsed % SCENE_DURATION_MS;
  const names = SCENE_NAMES;
  const name = names[index % names.length];
  const opacity = reducedMotion.matches
    ? 1
    : Math.min(
        index === 0 ? 1 : smoothProgress(phase / SCENE_FADE_MS),
        smoothProgress((SCENE_DURATION_MS - phase) / SCENE_FADE_MS),
      );
  return {
    name,
    opacity,
    elapsed,
    phase,
    clockOpacity: name === 'clock' ? opacity : 0,
    weatherOpacity: name === 'clock' ? 0 : opacity,
  };
}

function getInfoContent(
  name: SceneName,
  date = new Date(),
  overrideState?: LocalDataState,
): InfoContent {
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  if (name === 'date')
    return {
      kind: 'date',
      text: `${date.getDate()} ${months[date.getMonth()]}`,
      label: '',
      ready: true,
    };
  if (name === 'moon') {
    const minute = Math.floor(date.getTime() / 60000);
    if (!moonPhaseCache || moonPhaseCache.minute !== minute)
      moonPhaseCache = { minute, data: getMoonPhase(date) };
    return {
      kind: 'moon',
      text: '',
      label: moonPhaseCache.data.label,
      moon: moonPhaseCache.data,
      southernHemisphere: !!weatherCoordinates && weatherCoordinates.latitude < 0,
      ready: true,
    };
  }
  const state = overrideState || (name === 'air' ? airState : weatherState);
  if (state.status !== 'ready') {
    const busy =
      state.status === 'idle' || state.status === 'locating' || state.status === 'loading';
    const text =
      state.status === 'denied'
        ? 'Enable location'
        : state.status === 'unavailable'
          ? 'Location unavailable'
          : state.status === 'error'
            ? 'Connection unavailable'
            : state.status === 'loading'
              ? 'Loading'
              : 'Locating';
    return {
      kind: 'status',
      scene: name,
      text,
      label: state.message || 'Allow location to see local conditions.',
      ready: false,
      retry: !busy,
      stale: false,
    };
  }
  if (name === 'air')
    return {
      kind: 'number',
      text: String(Math.round(state.aqi ?? 0)),
      unit: 'AQI',
      label: '',
      ready: true,
      stale: state.stale,
      updatedAt: state.updatedAt,
      source: 'air',
    };
  return {
    kind: 'number',
    text: String(Math.round(state.temperature ?? 0)),
    unit: '°',
    label: state.description || getWeatherDescription(state.weatherCode, state.isDay),
    ready: true,
    stale: state.stale,
    updatedAt: state.updatedAt,
    source: 'weather',
  };
}

function useInfoFont(ctx: CanvasContext, size: number, weight = 700) {
  ctx.font = `${weight} ${size}px "Google Sans", "Malgun Gothic", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if ('fontKerning' in ctx) ctx.fontKerning = 'normal';
}

function fitInfoText(text: string, size: number, width: number, weight = 700) {
  useInfoFont(weatherCtx, size, weight);
  const measured = inkWidth(weatherCtx.measureText(text));
  return Math.max(1, size * Math.min(1, width / Math.max(1, measured)));
}

function wrapInfoText(text: string, maxWidth: number, size: number, weight = 500) {
  useInfoFont(weatherCtx, size, weight);
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && weatherCtx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function buildInfoLayout(
  name: SceneName,
  w: number,
  h: number,
  date = new Date(),
  overrideState?: LocalDataState,
): InfoLayout {
  const content = getInfoContent(name, date, overrideState);
  const maxWidth = w * 0.8;
  const compact = Math.min(w, h);
  const defaults = {
    primaryUnit: '',
    unitSize: 0,
    unitX: 0,
    unitBaseline: 0,
    labelSize: 0,
    lines: [],
    labelY: 0,
    actionY: 0,
    tailSize: 0,
    tailX: 0,
    tailBaseline: 0,
    radius: 0,
    moonX: 0,
    moonY: 0,
  };
  if (content.kind === 'status') {
    const fontSize = fitInfoText(
      content.text,
      Math.max(1, Math.min(w * 0.075, h * 0.11, 48)),
      maxWidth,
    );
    const labelSize = Math.max(1, Math.min(compact * 0.05, 16));
    const lines = wrapInfoText(content.label, maxWidth, labelSize);
    const gap = Math.max(2, Math.min(16, compact * 0.045));
    const actionHeight = content.retry ? Math.min(40, h * 0.19) + gap : 0;
    const totalHeight = fontSize + gap + lines.length * labelSize * 1.4 + actionHeight;
    const top = Math.max(h * 0.04, (h - totalHeight) / 2);
    useInfoFont(weatherCtx, fontSize);
    const metric = weatherCtx.measureText(content.text);
    const mainX = (w - inkWidth(metric)) / 2 + (metric.actualBoundingBoxLeft || 0);
    const baseline = top + fontSize;
    return {
      ...defaults,
      ...content,
      w,
      h,
      fontSize,
      mainX,
      baseline,
      primaryLines: [{ text: content.text, x: mainX, baseline }],
      primaryLeft: (w - inkWidth(metric)) / 2,
      primaryRight: (w + inkWidth(metric)) / 2,
      primaryTop: baseline - (metric.actualBoundingBoxAscent || fontSize * 0.73),
      primaryBottom: baseline + (metric.actualBoundingBoxDescent || 0),
      labelSize,
      lines,
      labelY: top + fontSize + gap + labelSize,
      actionY: top + totalHeight - actionHeight + gap,
      tailText: '',
      tailLines: [],
      bounds: [w * 0.1, top, w * 0.9, top + totalHeight],
    };
  }
  if (content.kind === 'moon') {
    let fontSize = Math.max(1, Math.min(w * 0.55, h * 0.57, 1520));
    let tailSize = 0,
      tailWidth = 0,
      tailDescent = 0,
      gap = 0,
      width = 0;
    let tailLines: string[] = [];
    function measureMoon() {
      tailSize = fontSize * 0.12;
      tailLines = wrapInfoText(content.label, fontSize * 0.55, tailSize);
      if (tailLines.length > 2) {
        tailSize *= 2 / tailLines.length;
        tailLines = wrapInfoText(content.label, fontSize * 0.55, tailSize);
      }
      useInfoFont(weatherCtx, tailSize, 500);
      tailWidth = Math.max(0, ...tailLines.map((line) => inkWidth(weatherCtx.measureText(line))));
      tailDescent = weatherCtx.measureText('Ag').actualBoundingBoxDescent || tailSize * 0.2;
      gap = fontSize * 0.11;
      width = fontSize + gap + tailWidth;
    }
    measureMoon();
    fontSize *= Math.min(1, maxWidth / Math.max(1, width));
    measureMoon();
    const top = (h - fontSize) / 2;
    const opticalBias = (gap + tailWidth) * (1 - SECONDS_CENTER_WEIGHT) * 0.5;
    const left = (w - width) / 2 + opticalBias;
    const bottom = top + fontSize;
    return {
      ...defaults,
      ...content,
      w,
      h,
      fontSize,
      primaryLines: [],
      primaryUnit: '',
      mainX: left,
      baseline: bottom,
      radius: fontSize / 2,
      moonX: left + fontSize / 2,
      moonY: top + fontSize / 2,
      primaryLeft: left,
      primaryRight: left + fontSize,
      primaryTop: top,
      primaryBottom: bottom,
      tailText: content.label,
      tailLines,
      tailSize,
      tailX: left + fontSize + gap,
      tailBaseline: bottom - tailDescent,
      bounds: [left, top, left + width, bottom],
    };
  }
  const isDate = content.kind === 'date';
  const primaryUnit = content.unit === '°' ? '°' : '';
  let tailText = isDate
    ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][date.getDay()]
    : name === 'weather'
      ? content.label
      : content.unit
        ? content.unit.toUpperCase()
        : '';
  tailText = tailText.replace(/(?:Heavy )?Thunderstorm with hail/i, 'Thunder & hail');
  let fontSize = Math.max(1, Math.min(w * (isDate ? 0.255 : 0.58), h * 0.48, 1400));
  let metrics = weatherCtx.measureText(''),
    unitMetrics = metrics,
    unitSize = 0,
    primaryWidth = 0,
    mainHeight = 0,
    ascent = 0,
    descent = 0;
  let tailSize = 0,
    tailWidth = 0,
    tailDescent = 0,
    tailHeight = 0,
    gap = 0,
    tailOffset = 0,
    width = 0;
  let tailLines: string[] = [];
  function measure() {
    useInfoFont(weatherCtx, fontSize);
    metrics = weatherCtx.measureText(content.text);
    ascent = metrics.actualBoundingBoxAscent || fontSize * 0.73;
    descent = metrics.actualBoundingBoxDescent || 0;
    mainHeight = ascent + descent;
    unitSize = fontSize * 0.4;
    useInfoFont(weatherCtx, unitSize, 500);
    unitMetrics = weatherCtx.measureText(primaryUnit);
    primaryWidth = inkWidth(metrics) + (primaryUnit ? fontSize * 0.025 + inkWidth(unitMetrics) : 0);
    tailSize = fontSize * (tailText.length > 4 ? 0.18 : 0.24);
    tailLines = tailText ? wrapInfoText(tailText, fontSize * 1.05, tailSize) : [];
    if (tailLines.length > 2) {
      tailSize *= 2 / tailLines.length;
      tailLines = wrapInfoText(tailText, fontSize * 1.05, tailSize);
    }
    useInfoFont(weatherCtx, tailSize, 500);
    tailWidth = Math.max(0, ...tailLines.map((line) => inkWidth(weatherCtx.measureText(line))));
    tailDescent = weatherCtx.measureText('Ag').actualBoundingBoxDescent || tailSize * 0.2;
    tailHeight = tailLines.length * tailSize * 1.2;
    gap = tailText ? fontSize * SECONDS_GAP_SCALE : 0;
    tailOffset = primaryWidth + gap;
    if (primaryUnit && tailText) {
      const unitBottom =
        -ascent +
        (unitMetrics.actualBoundingBoxAscent || unitSize * 0.7) +
        (unitMetrics.actualBoundingBoxDescent || 0);
      const tailAscent = Math.max(
        ...tailLines.map(
          (line) => weatherCtx.measureText(line).actualBoundingBoxAscent || tailSize * 0.73,
        ),
      );
      const tailTop = descent - tailDescent - (tailLines.length - 1) * tailSize * 1.2 - tailAscent;
      if (unitBottom + fontSize * 0.06 <= tailTop) tailOffset = inkWidth(metrics) + fontSize * 0.12;
    }
    width = Math.max(primaryWidth, tailOffset + tailWidth);
  }
  measure();
  fontSize *= Math.min(1, maxWidth / Math.max(1, width));
  measure();
  const totalHeight = Math.max(mainHeight, tailHeight);
  const top = (h - totalHeight) / 2;
  const opticalBias = (width - primaryWidth) * (1 - SECONDS_CENTER_WEIGHT) * 0.5;
  const left = (w - width) / 2 + opticalBias;
  const bottom = top + totalHeight;
  const baseline = bottom - descent;
  const mainX = left + (metrics.actualBoundingBoxLeft || 0);
  return {
    ...defaults,
    ...content,
    w,
    h,
    fontSize,
    primaryUnit,
    unitSize,
    mainX,
    baseline,
    primaryLines: [{ text: content.text, x: mainX, baseline }],
    unitX: primaryUnit
      ? left + inkWidth(metrics) + fontSize * 0.025 + (unitMetrics.actualBoundingBoxLeft || 0)
      : 0,
    unitBaseline: primaryUnit
      ? baseline - ascent + (unitMetrics.actualBoundingBoxAscent || unitSize * 0.7)
      : baseline,
    tailText,
    tailLines,
    tailSize,
    tailX: left + tailOffset,
    tailBaseline: bottom - tailDescent,
    primaryTop: bottom - mainHeight,
    primaryLeft: left,
    primaryBottom: bottom,
    primaryRight: left + primaryWidth,
    bounds: [left, top, left + width, bottom],
  };
}

function buildWeatherLayout(state: LocalDataState, w: number, h: number) {
  return buildInfoLayout('weather', w, h, new Date(), state);
}

function getInfoGlyphs(layout: InfoLayout) {
  const glyphs: InfoGlyph[] = [];
  const counts = new Map<string, number>();
  function addLine(
    text: string,
    x: number,
    y: number,
    size: number,
    weight: number,
    alpha: number,
    optical: boolean,
    role: string,
    numeric = false,
  ) {
    useInfoFont(weatherCtx, size, weight);
    const chars = Array.from(text);
    let prefix = '';
    chars.forEach((char, index) => {
      prefix += char;
      const metrics = weatherCtx.measureText(char);

      const glyphX = x + weatherCtx.measureText(prefix).width - metrics.width;
      const sequence = counts.get(role) || 0;
      counts.set(role, sequence + 1);
      if (/\s/.test(char)) return;
      glyphs.push({
        char,
        role,
        key: numeric ? `${role}:${chars.length - 1 - index}` : `${role}:${sequence}`,
        x: glyphX,
        y,
        fontSize: size,
        weight,
        alpha,
        optical,
        metrics,
      });
    });
  }
  if (layout.kind === 'date') {
    const [day, month] = layout.text.split(' ');
    addLine(day, layout.mainX, layout.baseline, layout.fontSize, 700, 1, true, 'day', true);
    useInfoFont(weatherCtx, layout.fontSize);
    const monthX =
      layout.mainX +
      weatherCtx.measureText(layout.text).width -
      weatherCtx.measureText(month).width;
    addLine(month, monthX, layout.baseline, layout.fontSize, 700, 1, true, 'month');
  } else {
    for (const [lineIndex, line] of layout.primaryLines.entries()) {
      const numeric = layout.kind === 'number';
      const sign = numeric && line.text.startsWith('-') ? '-' : '';
      if (sign) addLine(sign, line.x, line.baseline, layout.fontSize, 700, 1, true, 'sign');
      const text = sign ? line.text.slice(1) : line.text;
      useInfoFont(weatherCtx, layout.fontSize);
      const x = sign
        ? line.x + weatherCtx.measureText(line.text).width - weatherCtx.measureText(text).width
        : line.x;
      const role = numeric ? 'number' : layout.kind === 'moon' ? `main:${lineIndex}` : 'main';
      addLine(text, x, line.baseline, layout.fontSize, 700, 1, true, role, numeric);
    }
  }
  if (layout.primaryUnit)
    addLine(
      layout.primaryUnit,
      layout.unitX,
      layout.unitBaseline,
      layout.unitSize,
      500,
      0.88,
      true,
      'unit',
    );
  layout.tailLines.forEach((line, index) => {
    useInfoFont(weatherCtx, layout.tailSize, 500);
    addLine(
      line,
      layout.tailX + (weatherCtx.measureText(line).actualBoundingBoxLeft || 0),
      layout.tailBaseline - (layout.tailLines.length - 1 - index) * layout.tailSize * 1.2,
      layout.tailSize,
      500,
      0.76,
      false,
      'tail',
    );
  });
  (layout.lines || []).forEach((line, index) => {
    useInfoFont(weatherCtx, layout.labelSize, 500);
    const metric = weatherCtx.measureText(line);
    addLine(
      line,
      (layout.w - inkWidth(metric)) / 2 + (metric.actualBoundingBoxLeft || 0),
      layout.labelY + index * layout.labelSize * 1.4,
      layout.labelSize,
      500,
      0.78,
      false,
      'tail',
    );
  });
  return glyphs;
}

function infoGlyphGeometry(glyph: InfoGlyph) {
  const scale = Math.max(0.08, Math.min(3, glyph.fontSize / 320));
  const padding = glyph.optical ? Math.ceil(128 * scale) : Math.max(2, glyph.fontSize * 0.04);
  const ascent = glyph.metrics.actualBoundingBoxAscent || glyph.fontSize * 0.73;
  const descent = glyph.metrics.actualBoundingBoxDescent || 0;
  return {
    scale,
    offsetX: -(glyph.metrics.actualBoundingBoxLeft || 0) - padding,
    offsetY: -ascent - padding,
    width: Math.max(1, inkWidth(glyph.metrics) + padding * 2),
    height: Math.max(1, ascent + descent + padding * 2),
  };
}

function buildInfoGlyphTile(glyph: InfoGlyph, layout: InfoLayout, dpr: number) {
  const geometry = infoGlyphGeometry(glyph);
  const { scale, offsetX, offsetY, width, height } = geometry;
  const layer = makeLayer(width, height, dpr);
  const tile = { ...layer, offsetX, offsetY, fontSize: glyph.fontSize, dpr };
  const draw = (ctx: CanvasContext, color: string = '#ffffff') => {
    useInfoFont(ctx, glyph.fontSize, glyph.weight);
    ctx.fillStyle = color;
    ctx.fillText(glyph.char, -offsetX, -offsetY);
  };
  if (!glyph.optical) {
    draw(layer.ctx);
    return tile;
  }
  const scratch = makeLayer(width, height, dpr);
  const reset = () => {
    const ctx = scratch.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    return ctx;
  };
  const mask = (stops: Stops) => {
    const ctx = scratch.ctx;
    const left = glyph.x + offsetX,
      top = glyph.y + offsetY;
    const gradient = ctx.createLinearGradient(
      layout.primaryLeft - left,
      layout.primaryBottom - top,
      layout.primaryRight - left,
      layout.primaryTop - top,
    );
    stops.forEach(([position, alpha]) => gradient.addColorStop(position, `rgba(0,0,0,${alpha})`));
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.globalCompositeOperation = 'source-over';
  };
  const composite = (dx = 0, dy = 0, blur = 0, tint: string | null = null) =>
    drawCompatImage(
      layer.ctx,
      scratch.canvas,
      dx * scale,
      dy * scale,
      scratch.width,
      scratch.height,
      blur,
      tint,
    );
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    const ctx = reset();
    paintCompatBlur(ctx, blur * scale, (target) => draw(target, color), opaqueCompatColor(color));
    mask([
      [0, 0.38],
      [0.14, 1],
      [0.84, 1],
      [1, 0.32],
    ]);
    composite();
  }
  BLUR_RADII.forEach((radius, index) => {
    const ctx = reset();
    paintCompatBlur(
      ctx,
      radius * scale,
      (target) => draw(target),
      glyph.char === 'moon' ? null : '#ffffff',
    );
    mask(PASS_STOPS[index]);
    composite();
  });
  for (const [stops, color, blur, alpha, dx, dy] of [
    [
      [
        [0, 0],
        [0.76, 0],
        [0.9, 0.55],
        [1, 1],
      ],
      '#ffffff',
      16,
      0.25,
      8,
      -7,
    ],
    [
      [
        [0, 0],
        [0.76, 0],
        [0.9, 0.55],
        [1, 1],
      ],
      '#80c8ff',
      30,
      0.2,
      18,
      -15,
    ],
    [
      [
        [0, 0.85],
        [0.11, 0.35],
        [0.22, 0],
        [1, 0],
      ],
      '#ffffff',
      13,
      0.16,
      -6,
      5,
    ],
  ] as const) {
    draw(reset(), color);
    mask(stops);
    layer.ctx.save();
    layer.ctx.globalAlpha = alpha;
    composite(dx, dy, blur * scale, opaqueCompatColor(color));
    layer.ctx.restore();
  }
  compositor.forget(scratch.canvas);
  scratch.canvas.width = scratch.canvas.height = 0;
  return tile;
}

function buildInfoMoonTile(glyph: InfoGlyph, layout: InfoLayout, dpr: number) {
  const geometry = infoGlyphGeometry(glyph);
  const { scale, offsetX, offsetY, width, height } = geometry;
  const layer = makeLayer(width, height, dpr);
  const scratch = makeLayer(width, height, dpr);
  const tile = { ...layer, offsetX, offsetY, fontSize: glyph.fontSize, dpr };
  const reset = () => {
    const ctx = scratch.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    return ctx;
  };
  const draw = (ctx: CanvasContext, color = '') => {
    if (!layout.moon) return;
    drawMoon(ctx, -offsetX, -offsetY, layout.radius, layout.moon, layout.southernHemisphere);
    if (color) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-in';
      ctx.filter = 'none';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, scratch.width, scratch.height);
      ctx.restore();
    }
  };
  const mask = (stops: Stops) => {
    const ctx = scratch.ctx;
    const left = glyph.x + offsetX,
      top = glyph.y + offsetY;
    const gradient = ctx.createLinearGradient(
      layout.primaryLeft - left,
      layout.primaryBottom - top,
      layout.primaryRight - left,
      layout.primaryTop - top,
    );
    stops.forEach(([position, alpha]) => gradient.addColorStop(position, `rgba(0,0,0,${alpha})`));
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.globalCompositeOperation = 'source-over';
  };
  const composite = (dx = 0, dy = 0, blur = 0, tint: string | null = null) =>
    drawCompatImage(
      layer.ctx,
      scratch.canvas,
      dx * scale,
      dy * scale,
      scratch.width,
      scratch.height,
      blur,
      tint,
    );
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    const ctx = reset();
    paintCompatBlur(ctx, blur * scale, (target) => draw(target, color), opaqueCompatColor(color));
    mask([
      [0, 0.38],
      [0.14, 1],
      [0.84, 1],
      [1, 0.32],
    ]);
    composite();
  }
  BLUR_RADII.forEach((radius, index) => {
    const ctx = reset();
    paintCompatBlur(
      ctx,
      radius * scale,
      (target) => draw(target),
      glyph.char === 'moon' ? null : '#ffffff',
    );
    mask(PASS_STOPS[index]);
    composite();
  });
  for (const [stops, color, blur, alpha, dx, dy] of [
    [
      [
        [0, 0],
        [0.76, 0],
        [0.9, 0.55],
        [1, 1],
      ],
      '#ffffff',
      16,
      0.25,
      8,
      -7,
    ],
    [
      [
        [0, 0],
        [0.76, 0],
        [0.9, 0.55],
        [1, 1],
      ],
      '#80c8ff',
      30,
      0.2,
      18,
      -15,
    ],
    [
      [
        [0, 0.85],
        [0.11, 0.35],
        [0.22, 0],
        [1, 0],
      ],
      '#ffffff',
      13,
      0.16,
      -6,
      5,
    ],
  ] as const) {
    draw(reset(), color);
    mask(stops);
    layer.ctx.save();
    layer.ctx.globalAlpha = alpha;
    composite(dx, dy, blur * scale, opaqueCompatColor(color));
    layer.ctx.restore();
  }
  compositor.forget(scratch.canvas);
  scratch.canvas.width = scratch.canvas.height = 0;
  return tile;
}

function buildInfoScene(name: SceneName, layout: InfoLayout, dpr: number) {
  const glyphs = getInfoGlyphs(layout);
  if (layout.kind === 'moon') {
    glyphs.unshift({
      char: 'moon',
      role: 'moon',
      key: 'moon',
      optical: true,
      x: layout.moonX,
      y: layout.moonY,
      fontSize: layout.fontSize,
      weight: 700,
      alpha: 1,
      metrics: {
        width: layout.fontSize,
        actualBoundingBoxLeft: layout.radius,
        actualBoundingBoxRight: layout.radius,
        actualBoundingBoxAscent: layout.radius,
        actualBoundingBoxDescent: layout.radius,
      },
    });
  }
  const opticalGlyphs = glyphs.filter((glyph) => glyph.optical);
  const area = opticalGlyphs.reduce((sum, glyph) => {
    const geometry = infoGlyphGeometry(glyph);
    return sum + geometry.width * geometry.height;
  }, 0);

  const tileDpr = Math.min(dpr, Math.sqrt((INFO_TILE_PIXEL_BUDGET * 0.98) / Math.max(1, area)));
  opticalGlyphs.forEach((glyph) => {
    glyph.tile =
      glyph.role === 'moon'
        ? buildInfoMoonTile(glyph, layout, tileDpr)
        : buildInfoGlyphTile(glyph, layout, tileDpr);
  });
  return { name, layout, dpr, tileDpr, glyphs };
}

function releaseInfoScene(scene: InfoScene | null) {
  if (!scene) return;
  scene.glyphs.forEach((glyph) => {
    if (glyph.tile) {
      compositor.forget(glyph.tile.canvas);
      glyph.tile.canvas.width = glyph.tile.canvas.height = 0;
    }
  });
}

function releaseInfoTransition(transition: InfoTransition | null) {
  if (!transition) return;
  releaseInfoScene(transition.from);
  transition.pairs.forEach((pair) => {
    if (pair.mixed) {
      compositor.forget(pair.mixed.canvas);
      pair.mixed.canvas.width = pair.mixed.canvas.height = 0;
    }
  });
}

function matchInfoGlyphs(from: InfoScene, to: InfoScene) {
  const pairs: InfoPair[] = [];
  const roles = new Set([...from.glyphs, ...to.glyphs].map((glyph) => glyph.role));
  for (const role of roles) {
    const a = from.glyphs.filter((glyph) => glyph.role === role);
    const b = to.glyphs.filter((glyph) => glyph.role === role);
    if (role === 'number' || role === 'day' || role === 'sign' || role === 'unit') {
      const old = new Map(a.map((glyph) => [glyph.key, glyph]));
      b.forEach((glyph) => {
        const previous = old.get(glyph.key);
        old.delete(glyph.key);
        pairs.push({ from: previous, to: glyph, unchanged: previous?.char === glyph.char });
      });
      old.forEach((glyph) => pairs.push({ from: glyph, to: null, unchanged: false }));
      continue;
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] =
          a[i].char === b[j].char ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    const anchors = [];
    let i = 0,
      j = 0;
    while (i < a.length && j < b.length) {
      if (a[i].char === b[j].char) {
        anchors.push([i++, j++]);
      } else if (dp[i + 1][j] > dp[i][j + 1]) i++;
      else j++;
    }
    let ai = 0,
      bi = 0;
    for (const [endA, endB] of [...anchors, [a.length, b.length]] as const) {
      while (ai < endA || bi < endB) {
        pairs.push({
          from: ai < endA ? a[ai++] : null,
          to: bi < endB ? b[bi++] : null,
          unchanged: false,
        });
      }
      if (endA < a.length && endB < b.length) {
        pairs.push({ from: a[endA], to: b[endB], unchanged: true });
        ai++;
        bi++;
      }
    }
  }
  return pairs;
}

function infoBlendGeometry(pair: InfoPair) {
  const a = pair.from?.tile,
    b = pair.to?.tile;
  if (!a || !b || !pair.to) throw new Error('Missing optical glyph tile');
  const size = pair.to.fontSize;
  const left = Math.min(a.offsetX / a.fontSize, b.offsetX / b.fontSize) * size;
  const top = Math.min(a.offsetY / a.fontSize, b.offsetY / b.fontSize) * size;
  const right =
    Math.max((a.offsetX + a.width) / a.fontSize, (b.offsetX + b.width) / b.fontSize) * size;
  const bottom =
    Math.max((a.offsetY + a.height) / a.fontSize, (b.offsetY + b.height) / b.fontSize) * size;
  return { offsetX: left, offsetY: top, width: right - left, height: bottom - top, fontSize: size };
}

function createInfoTransition(from: InfoScene, to: InfoScene, now: number) {
  const pairs = matchInfoGlyphs(from, to);
  const area = pairs
    .filter((pair) => pair.unchanged && pair.from?.optical && pair.to?.optical)
    .reduce((sum, pair) => {
      const geometry = infoBlendGeometry(pair);
      return sum + geometry.width * geometry.height;
    }, 0);
  return {
    start: now,
    from,
    to,
    pairs,
    mixDpr: Math.min(
      from.tileDpr,
      to.tileDpr,
      Math.sqrt((INFO_TILE_PIXEL_BUDGET * 0.98) / Math.max(1, area)),
    ),
  };
}

function blendUnchangedInfoGlyph(pair: InfoPair, progress: number, dpr: number) {
  if (!pair.from?.tile || !pair.to?.tile) return undefined;
  if (progress <= 0) return pair.from.tile;
  if (progress >= 1) return pair.to.tile;
  if (!pair.mixed) {
    const geometry = infoBlendGeometry(pair);
    pair.mixed = { ...makeLayer(geometry.width, geometry.height, dpr), ...geometry, dpr };
  }
  const mixed = pair.mixed,
    ctx = mixed.ctx;
  ctx.clearRect(0, 0, mixed.width, mixed.height);
  for (const [tile, alpha, operation] of [
    [pair.from.tile, 1 - progress, 'source-over'],
    [pair.to.tile, progress, 'lighter'],
  ] as const) {
    const ratio = mixed.fontSize / tile.fontSize;
    ctx.globalCompositeOperation = operation;
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      tile.canvas,
      tile.offsetX * ratio - mixed.offsetX,
      tile.offsetY * ratio - mixed.offsetY,
      tile.width * ratio,
      tile.height * ratio,
    );
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return mixed;
}

function drawInfoGlyph(
  glyph: InfoGlyph,
  x: number,
  y: number,
  size: number,
  alpha = 1,
  blur = 0,
  tile = glyph.tile,
) {
  if (alpha <= 0) return;
  weatherCtx.save();
  weatherCtx.globalAlpha = glyph.alpha * alpha;
  weatherCtx.globalCompositeOperation = 'source-over';
  if (!glyph.optical) {
    useInfoFont(weatherCtx, size, glyph.weight);
    weatherCtx.fillStyle = '#ffffff';
    compositor.text(weatherCtx, glyph.char, x, y, blur);
  } else if (tile) {
    const ratio = size / tile.fontSize;
    drawCompatImage(
      weatherCtx,
      tile.canvas,
      x + tile.offsetX * ratio,
      y + tile.offsetY * ratio,
      tile.width * ratio,
      tile.height * ratio,
      blur,
    );
  }
  weatherCtx.restore();
}

function drawInfoTextTransition(transition: InfoTransition, progress: number) {
  const t = smoothProgress(progress);
  const exit = Math.min(1, t / 0.6);
  const entry = Math.max(0, (t - 0.15) / 0.85);
  transition.pairs.forEach((pair) => {
    const from = pair.from || pair.to,
      to = pair.to || pair.from;
    if (!from || !to) return;
    const x = lerp(from.x, to.x, t),
      y = lerp(from.y, to.y, t);
    const size = lerp(from.fontSize, to.fontSize, t);
    if (pair.unchanged) {
      const glyph = from.alpha === to.alpha ? to : { ...to, alpha: lerp(from.alpha, to.alpha, t) };
      const tile = glyph.optical ? blendUnchangedInfoGlyph(pair, t, transition.mixDpr) : undefined;
      drawInfoGlyph(glyph, x, y, size, 1, 0, tile);
      return;
    }
    if (pair.from)
      drawInfoGlyph(from, x + size * 0.07 * t, y - size * 0.07 * t, size, 1 - exit, 12 * t);
    if (pair.to)
      drawInfoGlyph(
        to,
        x - size * 0.045 * (1 - entry),
        y + size * 0.045 * (1 - entry),
        size,
        entry,
        8 * (1 - entry),
      );
  });
}

function settleInfoTransition() {
  releaseInfoTransition(infoTransition);
  infoTransition = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    infoWasHidden = true;
    settleInfoTransition();
  }
});

function updateInfoControls(layout: InfoLayout, sceneName: SceneName) {
  weatherCanvas.setAttribute(
    'aria-label',
    [
      layout.text,
      layout.primaryUnit === '°' ? 'degrees Celsius' : '',
      layout.tailText || layout.label,
      layout.source === 'air' ? getAirQualityDescription(airState.aqi) : '',
    ]
      .filter(Boolean)
      .join(' ') || sceneName,
  );
  weatherRetry.hidden = !layout.retry;
  if (layout.retry) weatherRetry.style.top = `${layout.actionY}px`;
  weatherAttribution.hidden = !layout.source;
  if (layout.source) {
    const updated =
      layout.stale && layout.updatedAt != null
        ? 'Last update ' +
          new Date(layout.updatedAt).toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
          }) +
          ' · '
        : '';
    weatherAttribution.textContent =
      updated + (layout.source === 'air' ? 'CAMS · Open-Meteo' : 'Open-Meteo');
    weatherAttribution.href =
      layout.source === 'air'
        ? 'https://open-meteo.com/en/docs/air-quality-api'
        : 'https://open-meteo.com/';
    weatherAttribution.title =
      layout.source === 'air'
        ? 'US EPA Air Quality Index · CAMS / Open-Meteo'
        : 'Weather data · Open-Meteo';
  }
}

function renderWeatherFrame(now: number, sceneName: SceneName = 'weather') {
  const rect = weatherCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height || document.hidden) return;
  const dpr = getRenderDpr(rect.width, rect.height);
  const layout =
    sceneName === 'weather'
      ? buildWeatherLayout(weatherState, rect.width, rect.height)
      : buildInfoLayout(sceneName, rect.width, rect.height);
  const key = JSON.stringify([
    sceneName,
    rect.width,
    rect.height,
    dpr,
    layout.kind,
    layout.text,
    layout.primaryUnit,
    layout.tailText,
    layout.label,
    layout.retry,
    layout.moon && [
      Math.round(layout.moon.fraction * 100000),
      layout.moon.waxing,
      layout.southernHemisphere,
    ],
  ]);
  const resized =
    !!currentInfoLayout &&
    (currentInfoLayout.w !== rect.width ||
      currentInfoLayout.h !== rect.height ||
      currentInfoScene?.dpr !== dpr);
  const changed = key !== infoRenderKey;
  let repaint = changed || infoWasHidden;
  currentInfoLayout = layout;
  const controlsKey = JSON.stringify([key, layout.stale, layout.updatedAt, layout.source]);
  if (controlsKey !== infoControlsKey) {
    updateInfoControls(layout, sceneName);
    infoControlsKey = controlsKey;
  }
  if (changed) {
    const animate =
      currentInfoScene &&
      currentInfoScene.name === sceneName &&
      !resized &&
      !reducedMotion.matches &&
      !infoWasHidden &&
      !infoTransition;
    if (!animate) {
      settleInfoTransition();
      releaseInfoScene(currentInfoScene);
    }
    const next = buildInfoScene(sceneName, layout, dpr);
    if (animate && currentInfoScene)
      infoTransition = createInfoTransition(currentInfoScene, next, now);
    currentInfoScene = next;
    infoRenderKey = key;
  }
  if (infoTransition && (reducedMotion.matches || infoWasHidden || resized)) {
    settleInfoTransition();
    repaint = true;
  }
  infoWasHidden = false;
  if (infoTransition && now - infoTransition.start >= INFO_TRANSITION_MS) {
    settleInfoTransition();
    repaint = true;
  }
  if (!repaint && !infoTransition) return;
  const pixelW = Math.round(rect.width * dpr),
    pixelH = Math.round(rect.height * dpr);
  if (weatherCanvas.width !== pixelW || weatherCanvas.height !== pixelH) {
    weatherCanvas.width = pixelW;
    weatherCanvas.height = pixelH;
  }
  weatherCtx.setTransform(1, 0, 0, 1, 0, 0);
  weatherCtx.clearRect(0, 0, weatherCanvas.width, weatherCanvas.height);
  weatherCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  compositor.begin(weatherCtx);
  if (infoTransition)
    drawInfoTextTransition(infoTransition, (now - infoTransition.start) / INFO_TRANSITION_MS);
  else
    currentInfoScene?.glyphs.forEach((glyph) =>
      drawInfoGlyph(glyph, glyph.x, glyph.y, glyph.fontSize),
    );
  compositor.end(weatherCtx);
}

const backgroundGrain = element('backgroundGrain', 'div');
interface BackgroundImageRecord {
  scene: BackgroundImageScene;
  variant: BackgroundImageVariant;
  image: HTMLImageElement;
  status: 'loading' | 'ready' | 'error';
  failedAt: number;
  cancel: () => void;
}
const imageBackgrounds = (() => {
  const cache = new Map<string, BackgroundImageRecord>();
  const slots: (BackgroundImageRecord | null)[] = [null, null];
  let root: HTMLDivElement | null = null;
  let layers: HTMLDivElement[] = [];
  let currentIndex = 0;
  let currentSpec: BackgroundSpec | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let transition: {
    from: number;
    to: number;
    start: number;
    fromGrain: number;
    toGrain: number;
  } | null = null;
  function sceneFor(spec: BackgroundSpec) {
    if (spec.pending) return undefined;
    return IMAGE_BACKGROUND_MANIFEST.scenes.find((scene) =>
      spec.key === 'clock' || spec.key.startsWith('air-')
        ? scene.key === spec.key
        : scene.kind === 'photo' &&
          scene.asset === spec.asset &&
          Math.abs(scene.brightness - spec.brightness) < 0.000001,
    );
  }
  function variantFor(scene: BackgroundImageScene) {
    const width = Math.max(1, innerWidth),
      height = Math.max(1, innerHeight);
    let best = scene.variants[0],
      score = Infinity;
    for (const variant of scene.variants) {
      const w = variant.viewportWidth,
        h = variant.viewportHeight;
      const aspect = Math.abs(Math.log(width / height / (w / h)));
      const undersize = Math.max(0, Math.log(width / w), Math.log(height / h));
      const area = Math.abs(Math.log((width * height) / (w * h)));
      const next = aspect * 5 + undersize * 0.8 + area * 0.12;
      if (next < score) {
        score = next;
        best = variant;
      }
    }
    return best;
  }
  function initialize() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'imageBackgroundRoot';
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;pointer-events:none;';
    layers = [0, 1].map(() => {
      const layer = document.createElement('div');
      layer.className = 'image-background-layer';
      layer.style.cssText = 'position:absolute;inset:0;opacity:0;overflow:hidden;';
      root?.appendChild(layer);
      return layer;
    });
    document.body.prepend(root);
  }
  function trimCache(latestFile: string) {
    const protectedFiles = new Set(
      slots
        .filter((slot): slot is BackgroundImageRecord => slot !== null)
        .map((slot) => slot.variant.file),
    );
    protectedFiles.add(latestFile);
    if (currentSpec) {
      const currentScene = sceneFor(currentSpec);
      if (currentScene) protectedFiles.add(variantFor(currentScene).file);
    }
    for (const [file, record] of cache) {
      if (cache.size <= 5) break;
      if (protectedFiles.has(file)) continue;
      record.cancel();
      cache.delete(file);
    }
  }
  function prepare(spec: BackgroundSpec): BackgroundImageRecord | null {
    if (disposed) return null;
    const scene = sceneFor(spec);
    if (!scene) return null;
    const variant = variantFor(scene),
      file = variant.file;
    const cached = cache.get(file);
    if (cached && (cached.status !== 'error' || Date.now() - cached.failedAt < 30000)) {
      cache.delete(file);
      cache.set(file, cached);
      return cached;
    }
    if (cached) {
      cached.cancel();
      cache.delete(file);
    }
    const image = new Image();
    image.alt = '';
    image.decoding = 'async';
    image.style.cssText =
      'display:block;width:100%;height:100%;object-fit:cover;object-position:center;';
    let canceled = false;
    const record: BackgroundImageRecord = {
      scene,
      variant,
      image,
      status: 'loading',
      failedAt: 0,
      cancel() {
        canceled = true;
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
      },
    };
    const finish = (ready: boolean) => {
      if (canceled || disposed) return;
      record.status = ready && image.naturalWidth > 0 ? 'ready' : 'error';
      if (record.status === 'error') record.failedAt = Date.now();
      image.onload = null;
      image.onerror = null;
      if (
        record.status === 'ready' &&
        scene.kind === 'clock' &&
        !slots[currentIndex] &&
        (!currentSpec || currentSpec.key === 'clock')
      ) {
        apply(getBackgroundSpec('clock'), performance.now());
      }
    };
    image.onload = () => {
      if (typeof image.decode === 'function')
        image
          .decode()
          .then(() => finish(true))
          .catch(() => finish(false));
      else finish(true);
    };
    image.onerror = () => finish(false);
    cache.set(file, record);
    image.src = file;
    trimCache(file);
    return record;
  }
  function advance(now: number) {
    if (!transition) return;
    const raw = reducedMotion.matches
      ? 1
      : Math.min(1, Math.max(0, (now - transition.start) / 1200));
    const progress = smoothProgress(raw);
    layers[transition.to].style.opacity = String(progress);
    backgroundGrain.style.opacity = String(
      lerp(transition.fromGrain, transition.toGrain, progress),
    );
    if (raw === 1) {
      layers[transition.from].style.opacity = '0';
      layers[transition.from].textContent = '';
      slots[transition.from] = null;
      transition = null;
    }
  }
  function apply(spec: BackgroundSpec, now: number) {
    if (disposed) return;
    initialize();
    advance(now);
    if (spec.pending) return;
    currentSpec = spec;
    const record = prepare(spec);
    if (!record || record.status !== 'ready' || transition) return;
    if (slots[currentIndex]?.variant.file === record.variant.file) return;
    const grainSource = document.getElementById('grainLayer');
    if (grainSource && backgroundGrain.style.backgroundImage !== grainSource.style.backgroundImage)
      backgroundGrain.style.backgroundImage = grainSource.style.backgroundImage;
    const immediate = !slots[currentIndex];
    const previous = currentIndex,
      next = immediate ? currentIndex : 1 - currentIndex;
    layers[next].textContent = '';
    layers[next].appendChild(record.image);
    layers[next].style.zIndex = '1';
    layers[1 - next].style.zIndex = '0';
    layers[next].style.opacity = immediate ? '1' : '0';
    slots[next] = record;
    currentIndex = next;
    if (immediate) backgroundGrain.style.opacity = String(record.scene.grainOpacity);
    else
      transition = {
        from: previous,
        to: next,
        start: now,
        fromGrain: Number(backgroundGrain.style.opacity) || 0,
        toGrain: record.scene.grainOpacity,
      };
  }
  function resize() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    if (disposed) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!disposed && currentSpec) prepare(currentSpec);
    }, 120);
  }
  function dispose() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = null;
    transition = null;
    currentSpec = null;
    for (const record of cache.values()) record.cancel();
    cache.clear();
    slots[0] = slots[1] = null;
    root?.remove();
    root = null;
    layers = [];
    currentIndex = 0;
  }
  return { prepare, apply, resize, dispose };
})();

function getAirPalette(value: number | null) {
  if (!finite(value) || value < 0)
    return { key: 'unknown', edge: '#315675', middle: '#172a43', base: '#071323' };
  const aqi = Math.round(value);
  if (aqi <= 50) return { key: 'good', edge: '#20895d', middle: '#174d49', base: '#03171e' };
  if (aqi <= 100) return { key: 'moderate', edge: '#b99b37', middle: '#6b5824', base: '#171b1a' };
  if (aqi <= 150) return { key: 'sensitive', edge: '#ca682c', middle: '#6b3332', base: '#241322' };
  if (aqi <= 200) return { key: 'unhealthy', edge: '#c04458', middle: '#67213e', base: '#250c24' };
  if (aqi <= 300)
    return { key: 'very-unhealthy', edge: '#7850ad', middle: '#3c2566', base: '#130f2a' };
  return { key: 'hazardous', edge: '#88234b', middle: '#461c3c', base: '#170d24' };
}

function getBackgroundSpec(sceneName: SceneName, date = new Date()): BackgroundSpec {
  if (sceneName === 'clock') return { key: 'clock', asset: null, gradient: '', brightness: 1 };
  if (sceneName === 'weather' && weatherState.status !== 'ready') {
    return { key: 'weather-pending', asset: null, gradient: '', brightness: 1, pending: true };
  }
  if (sceneName === 'air') {
    const palette = getAirPalette(airState.status === 'ready' ? airState.aqi : null);
    return {
      key: 'air-' + palette.key,
      asset: null,
      brightness: 1,
      gradient: `radial-gradient(ellipse at 82% 18%, ${palette.edge} 0%, transparent 65%), radial-gradient(ellipse at 16% 65%, ${palette.middle} 0%, transparent 72%), linear-gradient(135deg, ${palette.middle}, ${palette.base})`,
    };
  }
  let asset = 'cloudy',
    variant = '',
    brightness = 0.78;
  if (sceneName === 'date') {
    const month = (date.getMonth() + ((weatherCoordinates?.latitude ?? 0) < 0 ? 6 : 0)) % 12;
    asset =
      month >= 2 && month <= 4
        ? 'spring'
        : month >= 5 && month <= 7
          ? 'summer'
          : month >= 8 && month <= 10
            ? 'autumn'
            : 'winter';
  } else if (sceneName === 'moon') {
    asset = 'night';
    brightness = 0.86;
  } else if (sceneName === 'weather' && weatherState.status === 'ready') {
    const code = weatherState.weatherCode ?? -1;
    if ([71, 73, 75, 77, 85, 86].includes(code)) asset = 'winter';
    else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code))
      asset = 'rain';
    else if ([2, 3, 45, 48].includes(code)) asset = 'cloudy';
    else if ([0, 1].includes(code)) asset = weatherState.isDay ? 'summer' : 'night';
    if (code >= 95) {
      brightness = 0.6;
      variant = '-storm';
    }
    if (!weatherState.isDay) {
      brightness *= 0.76;
      variant += '-night';
    }
  }
  return {
    key: `${sceneName}-${asset}${variant}`,
    asset: `assets/backgrounds/${asset}.webp`,
    gradient: 'linear-gradient(135deg, #142b43, #080f20)',
    brightness,
  };
}

function applySceneBackground(sceneName: SceneName, now = performance.now()) {
  imageBackgrounds.apply(getBackgroundSpec(sceneName), now);
  const nextScene = SCENE_NAMES[(SCENE_NAMES.indexOf(sceneName) + 1) % SCENE_NAMES.length];
  imageBackgrounds.prepare(getBackgroundSpec(nextScene));
}

function applySceneState(scene: ReturnType<typeof getSceneState>, now = performance.now()) {
  applySceneBackground(scene.name, now);
  clockCanvas.style.opacity = String(scene.clockOpacity);
  speckleCanvas.style.opacity = String(scene.clockOpacity);
  weatherCanvas.style.opacity = String(scene.weatherOpacity);
  compositor.sync(clockCtx);
  compositor.sync(weatherCtx);
  weatherRetry.style.opacity = String(scene.weatherOpacity);
  weatherAttribution.style.opacity = String(scene.weatherOpacity);
  const infoActive = scene.name !== 'clock' && scene.opacity > 0.5;
  weatherRetry.style.pointerEvents = infoActive ? 'auto' : 'none';
  weatherAttribution.style.pointerEvents = infoActive ? 'auto' : 'none';
  weatherRetry.tabIndex = infoActive && !weatherRetry.hidden ? 0 : -1;
  weatherAttribution.tabIndex = infoActive && !weatherAttribution.hidden ? 0 : -1;
  weatherRetry.setAttribute('aria-hidden', String(!infoActive));
  weatherAttribution.setAttribute('aria-hidden', String(!infoActive));
  clockCanvas.setAttribute('aria-hidden', String(scene.name !== 'clock'));
  weatherCanvas.setAttribute('aria-hidden', String(scene.name === 'clock'));
  if (activeSceneName !== scene.name) {
    if (scene.name === 'clock') {
      settleInfoTransition();
      releaseInfoScene(currentInfoScene);
      currentInfoScene = null;
      infoRenderKey = '';
    }
    activeSceneName = scene.name;
    mainStage.setAttribute('aria-label', scene.name);
  }
}

document.addEventListener('visibilitychange', () => {
  const now = performance.now();
  if (document.hidden) {
    if (sceneHiddenAt === null) sceneHiddenAt = now;
  } else if (sceneHiddenAt !== null) {
    if (sceneStartedAt !== null) sceneStartedAt += now - sceneHiddenAt;
    sceneHiddenAt = null;
  }
});
weatherRetry.addEventListener('click', (event) => {
  event.stopPropagation();
  requestWeatherLocation().catch(handleLocalDataError);
});

function mainAnimationLoop(now: number) {
  animationFrame = 0;
  if (disposed) return;
  if (!document.hidden) {
    const scene = getSceneState(now);
    if (scene.name === 'clock') {
      renderFrame(now);
      updateAndDrawSpeckles(now);
    } else {
      renderWeatherFrame(now, scene.name);
    }
    applySceneState(scene, now);
  }
  startAnimationLoop();
}

function startAnimationLoop() {
  if (disposed || animationFrame !== 0) return;
  animationFrame = requestAnimationFrame(mainAnimationLoop);
}

window.addEventListener('dblclick', (event) => {
  if (window.parent !== window) return;
  if (event.target instanceof Element && event.target.closest('button, a')) return;
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

window.addEventListener('resize', () => {
  imageBackgrounds.resize();
  resizeSpeckleCanvas();
  lastViewportW = 0;
});

function loadGoogleSansStylesheet(): Promise<boolean> {
  return new Promise((resolve) => {
    const stylesheet = document.createElement('link');
    stylesheet.id = 'googleSansStylesheet';
    stylesheet.rel = 'stylesheet';
    stylesheet.media = 'print';
    stylesheet.href =
      'https://fonts.googleapis.com/css2?family=Google+Sans:wght@500;700&display=swap';
    const finish = (loaded: boolean) => {
      stylesheet.removeEventListener('load', onLoad);
      stylesheet.removeEventListener('error', onError);
      if (loaded) stylesheet.media = 'all';
      resolve(loaded);
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    stylesheet.addEventListener('load', onLoad);
    stylesheet.addEventListener('error', onError);
    document.head.append(stylesheet);
    if (stylesheet.sheet) finish(true);
  });
}

async function warmGoogleSansFonts() {
  try {
    if (!(await loadGoogleSansStylesheet())) {
      console.warn('Google Sans is unavailable; the clock will use a fallback font.');
      return;
    }
    if (!document.fonts?.load) return;
    const [faces] = await Promise.all([
      document.fonts.load('700 100px "Google Sans"', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      document.fonts.load(
        '500 100px "Google Sans"',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789°',
      ),
    ]);
    if (!faces.length)
      console.warn('Google Sans is unavailable; the clock will use a fallback font.');
    if (!disposed) invalidateFontLayouts();
  } catch (error) {
    console.warn('Google Sans could not load; the clock will use a fallback font.', error);
  }
}

async function initializeScreensaver() {
  const generation = lifecycleGeneration;
  initializeDisplayControls();
  initializeWeather();
  createFilmGrainTile();
  imageBackgrounds.prepare(getBackgroundSpec('clock'));
  resizeSpeckleCanvas();

  await Promise.race([
    warmGoogleSansFonts(),
    new Promise<void>((resolve) => {
      fontWarmupTimer = setTimeout(resolve, 3000);
    }),
  ]);
  if (fontWarmupTimer !== null) {
    clearTimeout(fontWarmupTimer);
    fontWarmupTimer = null;
  }

  if (disposed || generation !== lifecycleGeneration) return;
  for (let digit = 0; digit < 10; digit++)
    buildSecondsMorphPair(String(digit), String((digit + 1) % 10));
  buildSecondsMorphPair('5', '0');
  lastViewportW = 0;
  startAnimationLoop();
}

function invalidateFontLayouts() {
  fittedFont = null;
  lastViewportW = 0;
  infoRenderKey = '';
}

document.fonts?.addEventListener('loadingdone', () => {
  if (!disposed) invalidateFontLayouts();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) showControls();
});

document.addEventListener('DOMContentLoaded', () => {
  initializeScreensaver().catch((error) =>
    console.error('The screen saver could not start.', error),
  );
});
