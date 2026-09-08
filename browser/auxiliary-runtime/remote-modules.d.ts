// These local promo studies retain their original r162 lighting and materials.
// Later Three.js releases change environment intensity and RoomEnvironment
// lighting, so keep their declarations matched to the remote runtime until the
// scenes receive a visual migration. The current promo renderer uses npm Three.js.
declare module 'https://esm.sh/three@0.162.0' {
  export * from 'three-types-0162';
}

declare module 'https://esm.sh/three@0.162.0/examples/jsm/controls/OrbitControls.js' {
  export { OrbitControls } from 'three-types-0162/examples/jsm/controls/OrbitControls.js';
}

declare module 'https://esm.sh/three@0.162.0/examples/jsm/environments/RoomEnvironment.js' {
  export { RoomEnvironment } from 'three-types-0162/examples/jsm/environments/RoomEnvironment.js';
}

declare module 'https://esm.sh/three@0.162.0/examples/jsm/geometries/RoundedBoxGeometry.js' {
  export { RoundedBoxGeometry } from 'three-types-0162/examples/jsm/geometries/RoundedBoxGeometry.js';
}

declare module 'https://esm.sh/three@0.162.0/examples/jsm/loaders/SVGLoader.js' {
  export { SVGLoader } from 'three-types-0162/examples/jsm/loaders/SVGLoader.js';
}

declare module 'https://esm.sh/lil-gui@0.19.2' {
  export { default } from 'lil-gui';
}
