import { audioEngine } from './audio.js';
import { api } from './net.js';
import { orderedTabs, state } from './store.js';
import { toast } from './ui.js';
import { viewportStats } from './viewport.js';

const dom = {};
let statsTimer = null;
let liveTimer = null;
let loading = false;
let initialized = false;
let lastStats = null;

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
  const resources = stats?.resources || {};
  const memory = stats?.process || {};
  const audio = stats?.audio || {};
  return [
    ['Server memory', `${memory.rssMb ?? 0} MB`],
    ['Heap in use', `${memory.heapMb ?? 0} MB`],
    ['Live browsers', `${resources.liveBrowsers ?? 0} / ${resources.maxLiveBrowsers ?? 1}`],
    ['Live pages', `${resources.liveTabs ?? 0} / ${resources.maxLiveTabs ?? 1}`],
    ['Sessions', `${resources.sessions ?? 0}`],
    ['Audio streams', `${audio.streams ?? 0}`],
    ['Uptime', formatUptime(stats?.uptime)],
  ];
};

const render = (stats) => {
  lastStats = stats || lastStats;
  if (!dom.grid) return;
  dom.grid.innerHTML = '';
  for (const [label, value] of rows(lastStats || {})) {
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
    const idle = lastStats?.limits?.browserIdleSeconds;
    dom.note.textContent = idle
      ? `Browsers with no connected visitor are released after ${idle}s. Releasing now keeps tabs, history and sign-in.`
      : 'Browsers with no connected visitor are released automatically.';
  }
  renderLive();
};

const metric = (label, value) => `
  <div class="perf-metric"><strong>${value}</strong><span>${label}</span></div>
`;

/** Viewer-side numbers, sampled once a second so they mean something. */
const renderLive = () => {
  if (!dom.strip) return;
  const stats = viewportStats();
  const audio = audioEngine.snapshot();
  const tabs = orderedTabs().length;
  const dropped = stats.frames ? `${stats.dropped}` : '0';
  dom.strip.innerHTML = [
    metric('FPS', stats.fps ? `${stats.fps}` : '—'),
    metric('Frame decode', stats.painted ? `${stats.decodeMs.toFixed(1)} ms` : '—'),
    metric('Dropped frames', dropped),
    metric('Stream lag', stats.lagMs != null ? `${stats.lagMs} ms` : '—'),
    metric('Stream rate', stats.kbps ? `${stats.kbps} kbps` : '—'),
    metric('Round trip', state.latency != null ? `${state.latency} ms` : '—'),
    metric('Audio buffer', audio.available ? `${audio.latencyMs ?? 0} ms` : '—'),
    metric('Audio path', audio.available ? (audio.transport === 'pcm' ? 'PCM' : 'Opus') : '—'),
    metric('Canvas', stats.width ? `${stats.width}×${stats.height}` : '—'),
    metric('Open tabs', `${tabs}`),
  ].join('');
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
  clearInterval(statsTimer);
  clearInterval(liveTimer);
  statsTimer = setInterval(refresh, 3000);
  liveTimer = setInterval(renderLive, 1000);
  if (statsTimer.unref) statsTimer.unref();
  if (liveTimer.unref) liveTimer.unref();
};

const stopPolling = () => {
  clearInterval(statsTimer);
  clearInterval(liveTimer);
  statsTimer = null;
  liveTimer = null;
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
  dom.strip = document.getElementById('perf-strip');
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
  document.addEventListener('velocity:open-perf', () => openSystem());
};

export const openSystem = () => {
  if (!initialized) initSystem();
  if (!dom.modal) return;
  dom.modal.hidden = false;
  renderLive();
  refresh();
  startPolling();
};

export const closeSystem = () => {
  stopPolling();
  if (dom.modal) dom.modal.hidden = true;
};
