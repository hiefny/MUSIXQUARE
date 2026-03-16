import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'musixquare',
  brand: {
    displayName: '뮤직스퀘어',
    primaryColor: '#4281F1',
    icon: 'https://static.toss.im/appsintoss/21069/f90941fa-567d-4d3a-a708-0c19adeac0d7.png',
  },
  web: {
    host: 'localhost',
    port: 3000,
    commands: {
      dev: 'vite',
      build: 'vite build',
    },
  },
  outdir: 'dist',
  permissions: [],
});
