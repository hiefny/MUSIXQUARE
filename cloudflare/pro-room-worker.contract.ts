import proRoomWorker, { MusixquareProRoom, MusixquareServiceControl } from './pro-room-worker.ts';

const generatedEnvContract = proRoomWorker satisfies ExportedHandler<MusixquareProRoomEnv>;

type GeneratedDurableObjectConstructor = new (
  state: DurableObjectState,
  env: MusixquareProRoomEnv,
) => DurableObject;

const generatedProRoomContract = MusixquareProRoom satisfies GeneratedDurableObjectConstructor;
const generatedServiceControlContract =
  MusixquareServiceControl satisfies GeneratedDurableObjectConstructor;

void generatedEnvContract;
void generatedProRoomContract;
void generatedServiceControlContract;
