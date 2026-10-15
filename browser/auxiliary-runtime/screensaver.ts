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
type SceneName = 'clock' | 'date' | 'weather' | 'air' | 'moon' | 'music';
interface InfoContent {
  kind: 'date' | 'moon' | 'number' | 'status' | 'music';
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
interface BackgroundAsset {
  status: 'loading' | 'ready' | 'error';
  image: HTMLImageElement | null;
  promise: Promise<boolean> | null;
}
interface BackgroundTransition {
  from: number;
  to: number | null;
  fromClock: boolean;
  start: number;
  grainFrom: number;
  grainTo: number;
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
interface DisplayUpdate {
  backLabel: string;
  musicLabel: string;
  showMusic: boolean;
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
let hostUpdateReceived = false;
let controlsTimer: ReturnType<typeof setTimeout> | null = null;
let keyboardInteraction = false;
let displayState: DisplayUpdate = {
  backLabel: 'Back to MUSIXQUARE',
  musicLabel: 'Show music info',
  showMusic: true,
  title: '',
  subtitle: '',
  lang: 'en',
  dir: 'ltr',
};
const displayChrome = element('displayChrome', 'div');
const backButton = element('displayBack', 'button');
const musicToggle = element('displayMusicToggle', 'button');
const musicScene = element('musicScene', 'section');
const musicTitle = element('musicTitle', 'div');
const musicTitleWindow = element('musicTitleWindow', 'div');
const musicSubtitle = element('musicSubtitle', 'div');
let musicRenderKey = '';
let musicOverflow = 0;
let musicIsRtl = false;
let fontWarmupTimer: ReturnType<typeof setTimeout> | null = null;
const musicAnimations = new Set<Animation>();
const musicGhosts = new Set<HTMLElement>();

function settleMusicTransition() {
  for (const animation of musicAnimations) animation.cancel();
  musicAnimations.clear();
  for (const ghost of musicGhosts) ghost.remove();
  musicGhosts.clear();
}

function updateMusicText(node: HTMLElement, text: string) {
  if (node.textContent === text) return;
  const animate =
    Boolean(node.textContent) &&
    musicScene.getAttribute('aria-hidden') === 'false' &&
    !reducedMotion.matches &&
    !document.hidden;
  if (animate) {
    const ghost = node.cloneNode(true);
    if (ghost instanceof HTMLElement) {
      ghost.removeAttribute('id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.position = 'absolute';
      ghost.style.left = node.offsetLeft + 'px';
      ghost.style.top = node.offsetTop + 'px';
      ghost.style.width = node.getBoundingClientRect().width + 'px';
      ghost.style.minWidth = '0';
      node.parentElement?.append(ghost);
      musicGhosts.add(ghost);
      const outgoing = ghost.animate(
        Array.from({ length: 31 }, (_, index) => {
          const t = smoothProgress(index / 30);
          return {
            offset: index / 30,
            opacity: 1 - Math.min(1, t / 0.6),
            filter: `blur(${12 * t}px)`,
            translate: `${0.07 * t}em ${-0.07 * t}em`,
          };
        }),
        { duration: INFO_TRANSITION_MS, fill: 'forwards' },
      );
      musicAnimations.add(outgoing);
      outgoing.addEventListener('finish', () => {
        ghost.remove();
        musicGhosts.delete(ghost);
        musicAnimations.delete(outgoing);
      });
    }
  }
  node.textContent = text;
  if (animate) {
    const incoming = node.animate(
      Array.from({ length: 31 }, (_, index) => {
        const entry = Math.max(0, (smoothProgress(index / 30) - 0.15) / 0.85);
        return {
          offset: index / 30,
          opacity: entry,
          filter: `blur(${8 * (1 - entry)}px)`,
          translate: `${-0.045 * (1 - entry)}em ${0.045 * (1 - entry)}em`,
        };
      }),
      { duration: INFO_TRANSITION_MS },
    );
    musicAnimations.add(incoming);
    incoming.addEventListener('finish', () => musicAnimations.delete(incoming));
  }
}

function getSceneNames(): SceneName[] {
  return displayState.showMusic && displayState.title.trim()
    ? ['music', ...SCENE_NAMES]
    : SCENE_NAMES;
}

function postToHost(type: 'ready' | 'close' | 'music-toggle', enabled?: boolean) {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: `mxqr:screensaver:${type}`, ...(enabled === undefined ? {} : { enabled }) },
    location.origin,
  );
}

function isDisplayUpdate(value: unknown): value is DisplayUpdate {
  return (
    isRecord(value) &&
    typeof value.backLabel === 'string' &&
    value.backLabel.length <= 500 &&
    typeof value.musicLabel === 'string' &&
    value.musicLabel.length <= 500 &&
    typeof value.title === 'string' &&
    value.title.length <= 2000 &&
    typeof value.subtitle === 'string' &&
    value.subtitle.length <= 2000 &&
    typeof value.showMusic === 'boolean' &&
    typeof value.lang === 'string' &&
    value.lang.length <= 35 &&
    (value.dir === 'ltr' || value.dir === 'rtl')
  );
}

function applyDisplayUpdate(update: DisplayUpdate) {
  const previousNames = getSceneNames();
  const previous = sceneStartedAt === null ? null : getSceneState(performance.now());
  displayState = { ...update, title: update.title.trim(), subtitle: update.subtitle.trim() };
  const names = getSceneNames();
  if (previous && previousNames.join() !== names.join()) {
    const retainedIndex = names.indexOf(previous.name);
    const clockIndex = names.indexOf('clock');
    sceneStartedAt =
      (sceneHiddenAt ?? performance.now()) -
      ((retainedIndex >= 0 ? retainedIndex : clockIndex) * SCENE_DURATION_MS +
        (retainedIndex >= 0 ? previous.phase : 0));
  }
  displayChrome.lang = update.lang;
  displayChrome.dir = update.dir;
  backButton.setAttribute('aria-label', update.backLabel);
  const brandAt = update.backLabel.indexOf('MUSIXQUARE');
  element('backBefore', 'span').textContent =
    brandAt < 0 ? update.backLabel : update.backLabel.slice(0, brandAt).trim();
  element('backAfter', 'span').textContent =
    brandAt < 0 ? '' : update.backLabel.slice(brandAt + 'MUSIXQUARE'.length).trim();
  element('musicToggleLabel', 'span').textContent = update.musicLabel;
  musicToggle.setAttribute('aria-checked', String(update.showMusic));
  musicRenderKey = '';
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

function renderMusicFrame(phase: number) {
  const key = JSON.stringify([
    displayState.title,
    displayState.subtitle,
    window.innerWidth,
    window.innerHeight,
    reducedMotion.matches,
  ]);
  if (key !== musicRenderKey) {
    settleMusicTransition();
    updateMusicText(musicTitle, displayState.title);
    updateMusicText(musicSubtitle, displayState.subtitle);
    musicTitle.style.fontSize = '';
    if (reducedMotion.matches) {
      const targetHeight = window.innerHeight * 0.4;
      let fontSize = parseFloat(getComputedStyle(musicTitle).fontSize);
      for (
        let attempt = 0;
        attempt < 10 && musicTitle.scrollHeight > targetHeight && fontSize > 8;
        attempt++
      ) {
        fontSize = Math.max(
          8,
          fontSize * Math.min(0.9, Math.sqrt(targetHeight / musicTitle.scrollHeight)),
        );
        musicTitle.style.fontSize = fontSize + 'px';
      }
    }
    musicSubtitle.hidden = !displayState.subtitle;
    musicScene.setAttribute(
      'aria-label',
      [displayState.title, displayState.subtitle].filter(Boolean).join(' · '),
    );
    musicOverflow = Math.max(
      0,
      musicTitle.scrollWidth - musicTitleWindow.clientWidth + window.innerWidth * 0.04,
    );
    musicIsRtl = getComputedStyle(musicTitle).direction === 'rtl';
    musicRenderKey = key;
  }
  const progress = reducedMotion.matches ? 0 : smoothProgress((phase - 1200) / 6500);
  musicTitle.style.transform = `translateX(${-musicOverflow * (musicIsRtl ? 1 - progress : progress)}px)`;
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
  musicToggle.addEventListener('click', () => {
    const enabled = !displayState.showMusic;
    applyDisplayUpdate({ ...displayState, showMusic: enabled });
    postToHost('music-toggle', enabled);
  });
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
  if (!hostUpdateReceived) {
    sceneStartedAt = null;
    hostUpdateReceived = true;
  }
  applyDisplayUpdate(event.data.payload);
});

window.addEventListener('pagehide', () => {
  disposed = true;
  lifecycleGeneration++;
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (controlsTimer !== null) clearTimeout(controlsTimer);
  if (fontWarmupTimer !== null) clearTimeout(fontWarmupTimer);
  settleMusicTransition();
  if (weatherRefreshTimer !== null) clearInterval(weatherRefreshTimer);
  weatherGeneration++;
  for (const controller of weatherFetchControllers) controller.abort();
  weatherFetchControllers.clear();
  settleInfoTransition();
  releaseInfoScene(currentInfoScene);
  if (clockTransition) releaseClockTransition(clockTransition);
  releaseClockScene(currentClockScene);
  if (currentSecondsTile) {
    currentSecondsTile.canvas.width = currentSecondsTile.canvas.height = 0;
    currentSecondsTile.ink.canvas.width = currentSecondsTile.ink.canvas.height = 0;
  }
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
  infoRenderKey = '';
  musicRenderKey = '';
  lastViewportW = 0;
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
    ctx.filter = radius ? `blur(${radius}px)` : 'none';
    drawGlyph(ctx, '#ffffff');
    ctx.filter = 'none';
    mask(ctx, PASS_STOPS[index]);
    ink.ctx.drawImage(scratch.canvas, 0, 0, scratch.width, scratch.height);
  });
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    glow.ctx.filter = `blur(${blur}px)`;
    drawGlyph(glow.ctx, color);
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
    ink.ctx.filter = `blur(${blur}px)`;
    ink.ctx.globalAlpha = alpha;
    ink.ctx.drawImage(scratch.canvas, dx, dy, scratch.width, scratch.height);
    ink.ctx.restore();
  }

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
    tile.ctx.filter = blur ? `blur(${blur}px)` : 'none';
    tile.ctx.fillStyle = color;
    tile.ctx.beginPath();
    tile.ctx.arc(halfW, halfH - offset, radius * scale, 0, Math.PI * 2);
    tile.ctx.arc(halfW, halfH + offset, radius * scale, 0, Math.PI * 2);
    tile.ctx.fill();
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
  tile.ctx.filter = 'blur(7px)';
  tile.ctx.drawImage(tile.ink.canvas, 0, 0, tile.ink.width, tile.ink.height);
  tile.ctx.filter = 'none';
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
      currentSecondsTile.canvas.width = currentSecondsTile.canvas.height = 0;
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
  clockCtx.drawImage(tile.canvas, x + tile.offsetX, y + tile.offsetY, tile.width, tile.height);
  clockCtx.restore();
}

function releaseClockScene(scene: ClockScene | null) {
  if (!scene) return;
  for (const tile of scene.digits) {
    tile.ink.canvas.width = tile.ink.canvas.height = 0;
    tile.glow.canvas.width = tile.glow.canvas.height = 0;
  }
  scene.colon.canvas.width = scene.colon.canvas.height = 0;
}

function releaseClockTransition(transition: ClockTransition) {
  releaseClockScene(transition.from);
  for (const tile of transition.mixedDigits || []) {
    if (!tile) continue;
    tile.ink.canvas.width = tile.ink.canvas.height = 0;
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
  clockCtx.filter = blur > 0.01 ? `blur(${blur}px)` : 'none';
  clockCtx.globalAlpha = alpha * (0.9 + 0.1 * wave);
  clockCtx.drawImage(
    tile.glow.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.glow.width,
    tile.glow.height,
  );
  clockCtx.globalAlpha = alpha;
  clockCtx.drawImage(
    tile.ink.canvas,
    x + tile.offsetX,
    y + tile.offsetY,
    tile.ink.width,
    tile.ink.height,
  );
  clockCtx.restore();
}

function drawColonTile(tile: ColonTile, x: number, y: number, wave: number) {
  clockCtx.save();
  clockCtx.globalAlpha = 0.78 + 0.22 * wave;
  clockCtx.drawImage(tile.canvas, x + tile.offsetX, y + tile.offsetY, tile.width, tile.height);
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
  const names = getSceneNames();
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
    weatherOpacity: name === 'clock' || name === 'music' ? 0 : opacity,
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
    width = primaryWidth + gap + tailWidth;
  }
  measure();
  fontSize *= Math.min(1, maxWidth / Math.max(1, width));
  measure();
  const totalHeight = Math.max(mainHeight, tailHeight);
  const top = (h - totalHeight) / 2;
  const opticalBias = (gap + tailWidth) * (1 - SECONDS_CENTER_WEIGHT) * 0.5;
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
    tailX: left + primaryWidth + gap,
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
  const composite = (dx = 0, dy = 0) =>
    layer.ctx.drawImage(scratch.canvas, dx * scale, dy * scale, scratch.width, scratch.height);
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    const ctx = reset();
    ctx.filter = `blur(${blur * scale}px)`;
    draw(ctx, color);
    ctx.filter = 'none';
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
    ctx.filter = radius ? `blur(${radius * scale}px)` : 'none';
    draw(ctx);
    ctx.filter = 'none';
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
    layer.ctx.filter = `blur(${blur * scale}px)`;
    layer.ctx.globalAlpha = alpha;
    composite(dx, dy);
    layer.ctx.restore();
  }
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
  const composite = (dx = 0, dy = 0) =>
    layer.ctx.drawImage(scratch.canvas, dx * scale, dy * scale, scratch.width, scratch.height);
  for (const [blur, color] of [
    [20, 'rgba(115,195,255,.24)'],
    [5.5, 'rgba(255,255,255,.28)'],
  ] as const) {
    const ctx = reset();
    ctx.filter = `blur(${blur * scale}px)`;
    draw(ctx, color);
    ctx.filter = 'none';
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
    ctx.filter = radius ? `blur(${radius * scale}px)` : 'none';
    draw(ctx);
    ctx.filter = 'none';
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
    layer.ctx.filter = `blur(${blur * scale}px)`;
    layer.ctx.globalAlpha = alpha;
    composite(dx, dy);
    layer.ctx.restore();
  }
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
    if (glyph.tile) glyph.tile.canvas.width = glyph.tile.canvas.height = 0;
  });
}

function releaseInfoTransition(transition: InfoTransition | null) {
  if (!transition) return;
  releaseInfoScene(transition.from);
  transition.pairs.forEach((pair) => {
    if (pair.mixed) pair.mixed.canvas.width = pair.mixed.canvas.height = 0;
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
  weatherCtx.filter = blur > 0.01 ? `blur(${blur}px)` : 'none';
  if (!glyph.optical) {
    useInfoFont(weatherCtx, size, glyph.weight);
    weatherCtx.fillStyle = '#ffffff';
    weatherCtx.fillText(glyph.char, x, y);
  } else if (tile) {
    const ratio = size / tile.fontSize;
    weatherCtx.drawImage(
      tile.canvas,
      x + tile.offsetX * ratio,
      y + tile.offsetY * ratio,
      tile.width * ratio,
      tile.height * ratio,
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
  if (infoTransition)
    drawInfoTextTransition(infoTransition, (now - infoTransition.start) / INFO_TRANSITION_MS);
  else
    currentInfoScene?.glyphs.forEach((glyph) =>
      drawInfoGlyph(glyph, glyph.x, glyph.y, glyph.fontSize),
    );
}

const BACKGROUND_IMAGES: Record<string, string> = {
  'assets/backgrounds/spring.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/summer.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/autumn.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/winter.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/cloudy.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/rain.webp':
    'data:image/webp;base64,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',
  'assets/backgrounds/night.webp':
    'data:image/webp;base64,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',
};
const backgroundLayers = [element('sceneBackgroundA', 'div'), element('sceneBackgroundB', 'div')];
const backgroundPhotos = [element('sceneImageA', 'div'), element('sceneImageB', 'div')];
const backgroundGrain = element('backgroundGrain', 'div');
const BACKGROUND_FADE_MS = 1200;
const backgroundAssetCache = new Map<string, BackgroundAsset>();
let backgroundKey = 'clock';
let backgroundLayerIndex = 0;
let backgroundTransition: BackgroundTransition | null = null;

function prepareBackgroundAsset(asset: string | null) {
  if (!asset) return null;
  if (backgroundAssetCache.has(asset)) return backgroundAssetCache.get(asset);
  const record: BackgroundAsset = { status: 'loading', image: null, promise: null };
  backgroundAssetCache.set(asset, record);
  record.promise = new Promise((resolve) => {
    const finish = (ready: boolean) => {
      if (record.status !== 'loading') return;
      record.status = ready ? 'ready' : 'error';
      resolve(ready);
    };
    if (typeof Image === 'undefined') {
      finish(false);
      return;
    }
    const image = (record.image = new Image());
    let decoding = false;
    image.decoding = 'async';
    image.onload = () => {
      if (decoding || record.status !== 'loading') return;
      decoding = true;
      if (typeof image.decode === 'function')
        image.decode().then(
          () => finish(true),
          () => finish(false),
        );
      else finish(true);
    };
    image.onerror = () => finish(false);
    image.src = BACKGROUND_IMAGES[asset] || asset;
    if (image.complete && image.naturalWidth > 0) image.onload(new Event('load'));
  });
  return record;
}

function advanceBackgroundTransition(now: number) {
  const transition = backgroundTransition;
  if (!transition) return;
  const raw = reducedMotion.matches
    ? 1
    : Math.min(1, Math.max(0, (now - transition.start) / BACKGROUND_FADE_MS));
  const progress = smoothProgress(raw);
  const previous = backgroundLayers[transition.from];
  if (transition.to === null) {
    previous.style.opacity = String(1 - progress);
  } else {
    previous.style.opacity = transition.fromClock ? '0' : '1';
    backgroundLayers[transition.to].style.opacity = String(progress);
  }
  backgroundGrain.style.opacity = String(
    transition.grainFrom + (transition.grainTo - transition.grainFrom) * progress,
  );
  if (raw === 1) {
    previous.style.opacity = '0';
    backgroundTransition = null;
  }
}

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
  if (sceneName === 'clock' || sceneName === 'music')
    return { key: 'clock', asset: null, gradient: '', brightness: 1 };
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
  advanceBackgroundTransition(now);
  const spec = getBackgroundSpec(sceneName);
  const asset = prepareBackgroundAsset(spec.asset);

  const names = getSceneNames();
  const nextScene = names[(names.indexOf(sceneName) + 1) % names.length];
  prepareBackgroundAsset(getBackgroundSpec(nextScene).asset);

  if (
    backgroundTransition ||
    spec.pending ||
    backgroundKey === spec.key ||
    (asset && asset.status !== 'ready')
  )
    return;
  const fromClock = backgroundKey === 'clock';
  const previous = backgroundLayerIndex;
  backgroundGrain.style.backgroundImage = element('grainLayer', 'div').style.backgroundImage || '';
  const transition: BackgroundTransition = {
    from: previous,
    to: null,
    fromClock,
    start: now,
    grainFrom: Number(backgroundGrain.style.opacity) || 0,
    grainTo: spec.key === 'clock' ? 0 : spec.asset ? 0.62 : 0.32,
  };
  backgroundKey = spec.key;
  if (spec.key === 'clock') {
    backgroundTransition = transition;
    advanceBackgroundTransition(now);
    return;
  }
  backgroundLayerIndex = 1 - backgroundLayerIndex;
  const layer = backgroundLayers[backgroundLayerIndex];
  layer.style.opacity = '0';
  layer.style.zIndex = '1';
  backgroundLayers[previous].style.zIndex = '0';
  layer.style.backgroundImage = spec.gradient;
  layer.style.setProperty('--veil-opacity', spec.asset ? '1' : '.32');
  layer.style.setProperty('--photo-brightness', String(spec.brightness));
  backgroundPhotos[backgroundLayerIndex].style.backgroundImage = spec.asset
    ? `url("${BACKGROUND_IMAGES[spec.asset] || spec.asset}")`
    : 'none';
  transition.to = backgroundLayerIndex;
  backgroundTransition = transition;
  advanceBackgroundTransition(now);
}

function applySceneState(scene: ReturnType<typeof getSceneState>, now = performance.now()) {
  applySceneBackground(scene.name, now);
  clockCanvas.style.opacity = String(scene.clockOpacity);
  speckleCanvas.style.opacity = String(scene.clockOpacity);
  weatherCanvas.style.opacity = String(scene.weatherOpacity);
  weatherRetry.style.opacity = String(scene.weatherOpacity);
  weatherAttribution.style.opacity = String(scene.weatherOpacity);
  musicScene.style.opacity = String(scene.name === 'music' ? scene.opacity : 0);
  musicScene.setAttribute('aria-hidden', String(scene.name !== 'music'));
  const infoActive = scene.name !== 'clock' && scene.name !== 'music' && scene.opacity > 0.5;
  weatherRetry.style.pointerEvents = infoActive ? 'auto' : 'none';
  weatherAttribution.style.pointerEvents = infoActive ? 'auto' : 'none';
  weatherRetry.tabIndex = infoActive && !weatherRetry.hidden ? 0 : -1;
  weatherAttribution.tabIndex = infoActive && !weatherAttribution.hidden ? 0 : -1;
  weatherRetry.setAttribute('aria-hidden', String(!infoActive));
  weatherAttribution.setAttribute('aria-hidden', String(!infoActive));
  clockCanvas.setAttribute('aria-hidden', String(scene.name !== 'clock'));
  weatherCanvas.setAttribute(
    'aria-hidden',
    String(scene.name === 'clock' || scene.name === 'music'),
  );
  if (activeSceneName !== scene.name) {
    if (scene.name === 'clock' || scene.name === 'music') {
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
    } else if (scene.name === 'music') {
      renderMusicFrame(scene.phase);
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
  resizeSpeckleCanvas();
  lastViewportW = 0;
});

async function initializeScreensaver() {
  const generation = lifecycleGeneration;
  initializeDisplayControls();
  initializeWeather();
  createFilmGrainTile();
  resizeSpeckleCanvas();

  if (document.fonts && document.fonts.load) {
    try {
      const fonts = Promise.all([
        document.fonts.load('700 100px "Google Sans"', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
        document.fonts.load(
          '500 100px "Google Sans"',
          'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789°',
        ),
      ]).then(([faces]) => {
        if (!faces.length)
          console.warn('Google Sans is unavailable; the clock will use a fallback font.');
        if (!disposed) invalidateFontLayouts();
      });
      await Promise.race([
        fonts,
        new Promise<void>((resolve) => {
          fontWarmupTimer = setTimeout(resolve, 3000);
        }),
      ]);
    } catch (error) {
      console.warn('Google Sans could not load; the clock will use a fallback font.', error);
    }
    if (fontWarmupTimer !== null) {
      clearTimeout(fontWarmupTimer);
      fontWarmupTimer = null;
    }
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
  musicRenderKey = '';
}

document.fonts?.addEventListener('loadingdone', () => {
  if (!disposed) invalidateFontLayouts();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) settleMusicTransition();
  else showControls();
});

document.addEventListener('DOMContentLoaded', () => {
  initializeScreensaver().catch((error) =>
    console.error('The screen saver could not start.', error),
  );
});
