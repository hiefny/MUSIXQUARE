import * as THREE from 'https://esm.sh/three@0.162.0';
import { OrbitControls } from 'https://esm.sh/three@0.162.0/examples/jsm/controls/OrbitControls.js';
import { SVGLoader } from 'https://esm.sh/three@0.162.0/examples/jsm/loaders/SVGLoader.js';
import { RoomEnvironment } from 'https://esm.sh/three@0.162.0/examples/jsm/environments/RoomEnvironment.js';

const GLASS_TINT = 0x7dadfa; // midpoint between #3b82f6 (deep) and #bfdbfe (pale)
const BG_LIGHT = 0xe4e4e7; // zinc-200 — enough contrast with the blue glass
const BG_DARK = 0x0a0a0a;

const canvas = document.getElementById('scene');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing #scene canvas.');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(BG_DARK, 1);
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const sceneBackground = new THREE.Color(BG_DARK);
scene.background = sceneBackground;

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 1000);
const DEFAULT_CAM = new THREE.Vector3(6, 4, 75);
camera.position.copy(DEFAULT_CAM);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// Environment and direct light give the glass visible reflections and refraction.
scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
keyLight.position.set(6, 10, 8);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0xaabbff, 0.5);
rimLight.position.set(-8, 4, -6);
scene.add(rimLight);

// ─── Geometry: SVG note → extruded mesh ──────────────
const NOTE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12,3v9.28c-.47-.17-.97-.28-1.5-.28-2.49,0-4.5,2.01-4.5,4.5s2.01,4.5,4.5,4.5c2.31,0,4.21-1.75,4.5-4h0V6h4v-3h-7Z"/>
</svg>`;

const svgData = new SVGLoader().parse(NOTE_SVG);
const noteGroup = new THREE.Group();

const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: GLASS_TINT,
  metalness: 0,
  roughness: 0.08,
  transmission: 0.82,
  thickness: 1.0,
  ior: 1.45,
  attenuationColor: new THREE.Color(GLASS_TINT),
  attenuationDistance: 6,
  clearcoat: 1.0,
  clearcoatRoughness: 0.05,
  envMapIntensity: 1.1,
  emissive: new THREE.Color(GLASS_TINT),
  emissiveIntensity: 0,
  transparent: true,
});

svgData.paths.forEach((path) => {
  SVGLoader.createShapes(path).forEach((shape) => {
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: 1.6,
      bevelEnabled: true,
      bevelThickness: 0.75,
      bevelSize: 0.75,
      bevelSegments: 10,
      curveSegments: 64,
    });
    geom.center();

    const mesh = new THREE.Mesh(geom, glassMaterial);
    noteGroup.add(mesh);
  });
});
// SVG Y goes down, Three.js Y goes up — rotate 180° on X to flip
// (using rotation instead of negative scale to preserve triangle winding)
noteGroup.rotation.x = Math.PI;
scene.add(noteGroup);

// ─── Debug grid — sits behind the note, helps confirm transmission ───
const grid = new THREE.GridHelper(100, 20, 0x888888, 0xaaaaaa);
grid.rotation.x = Math.PI / 2; // rotate from XZ (floor) to XY (wall)
grid.position.z = -15;
scene.add(grid);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;
controls.minDistance = 25;
controls.maxDistance = 120;

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

let darkMode = true;
document.body.classList.add('dark');
document.body.style.background = '#0a0a0a';

function setBackground(dark: boolean): void {
  darkMode = dark;
  const hex = dark ? BG_DARK : BG_LIGHT;
  sceneBackground.setHex(hex);
  renderer.setClearColor(hex, 1);
  document.body.style.background = '#' + hex.toString(16).padStart(6, '0');
  document.body.classList.toggle('dark', dark);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    controls.autoRotate = !controls.autoRotate;
  } else if (e.code === 'KeyR') {
    camera.position.copy(DEFAULT_CAM);
    controls.target.set(0, 0, 0);
    controls.update();
  } else if (e.code === 'KeyB') {
    setBackground(!darkMode);
  } else if (e.code === 'KeyH') {
    document.querySelector('.overlay')?.classList.toggle('hidden');
    document.querySelector('.brand')?.classList.toggle('hidden');
  }
});

window.addEventListener('resize', () => {
  const w = window.innerWidth,
    h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});
