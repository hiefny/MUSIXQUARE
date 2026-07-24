export type WranglerD1Execution = {
  success: true;
  results: unknown[];
  [key: string]: unknown;
};

export function parseWranglerD1JsonOutput(source: string): WranglerD1Execution[];
