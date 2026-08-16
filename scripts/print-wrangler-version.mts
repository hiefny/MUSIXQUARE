import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageMetadata {
  version: string;
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    typeof value.version === 'string' &&
    value.version.trim().length > 0
  );
}

export function readInstalledWranglerVersion(repoRoot: string): string {
  const packagePath = path.join(repoRoot, 'node_modules', 'wrangler', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!isPackageMetadata(parsed)) {
    throw new Error('Installed Wrangler package metadata is missing a valid version.');
  }
  return parsed.version;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(readInstalledWranglerVersion(repoRoot));
}
