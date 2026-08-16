import developerApiFacadeWorker from './developer-api-facade-worker.ts';

const generatedEnvContract =
  developerApiFacadeWorker satisfies ExportedHandler<MusixquareDeveloperApiFacadeEnv>;

void generatedEnvContract;
