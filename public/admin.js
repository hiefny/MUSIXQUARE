const root = document.querySelector('.admin-shell');
const loginPanel = document.querySelector('[data-login-panel]');
const dashboard = document.querySelector('[data-dashboard]');
const loginForm = document.querySelector('[data-login-form]');
const loginStatus = document.querySelector('[data-login-status]');
const cardsEl = document.querySelector('[data-metric-cards]');
const hourlyEl = document.querySelector('[data-hourly-chart]');
const dailyEl = document.querySelector('[data-daily-list]');
const signalEl = document.querySelector('[data-signal-grid]');
const updatedAtEl = document.querySelector('[data-updated-at]');
const refreshBtn = document.querySelector('[data-refresh]');
const logoutBtn = document.querySelector('[data-logout]');

const formatter = new Intl.NumberFormat();

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
  loginPanel.hidden = false;
  dashboard.hidden = true;
  setStatus(message);
}

function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

function formatDelta(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value === 0) return 'same as previous 24h';
  return `${value > 0 ? '+' : ''}${value}% vs previous 24h`;
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
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

function dayLabel(iso) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
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

async function loadMetrics() {
  updatedAtEl.textContent = 'Refreshing...';
  const metrics = await fetchJson('/api/admin/metrics');
  showDashboard();
  renderCards(metrics.cards || []);
  renderHourlyChart(metrics.summary?.hourly || []);
  renderDailyList(metrics.summary?.daily || []);
  renderSignals(metrics.summary || {});
  updatedAtEl.textContent = `Updated ${new Date(metrics.generatedAt).toLocaleString()}`;
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
    await loadMetrics();
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
    await loadMetrics();
  } catch (error) {
    setStatus(error.message === 'INVALID_PASSWORD' ? 'Invalid password.' : error.message, true);
  }
});

refreshBtn?.addEventListener('click', () => {
  loadMetrics().catch((error) => {
    updatedAtEl.textContent = error.message || 'Refresh failed.';
  });
});

logoutBtn?.addEventListener('click', async () => {
  await fetchJson('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

init();
