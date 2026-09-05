type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'running';
type ReportFilter = 'all' | 'failed' | 'passed' | 'skipped';

interface TestEntry {
  readonly title: string;
  readonly file: string;
  readonly status: TestStatus;
  readonly duration: number;
  readonly error?: string;
}

interface ReportData {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly completed: number;
  readonly running: string | null;
  readonly finishedAt: string | null;
  readonly finalStatus: string | null;
  readonly durationMs: number;
  readonly tests: readonly TestEntry[];
}

declare global {
  interface Window {
    __E2E_REPORT__?: unknown;
    toggleError(element: HTMLElement): void;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTestStatus(value: unknown): value is TestStatus {
  return (
    value === 'passed' ||
    value === 'failed' ||
    value === 'timedOut' ||
    value === 'skipped' ||
    value === 'interrupted' ||
    value === 'running'
  );
}

function isTestEntry(value: unknown): value is TestEntry {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.file === 'string' &&
    isTestStatus(value.status) &&
    typeof value.duration === 'number' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isReportData(value: unknown): value is ReportData {
  if (!isRecord(value) || !Array.isArray(value.tests) || !value.tests.every(isTestEntry)) {
    return false;
  }
  return (
    typeof value.total === 'number' &&
    typeof value.passed === 'number' &&
    typeof value.failed === 'number' &&
    typeof value.skipped === 'number' &&
    typeof value.completed === 'number' &&
    (value.running === null || typeof value.running === 'string') &&
    (value.finishedAt === null || typeof value.finishedAt === 'string') &&
    (value.finalStatus === null || typeof value.finalStatus === 'string') &&
    typeof value.durationMs === 'number'
  );
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing report viewer element #${id}.`);
  return element;
}

function isReportFilter(value: string | undefined): value is ReportFilter {
  return value === 'all' || value === 'failed' || value === 'passed' || value === 'skipped';
}

let currentFilter: ReportFilter = 'all';
let report: ReportData | null = null;
let polling: ReturnType<typeof setInterval> | null = null;

requiredElement('filters').addEventListener('click', (event: MouseEvent) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>('.filter-btn');
  if (!button || !isReportFilter(button.dataset.filter)) return;
  document.querySelectorAll('.filter-btn').forEach((candidate) => {
    candidate.classList.remove('active');
  });
  button.classList.add('active');
  currentFilter = button.dataset.filter;
  renderTests();
});

function fmtTime(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return '-';
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function isFailedStatus(status: TestStatus): boolean {
  return status === 'failed' || status === 'timedOut' || status === 'interrupted';
}

function statusIcon(status: TestStatus): string {
  if (status === 'passed') return '<span class="icon pass">✓</span>';
  if (isFailedStatus(status)) return '<span class="icon fail">✗</span>';
  if (status === 'skipped') return '<span class="icon skip">∘</span>';
  return '<span class="icon pending">·</span>';
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function renderTests(): void {
  if (!report) return;
  const tests = report.tests.filter((test) => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'failed') return isFailedStatus(test.status);
    return test.status === currentFilter;
  });
  requiredElement('test-list').innerHTML = tests
    .map((test, index) => {
      const error =
        isFailedStatus(test.status) && test.error
          ? `<div class="error-detail" id="err-${index}">${escapeHtml(test.error)}</div>`
          : '';
      return `
      <div class="test-item" onclick="toggleError(this)" data-idx="${index}">
        ${statusIcon(test.status)}
        <div class="test-name">${escapeHtml(test.title)}<span class="file">${escapeHtml(test.file)}</span></div>
        <div class="test-time">${fmtTime(test.duration)}</div>
      </div>
      ${error}
    `;
    })
    .join('');
}

window.toggleError = (element: HTMLElement): void => {
  const detail = document.getElementById(`err-${element.dataset.idx ?? ''}`);
  if (!detail) return;
  element.classList.toggle('expanded');
  detail.classList.toggle('show');
};

function update(data: ReportData): void {
  report = data;
  const {
    total,
    passed,
    failed,
    skipped,
    completed,
    running,
    finishedAt,
    finalStatus,
    durationMs,
  } = data;
  const badge = requiredElement('badge');
  if (finishedAt) {
    if (failed === 0 && finalStatus === 'passed') {
      badge.textContent = 'ALL PASSED';
      badge.className = 'badge passed';
    } else {
      badge.textContent = failed > 0 ? `${failed} FAILED` : 'RUN FAILED';
      badge.className = 'badge failed';
    }
  } else {
    badge.textContent = 'RUNNING';
    badge.className = 'badge running';
  }

  requiredElement('s-total').textContent = String(total);
  requiredElement('s-pass').textContent = String(passed);
  requiredElement('s-fail').textContent = String(failed);
  requiredElement('s-skip').textContent = String(skipped);
  requiredElement('s-time').textContent = fmtTime(durationMs);

  const percent = total ? (completed / total) * 100 : 0;
  requiredElement('prog-pass').style.width = `${total ? (passed / total) * 100 : 0}%`;
  requiredElement('prog-fail').style.width = `${total ? (failed / total) * 100 : 0}%`;
  requiredElement('prog-text').textContent = `${completed} / ${total}`;
  requiredElement('prog-pct').textContent = `${percent.toFixed(0)}%`;
  document
    .querySelector('.progress-bar')
    ?.setAttribute('aria-valuenow', String(Math.round(percent)));

  const runningElement = requiredElement('running');
  runningElement.style.display = running ? 'block' : 'none';
  if (running) runningElement.textContent = running;

  const failedCount = data.tests.filter((test) => isFailedStatus(test.status)).length;
  requiredElement('f-all').textContent = String(completed);
  requiredElement('f-fail').textContent = String(failedCount);
  requiredElement('f-pass').textContent = String(passed);
  requiredElement('f-skip').textContent = String(skipped);
  requiredElement('no-data').style.display = 'none';
  requiredElement('copy-section').style.display = finishedAt ? 'flex' : 'none';
  renderTests();

  if (finishedAt && polling !== null) {
    clearInterval(polling);
    polling = null;
  }
}

function poll(): void {
  document.getElementById('report-script')?.remove();
  const script = document.createElement('script');
  script.id = 'report-script';
  script.src = `./e2e-report-data.js?t=${Date.now()}`;
  script.onload = () => {
    if (isReportData(window.__E2E_REPORT__)) update(window.__E2E_REPORT__);
  };
  script.onerror = () => undefined;
  document.body.append(script);
}

polling = setInterval(poll, 1_000);
poll();

requiredElement('copy-btn').addEventListener('click', () => {
  if (!report) return;
  const failedTests = report.tests.filter((test) => isFailedStatus(test.status));
  let text = '## E2E Test Report\n';
  text += `- **Total**: ${report.total}\n`;
  text += `- **Passed**: ${report.passed}\n`;
  text += `- **Failed**: ${report.failed}\n`;
  text += `- **Skipped**: ${report.skipped}\n`;
  text += `- **Run status**: ${report.finalStatus ?? 'unknown'}\n`;
  text += `- **Duration**: ${fmtTime(report.durationMs)}\n\n`;
  if (failedTests.length > 0) {
    text += '### Failed Tests\n\n';
    failedTests.forEach((test, index) => {
      text += `**${index + 1}. ${test.title}** (${test.file})\n`;
      if (test.error) {
        text += `\`\`\`\n${test.error.split('\n').slice(0, 3).join('\n')}\n\`\`\`\n\n`;
      }
    });
  } else if (report.finalStatus === 'passed' && report.failed === 0) {
    text += 'All tests passed.\n';
  } else {
    text += 'The test run did not pass. No individual failed test entries were recorded.\n';
  }

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const button = requiredElement('copy-btn');
      button.textContent = 'Copied';
      button.classList.add('copied');
      setTimeout(() => {
        button.textContent = 'Copy report';
        button.classList.remove('copied');
      }, 2_000);
    })
    .catch((error: unknown) => {
      try {
        console.error('[report-viewer] Copy failed.', error);
      } catch {
        // Clipboard feedback is best-effort and terminal.
      }
    });
});

export {};
