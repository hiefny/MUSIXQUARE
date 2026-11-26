/**
 * /status: reads /api/status and fills the overall line, the service rows,
 * the row of recent checks under each service and the operator note. The
 * page is English only, like the other document pages, so the copy it fills
 * in lives here.
 *
 * The server decides every state. This page only ages an answer toward
 * "not checked" while it stays open. Age is measured on one estimate of
 * server time that never runs backwards: the newest payload's generatedAt
 * plus the larger of monotonic and wall-clock time since it arrived, so a
 * wrong or sleeping device clock can only make rows turn gray sooner, never
 * green. The threshold comes from the payload itself. Times read as "3
 * minutes ago" on that same estimate; each one's title holds the exact time
 * in the viewer's time zone.
 */

(function installStatusPage() {
  type ComponentId = 'website' | 'rooms' | 'connection' | 'pro';
  type ComponentState = 'ok' | 'problem' | 'maintenance' | 'stale';
  type CheckResult = 'o' | 'p' | 'm' | 'n' | 'x';
  type LinePart = string | Node;

  /** One mark per check slot, oldest first; the last slot is at lastMs. */
  interface StatusRecent {
    readonly lastMs: number;
    readonly slots: string;
  }

  interface StatusComponent {
    readonly id: string;
    readonly state: ComponentState;
    readonly lastCheckedAt: string | null;
    readonly problemSince: string | null;
    readonly recent: StatusRecent | null;
  }

  interface StatusAnnouncement {
    readonly message: string;
    readonly postedAt: string | null;
    readonly expiresMs: number | null;
  }

  interface StatusPayload {
    readonly generatedMs: number;
    readonly staleAfterMs: number;
    readonly slotMs: number;
    readonly unavailable: boolean;
    readonly overallState: ComponentState;
    readonly maintenance: boolean;
    readonly maintenanceSince: string | null;
    readonly lastCheckedAt: string | null;
    readonly announcement: StatusAnnouncement | null;
    readonly components: readonly StatusComponent[];
  }

  const STATUS_URL = '/api/status';
  // Page-local cadences. The monitors' own timing lives on the server.
  const STATUS_REFRESH_MS = 60_000;
  const STATUS_FETCH_TIMEOUT_MS = 15_000;
  // Cells under each service: the newest SHOWN_SLOTS checks, one per slot of
  // the payload's check interval (96 at 15 minutes is the last 24 hours).
  const SHOWN_SLOTS = 96;
  const COMPONENT_IDS: readonly ComponentId[] = ['website', 'rooms', 'connection', 'pro'];
  const COMPONENT_STATES = new Set<string>(['ok', 'problem', 'maintenance', 'stale']);
  const RECENT_SLOTS_RE = /^[opmn]{1,96}$/u;
  const HANGUL_RE = /[ㄱ-ㆎ가-힣]/u;

  const WORDS: Record<ComponentState, string> = {
    ok: 'Normal',
    problem: 'Problem',
    maintenance: 'Maintenance',
    stale: 'Not checked',
  };
  const PROBLEM_LINES: Record<ComponentId, string> = {
    website: 'The website and app have a problem',
    rooms: 'Creating and joining rooms has a problem',
    connection: 'Device connections have a problem',
    pro: 'PRO rooms have a problem',
  };
  const RESULT_WORDS: Record<CheckResult, string> = {
    o: 'Passed',
    p: 'Failed',
    m: 'During maintenance',
    n: 'No check',
    x: 'Before monitoring began',
  };
  const EXACT_TIME = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const SLOT_TIME = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const overallLine = document.querySelector<HTMLElement>('.status-overall');
  const overallText = document.querySelector<HTMLElement>('[data-slot="overall"]');
  const metaLine = document.querySelector<HTMLElement>('[data-slot="meta"]');
  const notice = document.querySelector<HTMLElement>('[data-slot="notice"]');
  const noticeMessage = document.querySelector<HTMLElement>('[data-slot="notice-message"]');
  const noticePosted = document.querySelector<HTMLElement>('[data-slot="notice-posted"]');
  const rows = [...document.querySelectorAll<HTMLElement>('.status-row')];
  if (!overallLine || !overallText || !metaLine || !notice || !noticeMessage || !noticePosted) {
    return;
  }

  let shown: StatusPayload | null = null;
  let anchorServerMs = 0;
  let anchorMonotonicMs = 0;
  let anchorWallMs = 0;
  let refreshTimer = 0;

  /** The current server time, estimated without ever running backwards. */
  function serverNow(): number {
    const elapsed = Math.max(performance.now() - anchorMonotonicMs, Date.now() - anchorWallMs, 0);
    return anchorServerMs + elapsed;
  }

  function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
  }

  /** "3 minutes", "1 hour", "4 days"; null under a minute. */
  function duration(elapsedMs: number): string | null {
    const minutes = Math.floor(Math.max(0, elapsedMs) / 60_000);
    if (minutes < 1) return null;
    if (minutes < 60) return plural(minutes, 'minute');
    if (minutes < 1440) return plural(Math.floor(minutes / 60), 'hour');
    return plural(Math.floor(minutes / 1440), 'day');
  }

  function ago(elapsedMs: number): string {
    const value = duration(elapsedMs);
    return value === null ? 'just now' : `${value} ago`;
  }

  /** A relative time whose title is the exact time in the viewer's zone. */
  function timeNode(iso: string, label: string): HTMLTimeElement {
    const node = document.createElement('time');
    node.dateTime = iso;
    node.title = EXACT_TIME.format(new Date(iso));
    node.textContent = label;
    return node;
  }

  function validIso(value: unknown): string | null {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  }

  function parseRecent(raw: unknown): StatusRecent | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const lastAt = validIso(record.lastAt);
    const slots = typeof record.slots === 'string' ? record.slots : '';
    return lastAt && RECENT_SLOTS_RE.test(slots) ? { lastMs: Date.parse(lastAt), slots } : null;
  }

  function parsePayload(raw: unknown): StatusPayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (record.schemaVersion !== 1) return null;
    const generatedAt = validIso(record.generatedAt);
    const policy = (record.policy || {}) as Record<string, unknown>;
    const staleAfterMinutes = policy.staleAfterMinutes;
    const intervalMinutes = policy.checkIntervalMinutes;
    const overall = (record.overall || {}) as Record<string, unknown>;
    const overallState = String(overall.state || '');
    if (
      !generatedAt ||
      typeof staleAfterMinutes !== 'number' ||
      !(staleAfterMinutes > 0) ||
      typeof intervalMinutes !== 'number' ||
      !(intervalMinutes > 0) ||
      !COMPONENT_STATES.has(overallState)
    ) {
      return null;
    }
    const maintenance = (record.maintenance || {}) as Record<string, unknown>;
    const announcement = record.announcement as Record<string, unknown> | null | undefined;
    const rawComponents = Array.isArray(record.components) ? record.components : [];
    const components: StatusComponent[] = [];
    for (const item of rawComponents) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const state = String(entry.state || '');
      if (typeof entry.id !== 'string' || !COMPONENT_STATES.has(state)) continue;
      components.push({
        id: entry.id,
        state: state as ComponentState,
        lastCheckedAt: validIso(entry.lastCheckedAt),
        problemSince: validIso(entry.problemSince),
        recent: parseRecent(entry.recent),
      });
    }
    const message =
      announcement && typeof announcement.message === 'string' ? announcement.message.trim() : '';
    const expiresAt = announcement ? validIso(announcement.expiresAt) : null;
    return {
      generatedMs: Date.parse(generatedAt),
      staleAfterMs: staleAfterMinutes * 60_000,
      slotMs: intervalMinutes * 60_000,
      unavailable: overall.reason === 'results_unavailable',
      overallState: overallState as ComponentState,
      maintenance: maintenance.active === true,
      maintenanceSince: validIso(maintenance.since),
      lastCheckedAt: validIso(overall.lastCheckedAt),
      announcement: message
        ? {
            message,
            postedAt: announcement ? validIso(announcement.postedAt) : null,
            expiresMs: expiresAt ? Date.parse(expiresAt) : null,
          }
        : null,
      components,
    };
  }

  /** Keeps the newest snapshot; an equal or older one only keeps the clock going. */
  function accept(payload: StatusPayload): void {
    if (shown && payload.generatedMs <= shown.generatedMs) return;
    const estimate = shown ? serverNow() : payload.generatedMs;
    shown = payload;
    anchorServerMs = Math.max(estimate, payload.generatedMs);
    anchorMonotonicMs = performance.now();
    anchorWallMs = Date.now();
  }

  /** Ages an answer toward "not checked"; never turns anything green or red. */
  function agedState(
    component: StatusComponent,
    payload: StatusPayload,
    now: number,
  ): ComponentState {
    if (component.state === 'stale') return 'stale';
    if (component.state === 'maintenance') {
      return now - payload.generatedMs > payload.staleAfterMs ? 'stale' : 'maintenance';
    }
    if (!component.lastCheckedAt) return 'stale';
    return now - Date.parse(component.lastCheckedAt) > payload.staleAfterMs
      ? 'stale'
      : component.state;
  }

  /** Writes a line only when its text or times actually changed. */
  function setLine(node: HTMLElement, parts: readonly LinePart[] | null): void {
    if (!parts || parts.length === 0) {
      node.hidden = true;
      if (node.dataset.sig) node.replaceChildren();
      node.dataset.sig = '';
      return;
    }
    const probe = document.createElement('span');
    probe.append(...parts.map((part) => (typeof part === 'string' ? part : part.cloneNode(true))));
    const times = [...probe.querySelectorAll('time')].map((time) => time.dateTime).join(',');
    const sig = `${probe.textContent}|${times}`;
    if (node.dataset.sig !== sig) {
      node.replaceChildren(...parts);
      node.dataset.sig = sig;
    }
    node.hidden = false;
  }

  function setOverall(state: string, line: string): void {
    overallLine!.dataset.state = state;
    if (overallText!.textContent !== line) overallText!.textContent = line;
  }

  function setWord(row: HTMLElement, value: string): void {
    const word = row.querySelector<HTMLElement>('[data-slot="word"]');
    if (word && word.textContent !== value) word.textContent = value;
  }

  /** A window length in whole hours up to two days ("24 hours"), else minutes. */
  function windowWords(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    return minutes % 60 === 0 && minutes <= 2880
      ? plural(minutes / 60, 'hour')
      : plural(minutes, 'minute');
  }

  /** "Last 24 hours: all 96 checks passed", "Last 24 hours: 2 failed checks". */
  function checksSummary(marks: string, slotMs: number): string {
    const count = (mark: CheckResult) => [...marks].filter((value) => value === mark).length;
    const span = windowWords(marks.length * slotMs);
    const recorded = marks.length - count('x');
    if (recorded === 0) return `Last ${span}: no checks yet`;
    const parts: string[] = [];
    const failed = count('p');
    const maintenance = count('m');
    const missed = count('n');
    if (failed > 0) parts.push(plural(failed, 'failed check'));
    if (maintenance > 0) {
      parts.push(`${plural(maintenance, 'check')} during maintenance`);
    }
    if (missed > 0) parts.push(plural(missed, 'missed check'));
    if (parts.length > 0) return `Last ${span}: ${parts.join(', ')}`;
    return `Last ${span}: ${recorded === 1 ? 'the only check' : `all ${recorded} checks`} passed`;
  }

  function renderChecks(slot: HTMLElement, recent: StatusRecent | null, slotMs: number): void {
    const sig = recent ? `${recent.lastMs}|${slotMs}|${recent.slots}` : '';
    if (slot.dataset.sig === sig) return;
    slot.dataset.sig = sig;
    if (!recent) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    // A record shorter than the window (the first hours after launch) starts
    // with faint cells that the summary does not count.
    const marks = recent.slots.slice(-SHOWN_SLOTS).padStart(SHOWN_SLOTS, 'x');
    const cells = document.createElement('div');
    cells.className = 'status-checks__cells';
    cells.setAttribute('aria-hidden', 'true');
    [...marks].forEach((mark, index) => {
      const result = mark as CheckResult;
      const cell = document.createElement('span');
      cell.className = 'status-checks__cell';
      cell.dataset.result = result;
      const at = recent.lastMs - (SHOWN_SLOTS - 1 - index) * slotMs;
      cell.title = `${SLOT_TIME.format(new Date(at))} · ${RESULT_WORDS[result]}`;
      cells.append(cell);
    });
    const axis = document.createElement('p');
    axis.className = 'status-checks__axis';
    const summary = document.createElement('span');
    summary.className = 'status-checks__summary';
    summary.textContent = checksSummary(marks, slotMs);
    const now = document.createElement('span');
    now.setAttribute('aria-hidden', 'true');
    now.textContent = 'Now';
    axis.append(summary, now);
    slot.replaceChildren(cells, axis);
    slot.hidden = false;
  }

  function renderNotice(payload: StatusPayload | null, now: number): void {
    const announcement = payload?.announcement;
    if (!announcement || (announcement.expiresMs !== null && now >= announcement.expiresMs)) {
      notice!.hidden = true;
      noticeMessage!.textContent = '';
      setLine(noticePosted!, null);
      return;
    }
    if (noticeMessage!.textContent !== announcement.message) {
      noticeMessage!.textContent = announcement.message;
    }
    // One operator-written string, shown as written: tell assistive tech its language.
    noticeMessage!.lang = HANGUL_RE.test(announcement.message) ? 'ko' : 'en';
    const posted = announcement.postedAt;
    setLine(
      noticePosted!,
      posted ? ['Posted ', timeNode(posted, ago(now - Date.parse(posted)))] : null,
    );
    notice!.hidden = false;
  }

  function renderUnavailable(payload: StatusPayload | null): void {
    setOverall('stale', 'Status is unavailable right now');
    setLine(metaLine!, ['Please try again shortly.']);
    renderNotice(payload, serverNow());
    for (const row of rows) {
      row.dataset.state = 'empty';
      setWord(row, '');
      const checks = row.querySelector<HTMLElement>('[data-slot="checks"]');
      if (checks) renderChecks(checks, null, 0);
    }
  }

  function earliest(values: readonly (string | null)[]): string | null {
    let best: string | null = null;
    for (const value of values) {
      if (value && (best === null || Date.parse(value) < Date.parse(best))) best = value;
    }
    return best;
  }

  function render(): void {
    const payload = shown;
    if (!payload || payload.unavailable) {
      renderUnavailable(payload);
      return;
    }
    const now = serverNow();
    const since = (iso: string) => now - Date.parse(iso);
    const snapshotFresh = now - payload.generatedMs <= payload.staleAfterMs;
    const maintenanceActive = payload.maintenance && snapshotFresh;
    const serverOverall: ComponentState = snapshotFresh ? payload.overallState : 'stale';

    const states = new Map<string, ComponentState>();
    for (const id of COMPONENT_IDS) {
      const component = payload.components.find((entry) => entry.id === id);
      states.set(id, component ? agedState(component, payload, now) : 'stale');
    }

    for (const row of rows) {
      const id = row.dataset.component || '';
      const state = states.get(id) || 'stale';
      row.dataset.state = state;
      setWord(row, WORDS[state]);
      const component = payload.components.find((entry) => entry.id === id) || null;
      const checks = row.querySelector<HTMLElement>('[data-slot="checks"]');
      if (checks) renderChecks(checks, component?.recent || null, payload.slotMs);
    }

    const idsIn = (state: ComponentState) => COMPONENT_IDS.filter((id) => states.get(id) === state);
    const problems = idsIn('problem');
    const maintained = idsIn('maintenance');
    const stale = idsIn('stale');
    const total = COMPONENT_IDS.length;
    const checked = payload.lastCheckedAt;
    const checkedParts = (lead: string): LinePart[] =>
      checked ? [lead, timeNode(checked, ago(since(checked)))] : [];

    if (maintenanceActive) {
      setOverall('maintenance', 'Under maintenance');
      const started = payload.maintenanceSince;
      setLine(metaLine!, started ? ['Started ', timeNode(started, ago(since(started)))] : null);
    } else if (problems.length > 0 || serverOverall === 'problem') {
      const firstProblem = problems[0];
      setOverall(
        'problem',
        problems.length === 1 && firstProblem
          ? PROBLEM_LINES[firstProblem]
          : problems.length === total
            ? 'MUSIXQUARE has a problem right now'
            : 'Some services have a problem',
      );
      const started = earliest(
        payload.components
          .filter((entry) => states.get(entry.id) === 'problem')
          .map((entry) => entry.problemSince),
      );
      const parts: LinePart[] = started ? ['Started ', timeNode(started, ago(since(started)))] : [];
      if (checked) {
        parts.push(parts.length > 0 ? ', checked ' : 'Checked ');
        parts.push(timeNode(checked, ago(since(checked))));
      }
      setLine(metaLine!, parts);
    } else if (maintained.length > 0 || serverOverall === 'maintenance') {
      setOverall(
        'maintenance',
        maintained.length === total ? 'Under maintenance' : 'Some services are under maintenance',
      );
      setLine(metaLine!, checkedParts('Checked '));
    } else if (stale.length > 0 || serverOverall === 'stale') {
      if (stale.length === total) {
        setOverall('stale', 'No recent checks');
        setLine(metaLine!, checkedParts('Last checked '));
      } else {
        setOverall('stale', 'Some services weren’t checked recently');
        const oldest = earliest(
          payload.components
            .filter((entry) => states.get(entry.id) === 'stale')
            .map((entry) => entry.lastCheckedAt),
        );
        const gap = oldest ? duration(since(oldest)) : null;
        setLine(metaLine!, oldest && gap ? ['Not checked for ', timeNode(oldest, gap)] : null);
      }
    } else {
      setOverall('ok', 'All checks passed');
      setLine(metaLine!, checkedParts('Checked '));
    }

    renderNotice(payload, now);
  }

  async function refresh(): Promise<void> {
    // Age what is on screen before waiting on the network.
    if (shown) render();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(STATUS_URL, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload = parsePayload(await response.json());
      if (!payload) throw new Error('unreadable status');
      accept(payload);
    } catch {
      // Keep the last good answer and let it age; with none, show unavailable.
    } finally {
      window.clearTimeout(timeout);
    }
    render();
  }

  function schedule(): void {
    window.clearTimeout(refreshTimer);
    if (document.visibilityState !== 'visible') return;
    refreshTimer = window.setTimeout(() => {
      refresh()
        .finally(schedule)
        .catch(() => {});
    }, STATUS_REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh()
        .finally(schedule)
        .catch(() => {});
    } else {
      window.clearTimeout(refreshTimer);
    }
  });

  refresh()
    .finally(schedule)
    .catch(() => {});
})();
