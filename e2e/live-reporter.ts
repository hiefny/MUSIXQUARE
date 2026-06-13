/**
 * Live JSON Reporter for Playwright
 * Writes e2e-report.json incrementally as tests complete.
 * The report-viewer.html polls this file for real-time progress.
 */
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import * as fs from 'fs';
import * as path from 'path';

interface TestEntry {
  title: string;
  file: string;
  suite: string;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'running';
  duration: number;
  error?: string;
  errorSnippet?: string;
}

interface ReportData {
  startedAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  running: string | null;
  tests: TestEntry[];
  finalStatus: string | null;
  durationMs: number;
}

const REPORT_JSON = path.join(process.cwd(), 'e2e-report.json');
const REPORT_JS = path.join(process.cwd(), 'e2e', 'e2e-report-data.js');

class LiveReporter implements Reporter {
  private data: ReportData = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    completed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    running: null,
    tests: [],
    finalStatus: null,
    durationMs: 0,
  };

  private startTime = Date.now();

  private write() {
    this.data.durationMs = Date.now() - this.startTime;
    const json = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(REPORT_JSON, json);
    fs.writeFileSync(REPORT_JS, `window.__E2E_REPORT__ = ${json};`);
  }

  onBegin(_config: FullConfig, suite: Suite) {
    this.data.total = suite.allTests().length;
    this.data.startedAt = new Date().toISOString();
    this.startTime = Date.now();
    this.write();
  }

  onTestBegin(test: TestCase) {
    const title = test.titlePath().slice(2).join(' › ');
    this.data.running = title;
    this.write();
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const file = path.relative(process.cwd(), test.location.file).replace(/\\/g, '/');
    const suite = test.parent?.title ?? '';

    const entry: TestEntry = {
      title: test.title,
      file,
      suite,
      status: result.status,
      duration: result.duration,
    };

    // 'interrupted' (run aborted mid-test) counts as failed — it was silently
    // landing in the passed bucket via the else branch.
    if (
      result.status === 'failed' ||
      result.status === 'timedOut' ||
      result.status === 'interrupted'
    ) {
      const err = result.errors[0];
      if (err) {
        entry.error = err.message?.slice(0, 500) ?? 'Unknown error';
        entry.errorSnippet = err.snippet?.slice(0, 300);
      }
      this.data.failed++;
    } else if (result.status === 'skipped') {
      this.data.skipped++;
    } else {
      this.data.passed++;
    }

    this.data.completed++;
    this.data.running = null;
    this.data.tests.push(entry);
    this.write();
  }

  onEnd(result: FullResult) {
    this.data.finishedAt = new Date().toISOString();
    this.data.running = null;
    this.data.finalStatus = result.status;
    this.write();
  }
}

export default LiveReporter;
