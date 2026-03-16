/**
 * File upload helpers for E2E tests.
 * Uses the hidden <input type="file" id="file-input"> element.
 */
import type { Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

export const FIXTURE_FILES = {
  silence3s: path.join(FIXTURES_DIR, 'silence-3s.mp3'),
  silence5s: path.join(FIXTURES_DIR, 'silence-5s.mp3'),
  tone1s: path.join(FIXTURES_DIR, 'tone-1s.mp3'),
} as const;

/**
 * Upload one or more fixture files to the app.
 * The hidden file input triggers the app's file handling pipeline.
 */
export async function uploadFiles(page: Page, ...filePaths: string[]): Promise<void> {
  const fileInput = page.locator('#file-input');
  await fileInput.setInputFiles(filePaths);
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
  const paths = fixtures.map((f) => FIXTURE_FILES[f]);
  await uploadFiles(page, ...paths);
}
