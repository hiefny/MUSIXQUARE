import { execFileSync } from 'node:child_process';

export function compileClassicRuntimeForBrowserTest(outputPath: string): string {
  const runner = `
    import {
      CLASSIC_RUNTIME_ASSETS,
      compileClassicRuntimeAsset,
    } from './scripts/classic-runtime-assets.ts';

    const outputPath = process.argv[1];
    const asset = CLASSIC_RUNTIME_ASSETS.find((candidate) => candidate.outputPath === outputPath);
    if (!asset) throw new Error(\`Classic-runtime asset is missing: \${outputPath}\`);
    const compiled = await compileClassicRuntimeAsset(process.cwd(), asset);
    process.stdout.write(compiled.code);
  `;

  return execFileSync(process.execPath, ['--import', 'tsx', '--eval', runner, outputPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}
