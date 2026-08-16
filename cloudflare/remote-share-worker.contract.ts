import remoteShareWorker, { RemoteShareQuota } from './remote-share-worker.ts';

const generatedEnvContract = remoteShareWorker satisfies ExportedHandler<MusixquareRemoteShareEnv>;

type GeneratedRemoteShareQuotaConstructor = new (
  state: DurableObjectState,
  env: MusixquareRemoteShareEnv,
) => DurableObject;

const generatedRemoteShareQuotaContract =
  RemoteShareQuota satisfies GeneratedRemoteShareQuotaConstructor;

void generatedEnvContract;
void generatedRemoteShareQuotaContract;
