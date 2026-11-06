import { api } from './net.js';
import { toast } from './ui.js';

const dom = {};
let timer = null;
let loading = false;
let initialized = false;

const formatUptime = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const rows = (stats) => {
  const resources = stats.resources || {};
  const memory = stats.process || {};
  const audio = stats.audio || {};
  return [
    ['Server memory', `${memory.rssMb ?? 0} MB`],
    ['Heap in use', `${memory.heapMb ?? 0} MB`],
    ['Live browsers', `${resources.liveBrowsers ?? 0} / ${resources.maxLiveBrowsers ?? 1}`],
    ['Live pages', `${resources.liveTabs ?? 0} / ${resources.maxLiveTabs ?? 1}`],
    ['Sessions', `${resources.sessions ?? 0}`],
    ['Audio streams', `${audio.streams ?? 0}`],
    ['Uptime', formatUptime(stats.uptime)],
  ];
};

const render = (stats) => {
  if (!dom.grid) return;
  dom.grid.innerHTML = '';
  for (const [label, value] of rows(stats)) {
    const row = document.createElement('div');
    row.className = 'system-row';
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    row.append(term, detail);
    dom.grid.appendChild(row);
  }
  if (dom.note) {
    const idle = stats.limits?.browserIdleSeconds;
    dom.note.textContent = idle
      ? `Browsers with no connected visitor are released after ${idle}s. Releasing now keeps tabs, history and sign-in.`
      : 'Browsers with no connected visitor are released automatically.';
  }
};

const refresh = async () => {
  if (loading || !dom.modal || dom.modal.hidden) return;
  loading = true;
  try {
    render(await api.get('/api/stats'));
  } catch (error) {
    if (dom.note) dom.note.textContent = error?.message || 'Could not read server stats';
  } finally {
    loading = false;
  }
};

const startPolling = () => {
  clearInterval(timer);
  timer = setInterval(refresh, 3000);
  if (timer.unref) timer.unref();
};

const stopPolling = () => {
  clearInterval(timer);
  timer = null;
};

const reclaim = async () => {
  if (!dom.reclaim) return;
  dom.reclaim.disabled = true;
  try {
    const result = await api.post('/api/reclaim');
    const released = Number(result?.released) || 0;
    toast(
      released ? `Released ${released} idle browser${released === 1 ? '' : 's'}` : 'Nothing idle to release',
      { tone: released ? 'success' : 'info' },
    );
    await refresh();
  } catch (error) {
    toast(error?.message || 'Could not release browsers', { tone: 'warn' });
  } finally {
    dom.reclaim.disabled = false;
  }
};

export const initSystem = () => {
  if (initialized) return;
  initialized = true;
  dom.modal = document.getElementById('system-modal');
  dom.grid = document.getElementById('system-grid');
  dom.close = document.getElementById('system-close');
  dom.reclaim = document.getElementById('system-reclaim');
  dom.note = document.getElementById('system-note');
  if (!dom.modal) return;

  dom.close?.addEventListener('click', closeSystem);
  dom.modal.addEventListener('pointerdown', (event) => {
    if (event.target === dom.modal) closeSystem();
  });
  dom.reclaim?.addEventListener('click', reclaim);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.modal.hidden) closeSystem();
  });
};

export const openSystem = () => {
  if (!initialized) initSystem();
  if (!dom.modal) return;
  dom.modal.hidden = false;
  refresh();
  startPolling();
};

export const closeSystem = () => {
  stopPolling();
  if (dom.modal) dom.modal.hidden = true;
};
