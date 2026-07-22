export interface DeveloperApiAdminSecretEnvironment extends Record<string, string | undefined> {
  MXQR_DEVELOPER_API_KEY_PEPPER?: string;
  MXQR_DEVELOPER_API_SECRET_FILE?: string;
  npm_execpath?: string;
}
export interface DeveloperApiAdminPepperOptions {
  env?: DeveloperApiAdminSecretEnvironment;
  readFile?: (path: string, encoding: 'utf8') => string;
  secretFile?: string;
}
export function readDeveloperApiAdminPepper(options?: DeveloperApiAdminPepperOptions): string;
export function syncDeveloperApiAdminPepper(options?: {
  env?: DeveloperApiAdminSecretEnvironment;
  execute?: (
    executable: string,
    args: string[],
    options: {
      cwd: string;
      env: DeveloperApiAdminSecretEnvironment;
      input: string;
      stdio: ['pipe', 'inherit', 'inherit'];
    },
  ) => unknown;
  stdout?: { write(value: string): unknown };
}): void;
