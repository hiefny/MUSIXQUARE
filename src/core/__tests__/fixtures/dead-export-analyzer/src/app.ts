import { used } from './feature-a.ts';
import * as namespace from './namespace.ts';
import { reexported } from './barrel.ts';
import defaultValue from './default.ts';
import { overloaded } from './overload.ts';
import type { ReachableType } from './type-barrel.ts';

void used;
void namespace.namespaced;
void reexported;
void defaultValue;
void overloaded('fixture');
const reachableType: ReachableType = { value: 1 };
void reachableType;
import('./lazy.ts').catch((error) => {
  console.error('[DeadExportFixture] Lazy module failed to load', error);
});
new Worker(new URL('./worker.ts', import.meta.url));

async function acquire<T>(start: () => Promise<T>): Promise<T> {
  return start();
}
const { wrappedLoaded, aliasWrappedLoaded: loadedAlias } = await acquire(() => import('./lazy.ts'));
void wrappedLoaded();
void loadedAlias();
void import('./lazy.ts').then(
  ({ callbackLoaded }) => callbackLoaded(),
  (error) => console.error('[DeadExportFixture] Callback module failed to load', error),
);
const { shadowedLazy } = { shadowedLazy: () => 7 };
void shadowedLazy();
