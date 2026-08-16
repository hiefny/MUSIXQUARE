import developerApiWorker, { DeveloperApiRateLimiter } from './developer-api-worker.ts';

const generatedEnvContract =
  developerApiWorker satisfies ExportedHandler<MusixquareDeveloperApiEnv>;

type GeneratedRateLimiterConstructor = new (
  state: DurableObjectState,
  env: MusixquareDeveloperApiEnv,
) => DurableObject;

const generatedRateLimiterContract =
  DeveloperApiRateLimiter satisfies GeneratedRateLimiterConstructor;

void generatedEnvContract;
void generatedRateLimiterContract;
