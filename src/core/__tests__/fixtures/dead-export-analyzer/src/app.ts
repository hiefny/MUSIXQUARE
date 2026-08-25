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
