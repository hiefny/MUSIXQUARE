import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const UNIVERSAL_DIR = resolve('.vite/e2e-universal');
const CURRENT_DIR = resolve('.vite/e2e-current');
const BRIDGE_MARKER = '__MUSIXQUARE_FILE_PLAYBACK_E2E__';

async function javascriptText(directory: string): Promise<string> {
  const files: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (extname(entry.name) === '.js') files.push(child);
    }
  };
  await visit(directory);
  return (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
}

const [universal, current] = await Promise.all([
  javascriptText(UNIVERSAL_DIR),
  javascriptText(CURRENT_DIR),
]);

if (!universal.includes(BRIDGE_MARKER)) {
  throw new Error('Universal E2E artifact does not contain its body-free runtime bridge');
}
if (!universal.includes('universal-v1')) {
  throw new Error('Universal E2E artifact does not contain the exact candidate policy');
}
if (current.includes(BRIDGE_MARKER)) {
  throw new Error('Current-policy E2E artifact leaked the universal runtime bridge');
}

process.stdout.write('Universal/current E2E build isolation verified.\n');
