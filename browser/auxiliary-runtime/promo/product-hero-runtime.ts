import * as THREE from 'https://esm.sh/three@0.162.0';
import { OrbitControls } from 'https://esm.sh/three@0.162.0/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'https://esm.sh/three@0.162.0/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry as _RoundedBoxGeometry } from 'https://esm.sh/three@0.162.0/examples/jsm/geometries/RoundedBoxGeometry.js';
import GUI from 'https://esm.sh/lil-gui@0.19.2';

export interface ProductHeroPanel {
  file: string;
  pos: [number, number, number];
  rotY: number;
  rotX: number;
  rotZ: number;
  scale: number;
}

export interface ProductHeroConfig {
  readonly assetPath: string;
  readonly panels: ProductHeroPanel[];
}

interface ShadowData {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly W: number;
  readonly H: number;
}

type MaterialNumericProperty =
  | 'opacity'
  | 'emissiveIntensity'
  | 'roughness'
  | 'clearcoat'
  | 'clearcoatRoughness'
  | 'envMapIntensity'
  | 'metalness';

export function startProductHero(config: ProductHeroConfig): void {
  const PANELS = config.panels;
  const ASSET_PATH = config.assetPath;
  function requireSceneCanvas(): HTMLCanvasElement {
    const element = document.getElementById('scene');
    if (!(element instanceof HTMLCanvasElement)) throw new Error('Missing #scene canvas.');
    return element;
  }

  const canvas = requireSceneCanvas();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.max(window.devicePixelRatio, 3)); // supersample for capture
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0); // transparent — body gradient shows through
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(10, window.innerWidth / window.innerHeight, 0.1, 1000);
  const DEFAULT_CAM = new THREE.Vector3(0, 0.5, 90);
  camera.position.copy(DEFAULT_CAM);

  const pmrem = new THREE.PMREMGenerator(renderer);

  function makeStudioScene(): THREE.Scene {
    // High-contrast "softbox" setup — bright top panel, warm side, dark ground
    const s = new THREE.Scene();
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(12, 0.1, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    top.position.y = 5;
    s.add(top);
    const warm = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0 }),
    );
    warm.position.set(-6, 1, 0);
    s.add(warm);
    const cool = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 5, 5),
      new THREE.MeshBasicMaterial({ color: 0xd0e8ff }),
    );
    cool.position.set(6, 1, 0);
    s.add(cool);
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(20, 0.1, 20),
      new THREE.MeshBasicMaterial({ color: 0x1a1a1a }),
    );
    ground.position.y = -4;
    s.add(ground);
    return s;
  }

  const envTextures = {
    Room: pmrem.fromScene(new RoomEnvironment(), 0.04).texture,
    Studio: pmrem.fromScene(makeStudioScene(), 0.02).texture,
    None: null,
  };
  scene.environment = envTextures.Studio;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(4, 8, 6);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xccddff, 0.35);
  fillLight.position.set(-6, 2, 4);
  scene.add(fillLight);

  // ─── Panel layout ────────────────────────────────────
  // Left cluster: 3 setup cards stacked & overlapping like a deck fanned slightly
  // Right cluster: main player + audio settings floating

  const loader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const BASE_WIDTH = 6;

  function loadTexture(file: string): Promise<THREE.Texture> {
    return new Promise<THREE.Texture>((resolve, reject) => {
      loader.load(
        ASSET_PATH + file,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = maxAniso;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  const screenMaterials: THREE.MeshPhysicalMaterial[] = [];
  const bodyMaterials: THREE.MeshPhysicalMaterial[] = [];
  const shadowData: ShadowData[] = []; // for GUI batch update
  const shadowState = {
    opacity: 0.1,
    scaleX: 1.2,
    scaleY: 0.34,
    offsetY: 0.42, // distance below panel, as fraction of H
  };
  const CORNER_R = 0.12; // panel corner radius

  function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
    const s = new THREE.Shape();
    const hw = w / 2,
      hh = h / 2;
    s.moveTo(-hw + r, -hh);
    s.lineTo(hw - r, -hh);
    s.quadraticCurveTo(hw, -hh, hw, -hh + r);
    s.lineTo(hw, hh - r);
    s.quadraticCurveTo(hw, hh, hw - r, hh);
    s.lineTo(-hw + r, hh);
    s.quadraticCurveTo(-hw, hh, -hw, hh - r);
    s.lineTo(-hw, -hh + r);
    s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    return s;
  }

  function buildPanel(tex: THREE.Texture, cfg: ProductHeroPanel): THREE.Group {
    const image: unknown = tex.image;
    if (!(image instanceof HTMLImageElement) || image.height === 0) {
      throw new Error(`Texture image is unavailable: ${cfg.file}`);
    }
    const aspect = image.width / image.height;
    const W = BASE_WIDTH * cfg.scale;
    const H = W / aspect;
    const DEPTH = 0.055;

    const group = new THREE.Group();
    group.position.set(...cfg.pos);
    group.rotation.set(cfg.rotX, cfg.rotY, cfg.rotZ || 0);

    // Screenshot front — diffuse texture + subtle emissive + clearcoat gloss
    // Keeps UI contrast; gets highlights from env via clearcoat
    const screenMat = new THREE.MeshPhysicalMaterial({
      map: tex,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.75,
      metalness: 0.32,
      roughness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 1.0,
      envMapIntensity: 0.0,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    screenMaterials.push(screenMat);

    // Panel body sides/back — pure white glossy plastic with emissive baseline
    // Emissive keeps shaded areas from going gray while still allowing bevel reflections
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.25,
      metalness: 0.0,
      roughness: 0.35,
      clearcoat: 0.6,
      clearcoatRoughness: 0.15,
      envMapIntensity: 0.9,
      transparent: true,
      opacity: 0.9,
    });
    bodyMaterials.push(bodyMat);

    // Body: flat extruded rounded rect (no bevel — clean card look)
    const rectShape = roundedRectShape(W, H, CORNER_R);
    const bodyGeom = new THREE.ExtrudeGeometry(rectShape, {
      depth: DEPTH,
      bevelEnabled: false,
      curveSegments: 16,
    });
    bodyGeom.translate(0, 0, -DEPTH / 2);
    const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
    group.add(bodyMesh);

    // Screen: flat rounded rect plane matching body shape
    const screenGeom = new THREE.ShapeGeometry(rectShape);
    const uv = screenGeom.getAttribute('uv');
    for (let index = 0; index < uv.count; index += 1) {
      uv.setXY(index, (uv.getX(index) + W / 2) / W, (uv.getY(index) + H / 2) / H);
    }
    uv.needsUpdate = true;
    const screenMesh = new THREE.Mesh(screenGeom, screenMat);
    screenMesh.position.z = DEPTH / 2 + 0.002;
    group.add(screenMesh);

    // Soft contact shadow below (unit-sized geometry + scale so GUI can resize)
    const shadowTex = makeShadowTexture();
    const shadowGeom = new THREE.PlaneGeometry(1, 1);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: shadowState.opacity,
      depthWrite: false,
      toneMapped: false,
    });
    const shadow = new THREE.Mesh(shadowGeom, shadowMat);
    shadow.scale.set(W * shadowState.scaleX, H * shadowState.scaleY, 1);
    shadow.position.set(0, -H * shadowState.offsetY, -DEPTH * 0.5);
    shadow.rotation.x = (-Math.PI / 2) * 0.12;
    group.add(shadow);
    shadowData.push({ mesh: shadow, material: shadowMat, W, H });

    return group;
  }

  // Canvas-based radial gradient for soft contact shadow
  function makeShadowTexture(): THREE.CanvasTexture {
    const size = 256;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Unable to create the shadow canvas context.');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.9)');
    g.addColorStop(0.4, 'rgba(0,0,0,0.4)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const panelsGroup = new THREE.Group();
  scene.add(panelsGroup);

  Promise.all(PANELS.map((p) => loadTexture(p.file).then((tex) => ({ tex, cfg: p }))))
    .then((loaded) => {
      loaded.forEach(({ tex, cfg }) => {
        panelsGroup.add(buildPanel(tex, cfg));
      });
      document.getElementById('loading')?.classList.add('hidden');
    })
    .catch((err) => {
      console.error('Texture load failed:', err);
      const loading = document.getElementById('loading');
      if (loading) loading.textContent = 'Failed to load screenshots';
    });

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.35;
  controls.minDistance = 10;
  controls.maxDistance = 50;

  // ─── Click-to-edit: select panel → lil-gui sliders ──
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let selectedIndex = -1;
  let editMode = false; // true when a panel is selected — pauses float

  const gui = new GUI({ title: 'Controls' });

  // ─── Scene-level controls (always visible) ───────────
  const sceneState = {
    fov: camera.fov,
    camZ: camera.position.z,
  };
  const sceneFolder = gui.addFolder('Camera');
  sceneFolder
    .add(sceneState, 'fov', 8, 70, 0.5)
    .name('fov (lower = telephoto)')
    .onChange((v: number) => {
      camera.fov = v;
      camera.updateProjectionMatrix();
    });
  sceneFolder
    .add(sceneState, 'camZ', 5, 90, 0.5)
    .name('distance')
    .onChange((v: number) => {
      const dir = new THREE.Vector3(0, 0, 1); // along +Z relative to target
      const target = controls.target.clone();
      camera.position.copy(target).add(dir.multiplyScalar(v));
      controls.update();
    });
  sceneFolder.open();

  // ─── Background gradient controls ────────────────────
  const bgState = { top: '#ededed', bottom: '#dedede', radial: true };
  function applyBg(): void {
    const type = bgState.radial ? 'radial-gradient(ellipse at center' : 'linear-gradient(180deg';
    document.body.style.background = `${type}, ${bgState.top} 0%, ${bgState.bottom} 100%)`;
  }
  const bgFolder = gui.addFolder('Background');
  bgFolder.addColor(bgState, 'top').name('top / inner').onChange(applyBg);
  bgFolder.addColor(bgState, 'bottom').name('bottom / outer').onChange(applyBg);
  bgFolder.add(bgState, 'radial').name('radial (else linear)').onChange(applyBg);
  bgFolder.add(
    {
      'Copy bg': () => {
        const css = `background: ${bgState.radial ? 'radial-gradient(ellipse at center' : 'linear-gradient(180deg'}, ${bgState.top} 0%, ${bgState.bottom} 100%);`;
        navigator.clipboard.writeText(css).catch((error: unknown) => {
          console.error('[copy failed]', error);
        });
        console.log('[copied]', css);
      },
    },
    'Copy bg',
  );
  bgFolder.close();

  // ─── Material controls (apply to all screen faces) ───
  const matState = {
    opacity: 0.9,
    emissiveIntensity: 0.75,
    roughness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 1.0,
    envMapIntensity: 0.0,
    metalness: 0.32,
  };
  const matFolder = gui.addFolder('Material (all panels)');
  function setMaterialNumber(
    material: THREE.MeshPhysicalMaterial,
    property: MaterialNumericProperty,
    value: number,
  ): void {
    switch (property) {
      case 'opacity':
        material.opacity = value;
        break;
      case 'emissiveIntensity':
        material.emissiveIntensity = value;
        break;
      case 'roughness':
        material.roughness = value;
        break;
      case 'clearcoat':
        material.clearcoat = value;
        break;
      case 'clearcoatRoughness':
        material.clearcoatRoughness = value;
        break;
      case 'envMapIntensity':
        material.envMapIntensity = value;
        break;
      case 'metalness':
        material.metalness = value;
        break;
    }
    material.needsUpdate = true;
  }

  function applyMat(prop: MaterialNumericProperty, value: number): void {
    screenMaterials.forEach((material) => setMaterialNumber(material, prop, value));
    // Body mirrors opacity so the whole panel translucency stays consistent
    if (prop === 'opacity') {
      bodyMaterials.forEach((material) => setMaterialNumber(material, prop, value));
    }
  }
  matFolder.add(matState, 'opacity', 0, 1, 0.01).onChange((v: number) => applyMat('opacity', v));
  matFolder
    .add(matState, 'emissiveIntensity', 0, 2, 0.01)
    .onChange((v: number) => applyMat('emissiveIntensity', v));
  matFolder
    .add(matState, 'roughness', 0, 1, 0.01)
    .onChange((v: number) => applyMat('roughness', v));
  matFolder
    .add(matState, 'clearcoat', 0, 1, 0.01)
    .onChange((v: number) => applyMat('clearcoat', v));
  matFolder
    .add(matState, 'clearcoatRoughness', 0, 1, 0.01)
    .onChange((v: number) => applyMat('clearcoatRoughness', v));
  matFolder
    .add(matState, 'envMapIntensity', 0, 3, 0.05)
    .onChange((v: number) => applyMat('envMapIntensity', v));
  matFolder
    .add(matState, 'metalness', 0, 1, 0.01)
    .onChange((v: number) => applyMat('metalness', v));
  matFolder.add(
    {
      'Copy material': () => {
        const lines = Object.entries(matState)
          .map(([k, v]) => `    ${k}: ${v.toFixed(3)},`)
          .join('\n');
        navigator.clipboard.writeText(lines).catch((error: unknown) => {
          console.error('[copy failed]', error);
        });
        console.log('[copied]\n' + lines);
      },
    },
    'Copy material',
  );
  matFolder.close();

  // ─── Shadow controls ────────────────────────────────
  const shadowFolder = gui.addFolder('Shadow');
  shadowFolder.add(shadowState, 'opacity', 0, 1, 0.01).onChange((v: number) => {
    shadowData.forEach((s) => {
      s.material.opacity = v;
      s.material.needsUpdate = true;
    });
  });
  shadowFolder
    .add(shadowState, 'scaleX', 0.3, 4, 0.05)
    .name('width')
    .onChange((v: number) => {
      shadowData.forEach((s) => (s.mesh.scale.x = s.W * v));
    });
  shadowFolder
    .add(shadowState, 'scaleY', 0.1, 2, 0.02)
    .name('height')
    .onChange((v: number) => {
      shadowData.forEach((s) => (s.mesh.scale.y = s.H * v));
    });
  shadowFolder
    .add(shadowState, 'offsetY', 0.0, 1.5, 0.02)
    .name('offset down')
    .onChange((v: number) => {
      shadowData.forEach((s) => (s.mesh.position.y = -s.H * v));
    });
  shadowFolder.add(
    {
      'Copy shadow': () => {
        const lines = Object.entries(shadowState)
          .map(([k, v]) => `    ${k}: ${v.toFixed(3)},`)
          .join('\n');
        navigator.clipboard.writeText(lines).catch((error: unknown) => {
          console.error('[copy failed]', error);
        });
        console.log('[copied]\n' + lines);
      },
    },
    'Copy shadow',
  );
  shadowFolder.close();

  // ─── Lighting & Environment controls ─────────────────
  const lightState = {
    env: 'Studio',
    ambient: 0.6,
    key: 0.8,
    fill: 0.35,
    keyX: 4,
    keyY: 8,
    keyZ: 6,
  };
  const lightFolder = gui.addFolder('Lighting');
  lightFolder.add(lightState, 'env', ['Room', 'Studio', 'None']).onChange((v: string) => {
    if (v === 'Room' || v === 'Studio' || v === 'None') scene.environment = envTextures[v];
  });
  lightFolder.add(lightState, 'ambient', 0, 2, 0.02).onChange((v: number) => {
    ambientLight.intensity = v;
  });
  lightFolder.add(lightState, 'key', 0, 2, 0.02).onChange((v: number) => {
    keyLight.intensity = v;
  });
  lightFolder.add(lightState, 'fill', 0, 2, 0.02).onChange((v: number) => {
    fillLight.intensity = v;
  });
  lightFolder
    .add(lightState, 'keyX', -15, 15, 0.2)
    .name('key x')
    .onChange((v: number) => {
      keyLight.position.x = v;
    });
  lightFolder
    .add(lightState, 'keyY', -15, 15, 0.2)
    .name('key y')
    .onChange((v: number) => {
      keyLight.position.y = v;
    });
  lightFolder
    .add(lightState, 'keyZ', -15, 15, 0.2)
    .name('key z')
    .onChange((v: number) => {
      keyLight.position.z = v;
    });
  lightFolder.add(
    {
      'Copy lighting': () => {
        const lines = Object.entries(lightState)
          .map(([k, v]) => `    ${k}: ${typeof v === 'number' ? v.toFixed(2) : JSON.stringify(v)},`)
          .join('\n');
        navigator.clipboard.writeText(lines).catch((error: unknown) => {
          console.error('[copy failed]', error);
        });
        console.log('[copied]\n' + lines);
      },
    },
    'Copy lighting',
  );
  lightFolder.close();

  // ─── Export (high-res PNG capture) ───────────────────
  async function captureAt(w: number, h: number): Promise<string> {
    const origRatio = renderer.getPixelRatio();
    const origSize = new THREE.Vector2();
    renderer.getSize(origSize);
    const origAspect = camera.aspect;

    try {
      // Resize renderer + camera for capture (don't touch canvas style)
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);

      // Composite: bg gradient onto 2D canvas, then draw WebGL result on top
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('Unable to create the export canvas context.');
      if (bgState.radial) {
        const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
        g.addColorStop(0, bgState.top);
        g.addColorStop(1, bgState.bottom);
        ctx.fillStyle = g;
      } else {
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, bgState.top);
        g.addColorStop(1, bgState.bottom);
        ctx.fillStyle = g;
      }
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(canvas, 0, 0);

      return out.toDataURL('image/png');
    } finally {
      renderer.setPixelRatio(origRatio);
      renderer.setSize(origSize.x, origSize.y, false);
      camera.aspect = origAspect;
      camera.updateProjectionMatrix();
      window.dispatchEvent(new Event('resize'));
    }
  }

  function downloadPng(dataUrl: string, name: string): void {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name;
    a.click();
  }

  const exportFolder = gui.addFolder('Export');
  exportFolder.add(
    {
      '4K (3840×2160)': async () => {
        const url = await captureAt(3840, 2160);
        downloadPng(url, `musixquare-hero-4k-${Date.now()}.png`);
      },
    },
    '4K (3840×2160)',
  );
  exportFolder.add(
    {
      '8K (7680×4320)': async () => {
        const url = await captureAt(7680, 4320);
        downloadPng(url, `musixquare-hero-8k-${Date.now()}.png`);
      },
    },
    '8K (7680×4320)',
  );
  exportFolder.add(
    {
      'FHD (1920×1080)': async () => {
        const url = await captureAt(1920, 1080);
        downloadPng(url, `musixquare-hero-fhd-${Date.now()}.png`);
      },
    },
    'FHD (1920×1080)',
  );
  exportFolder.close();

  // ─── Panel-specific controls (populated on click) ───
  let panelFolder = gui.addFolder('Panel');
  panelFolder.hide();
  const guiState = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

  function rebuildGUI(): void {
    panelFolder.destroy();
    panelFolder = gui.addFolder('Panel');

    if (selectedIndex < 0) {
      panelFolder.hide();
      return;
    }
    const group = panelsGroup.children[selectedIndex];
    const cfg = PANELS[selectedIndex];
    panelFolder.title(`#${selectedIndex + 1} ${cfg.file}`);

    guiState.x = group.position.x;
    guiState.y = group.position.y;
    guiState.z = group.position.z;
    guiState.rotX = group.rotation.x;
    guiState.rotY = group.rotation.y;
    guiState.rotZ = group.rotation.z;

    panelFolder.add(guiState, 'x', -12, 12, 0.05).onChange((v: number) => {
      group.position.x = v;
      PANELS[selectedIndex].pos[0] = v;
    });
    panelFolder.add(guiState, 'y', -8, 8, 0.05).onChange((v: number) => {
      group.position.y = v;
      PANELS[selectedIndex].pos[1] = v;
    });
    panelFolder.add(guiState, 'z', -6, 6, 0.05).onChange((v: number) => {
      group.position.z = v;
      PANELS[selectedIndex].pos[2] = v;
    });
    panelFolder.add(guiState, 'rotX', -Math.PI / 2, Math.PI / 2, 0.01).onChange((v: number) => {
      group.rotation.x = v;
      PANELS[selectedIndex].rotX = v;
    });
    panelFolder.add(guiState, 'rotY', -Math.PI, Math.PI, 0.01).onChange((v: number) => {
      group.rotation.y = v;
      PANELS[selectedIndex].rotY = v;
    });
    panelFolder.add(guiState, 'rotZ', -Math.PI / 2, Math.PI / 2, 0.01).onChange((v: number) => {
      group.rotation.z = v;
      PANELS[selectedIndex].rotZ = v;
    });
    panelFolder.add(
      {
        'Copy as code': () => {
          const c = PANELS[selectedIndex];
          const g = panelsGroup.children[selectedIndex];
          const line = `  { file: '${c.file}', pos: [${g.position.x.toFixed(2).padStart(5)}, ${g.position.y.toFixed(2).padStart(5)}, ${g.position.z.toFixed(2).padStart(5)}], rotY: ${g.rotation.y.toFixed(3).padStart(6)}, rotX: ${g.rotation.x.toFixed(3).padStart(6)}, rotZ: ${g.rotation.z.toFixed(3).padStart(6)}, scale: ${c.scale} },`;
          navigator.clipboard.writeText(line).catch((error: unknown) => {
            console.error('[copy failed]', error);
          });
          console.log('[copied]', line);
        },
      },
      'Copy as code',
    );
    panelFolder.add(
      {
        'Deselect (resume float)': () => {
          selectedIndex = -1;
          editMode = false;
          rebuildGUI();
        },
      },
      'Deselect (resume float)',
    );
    panelFolder.open();
  }

  function pickFromEvent(e: PointerEvent): number {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(panelsGroup.children, true);
    if (hits.length === 0) return -1;
    let g = hits[0].object;
    while (g.parent && g.parent !== panelsGroup) g = g.parent;
    return panelsGroup.children.indexOf(g);
  }

  // Distinguish click from drag — only pick if the mouse hasn't moved much
  let downPos: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    downPos = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downPos) return;
    const dx = e.clientX - downPos.x,
      dy = e.clientY - downPos.y;
    downPos = null;
    if (Math.hypot(dx, dy) > 4) return;
    const idx = pickFromEvent(e);
    if (idx >= 0) {
      selectedIndex = idx;
      editMode = true;
      rebuildGUI();
    }
  });

  // ─── Subtle float animation (paused while editing or on Space) ───
  const clock = new THREE.Clock();
  let paused = true; // start paused — Space to start motion

  function animate(): void {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    if (!editMode && !paused) {
      panelsGroup.children.forEach((g, i) => {
        const phase = i * 1.3;
        g.position.y = PANELS[i].pos[1] + Math.sin(t * 0.5 + phase) * 0.08;
        // keep rotation.z as baseline so GUI doesn't jitter when re-selected
      });
    }

    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  let uiHidden = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      paused = !paused;
      controls.autoRotate = !paused;
    } else if (e.code === 'KeyR') {
      camera.position.copy(DEFAULT_CAM);
      controls.target.set(0, 0, 0);
      controls.update();
    } else if (e.code === 'KeyH') {
      uiHidden = !uiHidden;
      document.querySelector('.overlay')?.classList.toggle('hidden', uiHidden);
      document.querySelector('.brand')?.classList.toggle('hidden', uiHidden);
      if (uiHidden) gui.hide();
      else gui.show();
    }
  });

  window.addEventListener('resize', () => {
    const w = window.innerWidth,
      h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
}
