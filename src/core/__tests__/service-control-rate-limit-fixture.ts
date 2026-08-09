import { MusixquareServiceControl } from '../../../cloudflare/pro-room-worker.js';
import {
  ABUSE_RATE_CONSUME_PATH,
  ABUSE_RATE_IDEMPOTENT_CONSUME_PATH,
} from '../../../cloudflare/service-maintenance.js';

class RateControlStorage {
  private readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get(key: string): Promise<unknown> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarmAt = timestamp;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

type RateControlObject = {
  fetch(request: Request): Promise<Response>;
};

export function createAtomicRateControlBinding(barrierCalls = 0): {
  binding: {
    idFromName(name: string): string;
    get(id: string): { fetch(request: Request): Promise<Response> };
  };
  rateFetchCount(): number;
  objectNames(): string[];
  releaseRateBarrier(): void;
} {
  const instances = new Map<string, RateControlObject>();
  let rateFetches = 0;
  let releaseBarrier: (() => void) | null = null;
  const barrier =
    barrierCalls > 0
      ? new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        })
      : Promise.resolve();

  const object = (name: string): RateControlObject => {
    let current = instances.get(name);
    if (!current) {
      const storage = new RateControlStorage();
      current = new MusixquareServiceControl({
        storage,
        blockConcurrencyWhile: (callback: () => Promise<void>) => callback(),
      } as never) as RateControlObject;
      instances.set(name, current);
    }
    return current;
  };

  return {
    binding: {
      idFromName(name: string): string {
        return name;
      },
      get(id: string) {
        return {
          fetch: async (request: Request): Promise<Response> => {
            if (
              new URL(request.url).pathname === ABUSE_RATE_CONSUME_PATH ||
              new URL(request.url).pathname === ABUSE_RATE_IDEMPOTENT_CONSUME_PATH
            ) {
              rateFetches += 1;
              if (rateFetches === barrierCalls) releaseBarrier?.();
              await barrier;
            }
            return object(id).fetch(request);
          },
        };
      },
    },
    rateFetchCount: () => rateFetches,
    objectNames: () => [...instances.keys()],
    releaseRateBarrier: () => releaseBarrier?.(),
  };
}
