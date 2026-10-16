import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { IMAGE_BACKGROUND_MANIFEST } from '../../../browser/screensaver-backgrounds.ts';

interface BackgroundSpec {
  key: string;
  asset: string | null;
  brightness: number;
  pending?: boolean;
}

async function backgroundSpecFixture() {
  const source = await readFile(
    new URL('../../../browser/auxiliary-runtime/screensaver.ts', import.meta.url),
    'utf8',
  );
  const parsed = ts.createSourceFile('screensaver.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['finite', 'getAirPalette', 'getBackgroundSpec']);
  const functions: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      functions.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  expect(functions).toHaveLength(names.size);
  const compiled = ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const weather = { status: 'ready', weatherCode: 0, isDay: true };
  const coordinates = { latitude: 37.56 };
  const air = { status: 'ready', aqi: 45 as number | null };
  // Run the actual scene-spec functions so asset coverage follows production routing.
  const getSpec = new Function(
    'weatherState',
    'weatherCoordinates',
    'airState',
    `${compiled}\nreturn getBackgroundSpec;`,
  )(weather, coordinates, air) as (scene: string, date?: Date) => BackgroundSpec;
  return { getSpec, weather, coordinates, air };
}

describe('screensaver background asset contract', () => {
  it('ships each immutable image with the content hash and size used by the manifest', async () => {
    const files = new Set<string>();
    const keys = new Set<string>();
    for (const scene of IMAGE_BACKGROUND_MANIFEST.scenes) {
      expect(keys.has(scene.key), scene.key).toBe(false);
      keys.add(scene.key);
      expect(scene.variants.length, scene.key).toBeGreaterThan(0);
      for (const variant of scene.variants) {
        expect(variant.file).toMatch(
          /^\/assets\/screensaver\/backgrounds\/[a-z0-9-]+\/[a-z0-9-]+-[a-f0-9]{8}\.webp$/u,
        );
        expect(files.has(variant.file), variant.file).toBe(false);
        files.add(variant.file);
        const bytes = await readFile(resolve(process.cwd(), 'public', variant.file.slice(1)));
        const hash = createHash('sha256').update(bytes).digest('hex');
        expect(variant.file.endsWith(`-${hash.slice(0, 8)}.webp`), variant.file).toBe(true);
        expect(bytes.length, variant.file).toBe(variant.bytes);
        expect(bytes.toString('ascii', 0, 4), variant.file).toBe('RIFF');
        expect(bytes.toString('ascii', 8, 12), variant.file).toBe('WEBP');
        for (const dimension of [
          variant.width,
          variant.height,
          variant.viewportWidth,
          variant.viewportHeight,
        ]) {
          expect(Number.isFinite(dimension) && dimension > 0, variant.file).toBe(true);
        }
      }
    }
  });

  it('covers every weather code, day/night brightness, season, moon and air-quality bucket', async () => {
    const { getSpec, weather, coordinates, air } = await backgroundSpecFixture();
    const coveredKeys = new Set<string>();
    const verify = (spec: BackgroundSpec): void => {
      expect(spec.pending).not.toBe(true);
      const matching = IMAGE_BACKGROUND_MANIFEST.scenes.filter((scene) =>
        spec.key === 'clock' || spec.key.startsWith('air-')
          ? scene.key === spec.key
          : scene.kind === 'photo' &&
            scene.asset === spec.asset &&
            Math.abs(scene.brightness - spec.brightness) < 0.000001,
      );
      expect(matching, JSON.stringify(spec)).toHaveLength(1);
      coveredKeys.add(matching[0]!.key);
    };
    verify(getSpec('clock'));
    verify(getSpec('moon'));
    for (const latitude of [37.56, -33.87]) {
      coordinates.latitude = latitude;
      for (let month = 0; month < 12; month++) {
        verify(getSpec('date', new Date(2026, month, 16, 12)));
      }
    }
    // Include the whole numeric provider range, including unknown/future-code fallbacks.
    for (let code = 0; code <= 99; code++) {
      weather.weatherCode = code;
      for (const isDay of [true, false]) {
        weather.isDay = isDay;
        verify(getSpec('weather'));
      }
    }
    for (const aqi of [null, -1, 0, 50, 51, 100, 101, 150, 151, 200, 201, 300, 301, 500]) {
      air.aqi = aqi;
      verify(getSpec('air'));
    }
    expect([...coveredKeys].sort()).toEqual(
      IMAGE_BACKGROUND_MANIFEST.scenes.map((scene) => scene.key).sort(),
    );
    weather.status = 'loading';
    expect(getSpec('weather').pending).toBe(true);
  });
});
