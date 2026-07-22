import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Resolve npm without asking Node to execute a Windows .cmd shim directly.
 * Node 24 rejects that with EINVAL, while `shell: true` is deprecated for
 * argument-bearing child processes. Prefer npm's JavaScript CLI through the
 * current Node executable and retain a closed cmd.exe fallback for unusual
 * portable Node layouts.
 */
export function npmInvocation(platform = process.platform, options = {}) {
  if (platform !== 'win32') {
    return { executable: 'npm', prefixArgs: [] };
  }

  const nodeExecutable = options.nodeExecutable || process.execPath;
  const environment = options.environment || process.env;
  const fileExists = options.fileExists || existsSync;
  const candidates = [
    environment.npm_execpath,
    win32.resolve(win32.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => fileExists(candidate));
  if (npmCli) {
    return { executable: nodeExecutable, prefixArgs: [npmCli] };
  }

  return {
    executable: environment.ComSpec || 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', 'npm.cmd'],
  };
}

export function executeNpm(args, options = {}) {
  const invocation = npmInvocation(options.platform, options);
  return execFileSync(invocation.executable, [...invocation.prefixArgs, ...args], {
    encoding: options.encoding,
    stdio: options.stdio || 'inherit',
    env: options.environment || process.env,
  });
}
