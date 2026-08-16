import appWorker, { type AppConfiguredBindings } from './app-worker.ts';

const generatedEnvContract = appWorker satisfies ExportedHandler<MusixquareAppEnv>;

type GeneratedBindingsMatch = MusixquareAppEnv extends AppConfiguredBindings ? true : false;
type GeneratedBindingKeysMatch =
  Exclude<keyof MusixquareAppEnv, keyof AppConfiguredBindings> extends never
    ? Exclude<keyof AppConfiguredBindings, keyof MusixquareAppEnv> extends never
      ? true
      : false
    : false;
type MissingAssetsIsRejected =
  Omit<MusixquareAppEnv, 'ASSETS'> extends AppConfiguredBindings ? false : true;

const generatedBindingsContract: GeneratedBindingsMatch = true;
const generatedBindingKeysContract: GeneratedBindingKeysMatch = true;
const missingBindingFixtureContract: MissingAssetsIsRejected = true;

void generatedEnvContract;
void generatedBindingsContract;
void generatedBindingKeysContract;
void missingBindingFixtureContract;
