import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDeveloperApiBoundaries,
  readDeveloperApiBoundaryConfig,
} from '../../../scripts/check-developer-api-boundaries.mts';

const publicSource = readFileSync('cloudflare/wrangler.developer-api.toml', 'utf8');
const facadeSource = readFileSync('cloudflare/wrangler.developer-api-facade.toml', 'utf8');

function check(publicText = publicSource, facadeText = facadeSource): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'mxqr-api-boundaries-'));
  try {
    const publicPath = join(fixtureRoot, 'public.toml');
    const facadePath = join(fixtureRoot, 'facade.toml');
    writeFileSync(publicPath, publicText);
    writeFileSync(facadePath, facadeText);
    assertDeveloperApiBoundaries(
      readDeveloperApiBoundaryConfig(publicPath),
      readDeveloperApiBoundaryConfig(facadePath),
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('Developer API Worker boundary configuration', () => {
  it('accepts canonical configs and equivalent TOML whitespace and quoted table keys', () => {
    expect(() => check()).not.toThrow();
    expect(() =>
      check(
        publicSource.replace('[[routes]]', '[[ "routes" ]]'),
        facadeSource.replace('[version_metadata]', '[ version_metadata ]'),
      ),
    ).not.toThrow();
  });

  it.each(['[[ routes ]]', '[["routes"]]', "[['routes']]"])(
    'rejects facade public routing through %s',
    (header) => {
      expect(() =>
        check(publicSource, `${facadeSource}\n${header}\npattern = "audit.example/*"\n`),
      ).toThrow(/forbidden public route/u);
    },
  );

  it('rejects facade inline routing and storage tables', () => {
    expect(() => check(publicSource, `route = "audit.example/*"\n${facadeSource}`)).toThrow(
      /forbidden public route/u,
    );
    expect(() =>
      check(publicSource, `${facadeSource}\n[[ d1_databases ]]\nbinding = "EXTRA"\n`),
    ).toThrow(/storage/u);
    expect(() => check(`${publicSource}\n[[ "r2_buckets" ]]\nbinding = "EXTRA"\n`)).toThrow(
      /R2 or signaling/u,
    );
  });

  it('does not satisfy required root flags with values inside another table', () => {
    const shadowed =
      facadeSource.replace('workers_dev = false', 'workers_dev = true') +
      '\n[fixture]\nworkers_dev = false\n';
    expect(() => check(publicSource, shadowed)).toThrow(/disabled facade workers.dev/u);
    const shadowedPreview =
      publicSource.replace('preview_urls = false', 'preview_urls = true') +
      '\n[fixture]\npreview_urls = false\n';
    expect(() => check(shadowedPreview)).toThrow(/disabled public preview URL/u);
  });

  it('requires related binding fields to identify the same target', () => {
    const splitDatabase =
      publicSource.replace(
        'database_name = "musixquare-developer-api"',
        'database_name = "wrong-database"',
      ) + '\n[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "musixquare-developer-api"\n';
    expect(() => check(splitDatabase)).toThrow(/same database/u);
    const splitFacade =
      publicSource.replace(
        'service = "musixquare-developer-api-facade"',
        'service = "wrong-worker"',
      ) + '\n[[services]]\nbinding = "OTHER"\nservice = "musixquare-developer-api-facade"\n';
    expect(() => check(splitFacade)).toThrow(/private facade service/u);
  });
});
