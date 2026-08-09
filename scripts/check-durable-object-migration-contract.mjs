import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DURABLE_OBJECT_MIGRATION_MANIFEST_PATH =
  'cloudflare/durable-object-migrations.manifest.json';

const CONTRACT_VERSION = 1;
const MIGRATION_OPERATION_KEYS = Object.freeze([
  'new_classes',
  'new_sqlite_classes',
  'renamed_classes',
  'deleted_classes',
]);
const MIGRATION_KEYS = new Set(['tag', ...MIGRATION_OPERATION_KEYS]);
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertRepositoryPath(root, path, label) {
  if (
    typeof path !== 'string' ||
    !/^cloudflare\/wrangler(?:\..+)?\.toml$/u.test(path) ||
    path.endsWith('.example.toml') ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    throw new Error(`${label} must name one production cloudflare/wrangler*.toml file.`);
  }
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the repository.`);
  }
  readFileSync(absolute);
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '#') return line.slice(0, index);
  }
  return line;
}

function valueNestingDepth(value) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (const character of value) {
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') depth -= 1;
  }
  return depth;
}

function parseBasicString(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must use one TOML basic string.`, { cause: error });
  }
  if (typeof parsed !== 'string' || parsed.length === 0 || parsed.length > 128) {
    throw new Error(`${label} must be a non-empty string of at most 128 characters.`);
  }
  return parsed;
}

function parseStringArray(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value.replace(/,\s*\]$/u, ']'));
  } catch (error) {
    throw new Error(
      `${label} must use an array of TOML basic strings; extend the guard before using another migration shape.`,
      { cause: error },
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some(
      (entry) =>
        typeof entry !== 'string' ||
        !/^[A-Za-z_$][0-9A-Za-z_$]*$/u.test(entry) ||
        entry.length > 128,
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`${label} must be a non-empty array of unique Durable Object class names.`);
  }
  return parsed;
}

function assertMigrationShape(migration, label) {
  if (!migration || typeof migration !== 'object' || Array.isArray(migration)) {
    throw new Error(`${label} must be a Durable Object migration object.`);
  }
  const keys = Object.keys(migration);
  if (!keys.includes('tag') || keys.length < 2 || keys.some((key) => !MIGRATION_KEYS.has(key))) {
    throw new Error(
      `${label} must contain tag and at least one supported Durable Object migration operation.`,
    );
  }
  if (
    typeof migration.tag !== 'string' ||
    migration.tag.length === 0 ||
    migration.tag.length > 128
  ) {
    throw new Error(`${label}.tag must be a non-empty string of at most 128 characters.`);
  }
  for (const key of keys.filter((key) => key !== 'tag')) {
    if (
      !Array.isArray(migration[key]) ||
      migration[key].length === 0 ||
      migration[key].some(
        (entry) =>
          typeof entry !== 'string' ||
          !/^[A-Za-z_$][0-9A-Za-z_$]*$/u.test(entry) ||
          entry.length > 128,
      ) ||
      new Set(migration[key]).size !== migration[key].length
    ) {
      throw new Error(`${label}.${key} must contain unique Durable Object class names.`);
    }
  }
}

export function parseProductionWranglerMigrations(source, label = 'Wrangler config') {
  if (typeof source !== 'string') throw new Error(`${label} source must be text.`);
  const lines = source.split(/\r?\n/u);
  let scriptName = null;
  let inTopLevel = true;
  let currentMigration = null;
  const migrations = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripTomlComment(lines[index]).trim();
    if (!line) continue;

    if (/^\[\[?[^\]]+\]\]?$/u.test(line)) {
      if (/^\[+exports(?:\.|\])/u.test(line)) {
        throw new Error(
          `${label} uses declarative exports; extend the canonical Durable Object contract before migrating away from the legacy history.`,
        );
      }
      inTopLevel = false;
      currentMigration = line === '[[migrations]]' ? {} : null;
      if (currentMigration) migrations.push(currentMigration);
      continue;
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (inTopLevel && assignment?.[1] === 'name') {
      if (scriptName !== null) throw new Error(`${label} declares top-level name more than once.`);
      scriptName = parseBasicString(assignment[2], `${label}.name`);
      continue;
    }
    if (!currentMigration) continue;
    if (!assignment)
      throw new Error(`${label} contains an unsupported migration statement: ${line}`);

    const key = assignment[1];
    if (!MIGRATION_KEYS.has(key)) {
      throw new Error(`${label} contains unsupported migration key: ${key}.`);
    }
    if (Object.hasOwn(currentMigration, key)) {
      throw new Error(`${label} migration declares ${key} more than once.`);
    }

    let rawValue = assignment[2];
    let depth = valueNestingDepth(rawValue);
    while (depth > 0 && index + 1 < lines.length) {
      index += 1;
      const continuation = stripTomlComment(lines[index]).trim();
      rawValue += `\n${continuation}`;
      depth = valueNestingDepth(rawValue);
    }
    if (depth !== 0) throw new Error(`${label}.${key} has an unbalanced TOML value.`);
    currentMigration[key] =
      key === 'tag'
        ? parseBasicString(rawValue, `${label}.${key}`)
        : parseStringArray(rawValue, `${label}.${key}`);
  }

  if (scriptName === null) throw new Error(`${label} is missing its top-level Worker name.`);
  const tags = new Set();
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    assertMigrationShape(migration, `${label}.migrations[${index}]`);
    if (tags.has(migration.tag))
      throw new Error(`${label} repeats migration tag ${migration.tag}.`);
    tags.add(migration.tag);
  }
  return { scriptName, migrations };
}

export function discoverProductionWranglerMigrationConfigs(root = repositoryRoot) {
  return readdirSync(resolve(root, 'cloudflare'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^wrangler(?:\..+)?\.toml$/u.test(entry.name) &&
        !entry.name.endsWith('.example.toml'),
    )
    .map((entry) => `cloudflare/${entry.name}`)
    .sort();
}

export function loadDurableObjectMigrationManifest(root = repositoryRoot) {
  return JSON.parse(readFileSync(resolve(root, DURABLE_OBJECT_MIGRATION_MANIFEST_PATH), 'utf8'));
}

function assertManifestStructure(manifest) {
  if (
    !hasExactKeys(manifest, ['schemaVersion', 'configs']) ||
    manifest.schemaVersion !== CONTRACT_VERSION ||
    !Array.isArray(manifest.configs) ||
    manifest.configs.length === 0
  ) {
    throw new Error(
      `Durable Object migration manifest must use schemaVersion ${CONTRACT_VERSION} and declare configs.`,
    );
  }
  const configs = new Set();
  for (const entry of manifest.configs) {
    if (!hasExactKeys(entry, ['config', 'scriptName', 'migrations'])) {
      throw new Error(
        'Every Durable Object manifest entry must contain exactly config, scriptName, and migrations.',
      );
    }
    if (typeof entry.config !== 'string' || configs.has(entry.config)) {
      throw new Error(`Invalid or duplicate Durable Object config: ${String(entry.config)}.`);
    }
    configs.add(entry.config);
    if (
      typeof entry.scriptName !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(entry.scriptName)
    ) {
      throw new Error(`${entry.config}.scriptName is invalid.`);
    }
    if (!Array.isArray(entry.migrations)) {
      throw new Error(`${entry.config}.migrations must be an array.`);
    }
    const tags = new Set();
    for (let index = 0; index < entry.migrations.length; index += 1) {
      const migration = entry.migrations[index];
      assertMigrationShape(migration, `${entry.config}.migrations[${index}]`);
      if (tags.has(migration.tag)) {
        throw new Error(`${entry.config} repeats migration tag ${migration.tag}.`);
      }
      tags.add(migration.tag);
    }
  }
  return configs;
}

export function assertDurableObjectMigrationContract({
  root = repositoryRoot,
  manifest = loadDurableObjectMigrationManifest(root),
} = {}) {
  const declared = assertManifestStructure(manifest);
  const discovered = discoverProductionWranglerMigrationConfigs(root);
  const missing = discovered.filter((config) => !declared.has(config));
  const stale = [...declared].filter((config) => !discovered.includes(config));
  if (missing.length > 0 || stale.length > 0 || discovered.length !== declared.size) {
    throw new Error(
      'Durable Object migration config inventory mismatch' +
        `${missing.length ? `; unregistered: ${missing.join(', ')}` : ''}` +
        `${stale.length ? `; stale: ${stale.join(', ')}` : ''}.`,
    );
  }

  let migrationCount = 0;
  for (const entry of manifest.configs) {
    assertRepositoryPath(root, entry.config, `${entry.config}.config`);
    const actual = parseProductionWranglerMigrations(
      readFileSync(resolve(root, entry.config), 'utf8'),
      entry.config,
    );
    if (actual.scriptName !== entry.scriptName) {
      throw new Error(
        `${entry.config} script name ${actual.scriptName} does not match manifest ${entry.scriptName}.`,
      );
    }
    if (stableJson(actual.migrations) !== stableJson(entry.migrations)) {
      throw new Error(
        `${entry.config} Durable Object migrations do not exactly match ${DURABLE_OBJECT_MIGRATION_MANIFEST_PATH}.`,
      );
    }
    migrationCount += entry.migrations.length;
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    configCount: declared.size,
    migrationCount,
  };
}

export function assertDurableObjectMigrationManifestAppendOnly({
  previousManifest,
  currentManifest,
}) {
  const previousConfigs = new Map();
  const currentConfigs = new Map();
  assertManifestStructure(previousManifest);
  assertManifestStructure(currentManifest);
  for (const entry of previousManifest.configs) previousConfigs.set(entry.config, entry);
  for (const entry of currentManifest.configs) currentConfigs.set(entry.config, entry);

  for (const [config, previous] of previousConfigs) {
    const current = currentConfigs.get(config);
    if (!current) throw new Error(`Durable Object migration config cannot be removed: ${config}.`);
    if (current.scriptName !== previous.scriptName) {
      throw new Error(`${config} Worker script identity is immutable.`);
    }
    if (current.migrations.length < previous.migrations.length) {
      throw new Error(`${config} Durable Object migration history cannot be truncated.`);
    }
    for (let index = 0; index < previous.migrations.length; index += 1) {
      if (stableJson(previous.migrations[index]) !== stableJson(current.migrations[index])) {
        throw new Error(
          `${config} Durable Object migration history is append-only; existing tag ${previous.migrations[index].tag} changed.`,
        );
      }
    }
  }
  return { previousConfigCount: previousConfigs.size };
}

function parseHistoricalManifest(raw, commit) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`Commit ${commit} contains an invalid Durable Object migration manifest.`, {
      cause: error,
    });
  }
}

export function assertDurableObjectMigrationRepositoryHistory({
  root = repositoryRoot,
  currentManifest = loadDurableObjectMigrationManifest(root),
  runner = execFileSync,
} = {}) {
  let output;
  try {
    output = runner(
      'git',
      [
        'log',
        '--first-parent',
        '--format=%H',
        '--reverse',
        '--',
        DURABLE_OBJECT_MIGRATION_MANIFEST_PATH,
      ],
      { cwd: root, encoding: 'utf8' },
    );
  } catch (error) {
    throw new Error('Cannot inspect Durable Object migration manifest history.', { cause: error });
  }
  const commits = String(output)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (commits.some((commit) => !/^[0-9a-f]{40}$/u.test(commit))) {
    throw new Error('Git returned an invalid commit while reading Durable Object history.');
  }

  let previousManifest = null;
  for (const commit of commits) {
    let raw;
    try {
      raw = runner('git', ['show', `${commit}:${DURABLE_OBJECT_MIGRATION_MANIFEST_PATH}`], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch (error) {
      throw new Error(`Cannot read the Durable Object migration manifest from commit ${commit}.`, {
        cause: error,
      });
    }
    const historicalManifest = parseHistoricalManifest(raw, commit);
    if (previousManifest !== null) {
      assertDurableObjectMigrationManifestAppendOnly({
        previousManifest,
        currentManifest: historicalManifest,
      });
    }
    previousManifest = historicalManifest;
  }
  if (previousManifest !== null) {
    assertDurableObjectMigrationManifestAppendOnly({ previousManifest, currentManifest });
  } else {
    assertManifestStructure(currentManifest);
  }
  return { visibleRevisionCount: commits.length };
}

function main() {
  const contract = assertDurableObjectMigrationContract();
  const history = assertDurableObjectMigrationRepositoryHistory();
  process.stdout.write(`${JSON.stringify({ ok: true, ...contract, ...history })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
