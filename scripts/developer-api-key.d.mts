export type DeveloperApiScope =
  | 'room:read'
  | 'playback:read'
  | 'playback:control'
  | 'queue:read'
  | 'queue:write'
  | 'media:upload'
  | 'effects:read'
  | 'effects:control';

export type DeveloperApiKeyCommand =
  | {
      command: 'issue';
      roomCode: string;
      label: string;
      days: number;
      scopes: DeveloperApiScope[];
    }
  | { command: 'revoke'; keyId: string }
  | { command: 'list'; roomCode: string | null };

export interface DeveloperApiD1Row extends Record<string, unknown> {
  key_id?: string;
}
export interface DeveloperApiKeyCliDependencies {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  stdout?: { write(value: string): unknown };
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  execute?: (statement: string) => DeveloperApiD1Row[];
  resolveRoomGeneration?: (roomCode: string) => number | Promise<number>;
}
export interface IssuedDeveloperApiKey {
  apiKey: string;
  keyId: string;
}
export interface RevokedDeveloperApiKey {
  revoked: true;
  keyId: string;
}

export class DeveloperApiKeyCliError extends Error {}
export function parseDeveloperApiKeyCommand(argv: readonly string[]): DeveloperApiKeyCommand;
export function executeDeveloperApiD1(sql: string): DeveloperApiD1Row[];
export function executeAdminD1(sql: string): DeveloperApiD1Row[];
export function resolveCurrentProRoomGeneration(
  roomCode: string,
  execute?: (statement: string) => DeveloperApiD1Row[],
): number;
export function runDeveloperApiKeyCli(
  dependencies: DeveloperApiKeyCliDependencies & {
    argv: readonly ['issue', ...string[]];
  },
): Promise<IssuedDeveloperApiKey>;
export function runDeveloperApiKeyCli(
  dependencies?: DeveloperApiKeyCliDependencies,
): Promise<IssuedDeveloperApiKey | RevokedDeveloperApiKey | DeveloperApiD1Row[]>;
