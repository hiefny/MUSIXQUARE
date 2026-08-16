import { startProductHero } from './product-hero-runtime';

startProductHero({
  assetPath: '../assets/screenshots-tablet/',
  panels: [
    { file: '01.png', pos: [-4.5, 1.44, -0.15], rotY: 0.09, rotX: 0.2, rotZ: -0.1, scale: 0.72 },
    { file: '02.png', pos: [-3.5, -0.18, 0.35], rotY: 0.13, rotX: 0.0, rotZ: 0.1, scale: 0.72 },
    { file: '03.png', pos: [-2.2, -1.55, 1.0], rotY: 0.27, rotX: -0.21, rotZ: 0.3, scale: 0.72 },
    { file: '04.png', pos: [2.2, 1.06, 3.5], rotY: -0.08, rotX: -0.13, rotZ: -0.08, scale: 1.0 },
    { file: '05.png', pos: [4.2, -1.27, 1.85], rotY: -0.17, rotX: -0.39, rotZ: -0.04, scale: 0.72 },
  ],
});
