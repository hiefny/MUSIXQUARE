import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
  appName: 'musixquare',
  brand: {
    displayName: '뮤직스퀘어',
    primaryColor: '#4281F1',
    icon: 'https://static.toss.im/appsintoss/21069/cad8ac0c-7202-4d24-8ef2-9fbe4a004579.png',
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
