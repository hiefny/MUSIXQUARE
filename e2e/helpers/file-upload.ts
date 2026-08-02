/**
 * File upload helpers for E2E tests.
 * Uses the hidden <input type="file" id="file-input"> element.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const FIXTURE_AUDIO_PATH = fileURLToPath(new URL('../fixtures/test-01.mp3', import.meta.url));

// The logical fixtures intentionally share one binary; their filenames are
// what the playlist and transfer scenarios need to distinguish.
export const FIXTURE_FILES = {
  test01: 'test-01.mp3',
  test02: 'test-02.mp3',
  test03: 'test-03.mp3',
} as const;

let fixtureAudioBuffer: Promise<Buffer> | undefined;

function readFixtureAudio(): Promise<Buffer> {
  fixtureAudioBuffer ??= readFile(FIXTURE_AUDIO_PATH);
  return fixtureAudioBuffer;
}

/**
 * Upload one or more fixture files to the app.
 * The hidden file input triggers the app's file handling pipeline.
 */
async function uploadFiles(
  page: Page,
  ...fileNames: Array<(typeof FIXTURE_FILES)[keyof typeof FIXTURE_FILES]>
): Promise<void> {
  const fileInput = page.locator('#file-input');
  const buffer = await readFixtureAudio();
  await fileInput.setInputFiles(
    fileNames.map((name) => ({
      name,
      mimeType: 'audio/mpeg',
      buffer,
    })),
  );
}

/**
 * Upload a single fixture by name.
 */
export async function uploadFixture(
  page: Page,
  fixture: keyof typeof FIXTURE_FILES,
): Promise<void> {
  await uploadFiles(page, FIXTURE_FILES[fixture]);
}

/**
 * Upload multiple fixtures at once.
 */
export async function uploadFixtures(
  page: Page,
  fixtures: Array<keyof typeof FIXTURE_FILES>,
): Promise<void> {
  const names = fixtures.map((fixture) => FIXTURE_FILES[fixture]);
  await uploadFiles(page, ...names);
}
