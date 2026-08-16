import signalingWorker, { MusixquareRoom } from './signaling-worker.ts';

const generatedEnvContract = signalingWorker satisfies ExportedHandler<MusixquareSignalingEnv>;

type GeneratedMusixquareRoomConstructor = new (
  state: DurableObjectState,
  env: MusixquareSignalingEnv,
) => DurableObject;

const generatedMusixquareRoomContract = MusixquareRoom satisfies GeneratedMusixquareRoomConstructor;

void generatedEnvContract;
void generatedMusixquareRoomContract;
