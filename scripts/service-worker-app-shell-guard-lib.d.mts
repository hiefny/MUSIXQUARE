export function parseServiceWorkerAppShell(serviceWorker: string): {
  entries: string[];
  buildEntries: string[];
};
export function collectActiveStartupAssets(indexHtml: string): string[];
export function collectRenderedWorkerAssets(javascript: string): string[];
