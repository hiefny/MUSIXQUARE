const root = document.querySelector('.admin-shell');
const loginPanel = document.querySelector('[data-login-panel]');
const dashboard = document.querySelector('[data-dashboard]');
const dashboardTitle = document.querySelector('[data-dashboard-title]');
const loginForm = document.querySelector('[data-login-form]');
const loginStatus = document.querySelector('[data-login-status]');
const cardsEl = document.querySelector('[data-metric-cards]');
const hourlyEl = document.querySelector('[data-hourly-chart]');
const dailyEl = document.querySelector('[data-daily-list]');
const monthlyEl = document.querySelector('[data-monthly-chart]');
const signalEl = document.querySelector('[data-signal-grid]');
const adminTabs = [...document.querySelectorAll('[data-admin-tab]')];
const adminViews = [...document.querySelectorAll('[data-admin-view]')];
const articleListEl = document.querySelector('[data-article-list]');
const articleStatusEl = document.querySelector('[data-article-status]');
const announcementForm = document.querySelector('[data-announcement-form]');
const announcementMessageEl = document.querySelector('[data-announcement-message]');
const announcementEnabledEl = document.querySelector('[data-announcement-enabled]');
const announcementExpiresEl = document.querySelector('[data-announcement-expires]');
const announcementStatusEl = document.querySelector('[data-announcement-status]');
const announcementPreviewEl = document.querySelector('[data-announcement-preview]');
const announcementClearBtn = document.querySelector('[data-announcement-clear]');
const announcementHistoryStatusEl = document.querySelector('[data-announcement-history-status]');
const announcementHistoryListEl = document.querySelector('[data-announcement-history-list]');
const updatedAtEl = document.querySelector('[data-updated-at]');
const refreshBtn = document.querySelector('[data-refresh]');
const logoutBtn = document.querySelector('[data-logout]');

const formatter = new Intl.NumberFormat();
let currentAdminTab = 'operations';
let articlesLoaded = false;
let announcementLoaded = false;

function setStatus(message, isError = false) {
  if (!loginStatus) return;
  loginStatus.textContent = message || '';
  loginStatus.classList.toggle('is-error', isError);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

function showLogin(message = '') {
  root?.classList.add('is-login');
  root?.classList.remove('is-dashboard');
  loginPanel.hidden = false;
  dashboard.hidden = true;
  setStatus(message);
}

function showDashboard() {
  root?.classList.remove('is-login');
  root?.classList.add('is-dashboard');
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function formatDelta(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value === 0) return 'same as previous 24h';
  return `${value > 0 ? '+' : ''}${value}% vs previous 24h`;
}

function formatArticleDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatAdminDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function toDatetimeLocalValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function parseAnnouncementExpiresValue(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    const [, year, month, day, hour = '23', minute = '59'] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
    );
    if (
      date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day) &&
      date.getHours() === Number(hour) &&
      date.getMinutes() === Number(minute)
    ) {
      return date.toISOString();
    }
  }
  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();
  throw new Error('Use YYYY-MM-DD HH:MM for Expires.');
}

function formatAnnouncementAction(action) {
  if (action === 'published') return 'Published';
  if (action === 'disabled') return 'Disabled';
  if (action === 'cleared') return 'Cleared';
  return 'Updated';
}

function announcementTitle(tab) {
  if (tab === 'articles') return 'Articles';
  if (tab === 'announcements') return 'Announcements';
  return 'Operations';
}

function setActiveTab(tab) {
  currentAdminTab = tab;
  adminTabs.forEach((button) => {
    const active = button.dataset.adminTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  adminViews.forEach((view) => {
    const active = view.dataset.adminView === tab;
    view.hidden = !active;
    view.classList.toggle('is-active', active);
  });
  if (dashboardTitle) dashboardTitle.textContent = announcementTitle(tab);
}

function renderCards(cards) {
  cardsEl.replaceChildren(
    ...cards.map((card) => {
      const article = document.createElement('article');
      article.className = 'metric-card';
      const value =
        typeof card.value === 'number' ? formatter.format(card.value) : String(card.value);
      article.innerHTML = `
        <span>${card.label}</span>
        <strong>${value}</strong>
        <small>${formatDelta(card.delta)}</small>
      `;
      return article;
    }),
  );
}

function hourLabel(iso) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function dayLabel(iso) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

function compactDayLabel(iso) {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function renderHourlyChart(hourly) {
  const max = Math.max(
    1,
    ...hourly.map((bucket) => bucket.events.room_opened + bucket.events.guest_joined),
  );
  hourlyEl.replaceChildren(
    ...hourly.map((bucket) => {
      const rooms = bucket.events.room_opened || 0;
      const guests = bucket.events.guest_joined || 0;
      const total = rooms + guests;
      const row = document.createElement('div');
      row.className = 'chart-row';
      row.innerHTML = `
        <span class="chart-label">${hourLabel(bucket.start)}</span>
        <span class="chart-track">
          <span class="bar rooms" style="width:${(rooms / max) * 100}%"></span>
          <span class="bar guests" style="width:${(guests / max) * 100}%"></span>
        </span>
        <span class="chart-value">${formatter.format(total)}</span>
      `;
      return row;
    }),
  );
}

function renderDailyList(daily) {
  const max = Math.max(
    1,
    ...daily.map((bucket) => bucket.events.room_opened + bucket.events.guest_joined),
  );
  dailyEl.replaceChildren(
    ...daily.map((bucket) => {
      const rooms = bucket.events.room_opened || 0;
      const guests = bucket.events.guest_joined || 0;
      const item = document.createElement('article');
      item.className = 'trend-item';
      item.innerHTML = `
        <div>
          <span>${dayLabel(bucket.start)}</span>
          <strong>${formatter.format(rooms)} rooms</strong>
          <small>${formatter.format(guests)} guest joins</small>
        </div>
        <div class="trend-bar" aria-hidden="true">
          <span style="width:${((rooms + guests) / max) * 100}%"></span>
        </div>
      `;
      return item;
    }),
  );
}

function renderMonthlyChart(daily30) {
  if (!monthlyEl) return;
  const totals = daily30.map((bucket) => {
    const rooms = bucket.events.room_opened || 0;
    const guests = bucket.events.guest_joined || 0;
    return rooms + guests;
  });
  const max = Math.max(1, ...totals);
  const mid = Math.ceil(max / 2);
  const ticks = max > 1 ? [max, mid, 0] : [1, 0];

  const axis = document.createElement('div');
  axis.className = 'spectrum-axis';
  axis.setAttribute('aria-hidden', 'true');
  axis.innerHTML = ticks.map((tick) => `<span>${formatter.format(tick)}</span>`).join('');

  const bars = document.createElement('div');
  bars.className = 'spectrum-bars';
  bars.setAttribute('role', 'list');

  daily30.forEach((bucket, index) => {
    const rooms = bucket.events.room_opened || 0;
    const guests = bucket.events.guest_joined || 0;
    const total = rooms + guests;
    const label = compactDayLabel(bucket.start);
    const bar = document.createElement('div');
    bar.className = 'spectrum-bar';
    bar.setAttribute('role', 'listitem');
    bar.setAttribute(
      'aria-label',
      `${label}: ${formatter.format(total)} total activity, ${formatter.format(rooms)} rooms, ${formatter.format(guests)} guest joins`,
    );
    bar.innerHTML = `
      <span class="spectrum-column" style="height:${Math.max(3, (total / max) * 100)}%">
        <span class="spectrum-fill rooms" style="height:${total ? (rooms / total) * 100 : 0}%"></span>
        <span class="spectrum-fill guests" style="height:${total ? (guests / total) * 100 : 0}%"></span>
      </span>
      <span class="spectrum-date">${index % 5 === 0 || index === daily30.length - 1 ? label : ''}</span>
    `;
    bars.appendChild(bar);
  });

  monthlyEl.replaceChildren(axis, bars);
}

function renderSignals(summary) {
  const last24 = summary.last24 || {};
  const signals = [
    ['Host missing', last24.guest_host_unavailable || 0],
    ['Password prompts', last24.guest_auth_pending || 0],
    ['Password failures', last24.guest_auth_failed || 0],
    ['Password timeouts', last24.guest_auth_timeout || 0],
    ['Host reconnects', last24.host_reconnected || 0],
  ];
  signalEl.replaceChildren(
    ...signals.map(([label, value]) => {
      const item = document.createElement('div');
      item.className = 'signal-item';
      item.innerHTML = `<span>${label}</span><strong>${formatter.format(value)}</strong>`;
      return item;
    }),
  );
}

async function loadMetrics(options = {}) {
  updatedAtEl.textContent = 'Refreshing...';
  const metrics = await fetchJson('/api/admin/metrics');
  showDashboard();
  if (options.activateOperations) setActiveTab('operations');
  renderCards(metrics.cards || []);
  renderHourlyChart(metrics.summary?.hourly || []);
  renderDailyList(metrics.summary?.daily || []);
  renderMonthlyChart(metrics.summary?.daily30 || []);
  renderSignals(metrics.summary || {});
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(metrics.generatedAt)}`;
  }
}

function renderArticleRow(article) {
  const item = document.createElement('article');
  item.className = 'article-item';
  item.classList.toggle('is-hidden', Boolean(article.hidden));

  const body = document.createElement('div');
  body.className = 'article-body';

  const title = document.createElement('strong');
  title.textContent = article.title || article.slug;

  const meta = document.createElement('span');
  const parts = [formatArticleDate(article.pubDate), article.slug, article.source].filter(Boolean);
  meta.textContent = parts.join(' · ');

  body.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'article-actions';

  const open = document.createElement('a');
  open.href = article.href || `/blog/${article.slug}`;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'Open';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'article-toggle';
  toggle.textContent = article.hidden ? 'Restore' : 'Hide';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    toggle.textContent = article.hidden ? 'Restoring...' : 'Hiding...';
    try {
      await fetchJson('/api/admin/articles/visibility', {
        method: 'POST',
        body: JSON.stringify({ slug: article.slug, hidden: !article.hidden }),
      });
      await loadArticles();
    } catch (error) {
      toggle.disabled = false;
      toggle.textContent = article.hidden ? 'Restore' : 'Hide';
      if (articleStatusEl) articleStatusEl.textContent = error.message || 'Article update failed.';
    }
  });

  actions.append(open, toggle);
  item.append(body, actions);
  return item;
}

function renderArticles(payload) {
  const articles = payload.articles || [];
  const visibleCount = articles.filter((article) => !article.hidden).length;
  const hiddenCount = articles.length - visibleCount;
  if (articleStatusEl) {
    articleStatusEl.textContent = `${formatter.format(visibleCount)} visible · ${formatter.format(hiddenCount)} hidden`;
  }
  if (!articleListEl) return;
  if (!articles.length) {
    const empty = document.createElement('p');
    empty.className = 'article-empty';
    empty.textContent = 'No articles found.';
    articleListEl.replaceChildren(empty);
    return;
  }
  articleListEl.replaceChildren(...articles.map(renderArticleRow));
}

async function loadArticles(options = {}) {
  if (articleStatusEl) articleStatusEl.textContent = 'Refreshing...';
  const payload = await fetchJson('/api/admin/articles');
  renderArticles(payload);
  articlesLoaded = true;
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
  }
}

function renderAnnouncement(payload) {
  const announcement = payload.announcement || {};
  const message = announcement.message || '';
  if (announcementMessageEl) announcementMessageEl.value = message;
  if (announcementEnabledEl) announcementEnabledEl.checked = Boolean(announcement.enabled);
  if (announcementExpiresEl)
    announcementExpiresEl.value = toDatetimeLocalValue(announcement.expiresAt);

  const statusParts = [];
  statusParts.push(announcement.enabled ? 'Enabled' : 'Disabled');
  if (announcement.expiresAt)
    statusParts.push(`expires ${formatAdminDateTime(announcement.expiresAt)}`);
  if (announcement.updatedAt)
    statusParts.push(`updated ${formatAdminDateTime(announcement.updatedAt)}`);
  if (announcementStatusEl) announcementStatusEl.textContent = statusParts.join(' - ');

  if (!announcementPreviewEl) return;
  if (!message) {
    announcementPreviewEl.hidden = true;
    announcementPreviewEl.textContent = '';
    return;
  }
  announcementPreviewEl.hidden = false;
  announcementPreviewEl.innerHTML = `
    <span>Notice - MUSIXQUARE</span>
    <p></p>
  `;
  announcementPreviewEl.querySelector('p').textContent = message;
}

function renderAnnouncementHistory(payload) {
  const history = Array.isArray(payload.history) ? payload.history : [];
  if (announcementHistoryStatusEl) {
    announcementHistoryStatusEl.textContent = history.length
      ? `${formatter.format(history.length)} records`
      : 'No records';
  }
  if (!announcementHistoryListEl) return;
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'announcement-history-empty';
    empty.textContent = 'No announcement history yet.';
    announcementHistoryListEl.replaceChildren(empty);
    return;
  }

  announcementHistoryListEl.replaceChildren(
    ...history.map((entry) => {
      const item = document.createElement('article');
      const action = String(entry.action || 'updated');
      item.className = `announcement-history-item action-${action}`;

      const meta = document.createElement('div');
      meta.className = 'announcement-history-meta';

      const actionEl = document.createElement('strong');
      actionEl.textContent = formatAnnouncementAction(action);
      meta.appendChild(actionEl);

      const timeEl = document.createElement('span');
      timeEl.textContent = formatAdminDateTime(entry.updatedAt);
      meta.appendChild(timeEl);

      if (entry.expiresAt) {
        const expiresEl = document.createElement('small');
        expiresEl.textContent = `expires ${formatAdminDateTime(entry.expiresAt)}`;
        meta.appendChild(expiresEl);
      }

      const body = document.createElement('p');
      body.textContent = entry.message || 'No message';

      item.append(meta, body);
      return item;
    }),
  );
}

async function loadAnnouncement(options = {}) {
  if (announcementStatusEl) announcementStatusEl.textContent = 'Refreshing...';
  const payload = await fetchJson('/api/admin/announcement');
  renderAnnouncement(payload);
  renderAnnouncementHistory(payload);
  announcementLoaded = true;
  if (options.updateTimestamp !== false) {
    updatedAtEl.textContent = `Updated ${formatAdminDateTime(payload.generatedAt)}`;
  }
}

async function saveAnnouncement({ clear = false } = {}) {
  const message = clear ? '' : String(announcementMessageEl?.value || '').trim();
  const enabled = clear ? false : Boolean(announcementEnabledEl?.checked);
  const expiresValue = clear ? '' : String(announcementExpiresEl?.value || '').trim();
  if (announcementStatusEl) announcementStatusEl.textContent = clear ? 'Clearing...' : 'Saving...';
  const payload = await fetchJson('/api/admin/announcement', {
    method: 'POST',
    body: JSON.stringify({
      message,
      enabled,
      expiresAt: parseAnnouncementExpiresValue(expiresValue),
    }),
  });
  renderAnnouncement(payload);
  renderAnnouncementHistory(payload);
  announcementLoaded = true;
  updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
}

async function refreshAllDashboardData() {
  const activeTab = currentAdminTab;
  updatedAtEl.textContent = 'Refreshing...';
  await Promise.all([
    loadMetrics({ updateTimestamp: false }),
    loadArticles({ updateTimestamp: false }),
    loadAnnouncement({ updateTimestamp: false }),
  ]);
  setActiveTab(activeTab);
  updatedAtEl.textContent = `Updated ${formatAdminDateTime(Date.now())}`;
}

async function init() {
  if (root?.dataset.adminConfigured !== 'true') {
    showLogin('Admin secrets are not configured yet.');
    return;
  }

  try {
    const session = await fetchJson('/api/admin/session');
    if (!session.authenticated) {
      showLogin();
      return;
    }
    await loadMetrics({ activateOperations: true });
  } catch (error) {
    showLogin(error.message || 'Failed to load admin session.');
  }
}

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  const password = String(form.get('password') || '');
  setStatus('Checking...');
  try {
    await fetchJson('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    loginForm.reset();
    await loadMetrics({ activateOperations: true });
  } catch (error) {
    setStatus(error.message === 'INVALID_PASSWORD' ? 'Invalid password.' : error.message, true);
  }
});

refreshBtn?.addEventListener('click', () => {
  refreshAllDashboardData().catch((error) => {
    updatedAtEl.textContent = error.message || 'Refresh failed.';
  });
});

adminTabs.forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.adminTab || 'operations';
    setActiveTab(tab);
    if (tab === 'articles' && !articlesLoaded) {
      loadArticles().catch((error) => {
        if (articleStatusEl) articleStatusEl.textContent = error.message || 'Refresh failed.';
      });
    }
    if (tab === 'announcements' && !announcementLoaded) {
      loadAnnouncement().catch((error) => {
        if (announcementStatusEl)
          announcementStatusEl.textContent = error.message || 'Refresh failed.';
      });
    }
  });
});

announcementForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  saveAnnouncement().catch((error) => {
    if (announcementStatusEl) announcementStatusEl.textContent = error.message || 'Save failed.';
  });
});

announcementClearBtn?.addEventListener('click', () => {
  saveAnnouncement({ clear: true }).catch((error) => {
    if (announcementStatusEl) announcementStatusEl.textContent = error.message || 'Clear failed.';
  });
});

logoutBtn?.addEventListener('click', async () => {
  await fetchJson('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

init();
