(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const profileForm = document.getElementById('profileForm');
  const profileSelect = document.getElementById('profileSelect');
  const proxySelect = document.getElementById('proxySelect');
  const proxyList = document.getElementById('proxyList');
  const logConsole = document.getElementById('logConsole');
  const toast = document.getElementById('toast');
  const state = {
    profiles: [],
    proxies: [],
    selectedProfileId: null
  };

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Request failed with ${response.status}`);
    }

    return data;
  }

  function formObject(form) {
    const data = new FormData(form);
    const object = {};

    for (const [key, value] of data.entries()) {
      object[key] = value;
    }

    return object;
  }

  function profileDraftIsComplete() {
    return Boolean(
      profileForm.elements.name.value.trim() &&
      profileForm.elements.host.value.trim() &&
      profileForm.elements.username.value.trim() &&
      profileForm.elements.port.value.trim()
    );
  }

  async function saveCurrentProfile({ requireComplete = false } = {}) {
    const existingId = Number(profileForm.elements.id.value || state.selectedProfileId);

    if (!profileDraftIsComplete()) {
      if (existingId) {
        return existingId;
      }

      if (requireComplete) {
        throw new Error('Fill profile name, server, port, and username first');
      }

      return null;
    }

    const body = formObject(profileForm);
    const id = body.id ? Number(body.id) : null;
    const data = await api(id ? `/api/profiles/${id}` : '/api/profiles', {
      method: id ? 'PUT' : 'POST',
      body
    });

    state.selectedProfileId = data.profile.id;
    await refreshProfiles();
    return data.profile.id;
  }

  function setText(id, value) {
    const element = document.getElementById(id);

    if (element) {
      element.textContent = value;
    }
  }

  function formatUptime(seconds) {
    const total = Number(seconds || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    if (days) {
      return `${days}d ${hours}h`;
    }

    if (hours) {
      return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
  }

  function renderState(nextState) {
    const status = nextState.status || 'offline';
    const badge = document.getElementById('connectionBadge');
    badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    badge.className = `status-pill ${status}`;
    setText('statusTitle', status === 'online' ? 'Online' : status === 'connecting' ? 'Connecting' : 'Offline');
    setText('metricServer', nextState.host ? `${nextState.host}:${nextState.port}` : '--');
    setText('metricUsername', nextState.displayName || nextState.username || '--');
    setText('metricDimension', nextState.dimension || '--');
    setText('metricPing', Number.isFinite(nextState.ping) ? `${nextState.ping}ms` : '--');
    setText('metricTps', Number.isFinite(nextState.tps) ? String(nextState.tps) : '--');
    setText('metricUptime', formatUptime(nextState.uptimeSeconds));
    setText('metricMemory', Number.isFinite(nextState.memoryMb) ? `${nextState.memoryMb} MB` : '--');
    setText('metricCpu', Number.isFinite(nextState.cpuPercent) ? `${nextState.cpuPercent}%` : '--');
    setText('lastDisconnect', nextState.lastDisconnectReason || 'None');
  }

  function renderProfiles() {
    profileSelect.innerHTML = '';

    if (!state.profiles.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No profiles';
      profileSelect.append(option);
      clearProfileForm();
      return;
    }

    for (const profile of state.profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name;
      profileSelect.append(option);
    }

    const selected = state.profiles.find((profile) => profile.id === state.selectedProfileId) || state.profiles[0];
    state.selectedProfileId = selected.id;
    profileSelect.value = selected.id;
    fillProfileForm(selected);
  }

  function renderProxies() {
    proxySelect.innerHTML = '<option value="">None</option>';
    proxyList.innerHTML = '';

    for (const proxy of state.proxies) {
      const option = document.createElement('option');
      option.value = proxy.id;
      option.textContent = `${proxy.type}://${proxy.host}:${proxy.port}`;
      proxySelect.append(option);

      const row = document.createElement('div');
      row.className = 'proxy-row';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(proxy.name)}</strong>
          <span>${escapeHtml(proxy.type)}://${escapeHtml(proxy.host)}:${proxy.port} failures ${proxy.failureCount}</span>
        </div>
        <button class="btn btn-ghost danger-text" type="button" data-delete-proxy="${proxy.id}">Delete</button>
      `;
      proxyList.append(row);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function clearProfileForm() {
    profileForm.reset();
    profileForm.elements.id.value = '';
    profileForm.elements.port.value = 25565;
    profileForm.elements.version.value = 'auto';
    profileForm.elements.reconnectDelayMs.value = 15000;
    profileForm.elements.spawnTimeoutMs.value = 45000;
    profileForm.elements.loginTimeoutMs.value = 15000;
    profileForm.elements.reconnectEveryHours.value = 0;
    profileForm.elements.afkConfigJson.value = '{}';
    state.selectedProfileId = null;
  }

  function fillProfileForm(profile) {
    profileForm.elements.id.value = profile.id || '';
    profileForm.elements.name.value = profile.name || '';
    profileForm.elements.host.value = profile.host || '';
    profileForm.elements.port.value = profile.port || 25565;
    profileForm.elements.username.value = profile.username || '';
    profileForm.elements.authMode.value = profile.authMode || 'offline';
    profileForm.elements.minecraftPassword.value = '';
    profileForm.elements.serverAuthPassword.value = '';
    profileForm.elements.version.value = profile.version || 'auto';
    profileForm.elements.versionFallbacks.value = (profile.versionFallbacks || []).join('\n');
    profileForm.elements.reconnectDelayMs.value = profile.reconnectDelayMs || 15000;
    profileForm.elements.spawnTimeoutMs.value = profile.spawnTimeoutMs || 45000;
    profileForm.elements.loginTimeoutMs.value = profile.loginTimeoutMs || 15000;
    profileForm.elements.proxyMode.value = profile.proxyMode || 'disabled';
    profileForm.elements.proxyId.value = profile.proxyId || '';
    profileForm.elements.afkProfile.value = profile.afkProfile || 'human-like';
    profileForm.elements.scheduledStart.value = profile.scheduledStart || '';
    profileForm.elements.dailyRestartTime.value = profile.dailyRestartTime || '';
    profileForm.elements.reconnectEveryHours.value = profile.reconnectEveryHours || 0;
    profileForm.elements.afkConfigJson.value = JSON.stringify(profile.afkConfig || {}, null, 2);
    profileForm.elements.timedMessages.value = (profile.timedMessages || []).join('\n');
    profileForm.elements.macroCommands.value = (profile.macroCommands || []).join('\n');
  }

  function appendLog(entry) {
    const line = document.createElement('div');
    const time = new Date(entry.createdAt || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    line.className = 'log-line';
    line.innerHTML = `
      <span class="time">${time}</span>
      <span class="level-${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span>
      <span class="type">${escapeHtml(entry.type)}</span>
      <span class="message">${escapeHtml(entry.message)}</span>
    `;
    logConsole.append(line);

    while (logConsole.children.length > 500) {
      logConsole.firstElementChild.remove();
    }

    logConsole.scrollTop = logConsole.scrollHeight;
  }

  async function refreshProfiles() {
    const data = await api('/api/profiles');
    state.profiles = data.profiles;
    renderProfiles();
  }

  async function refreshProxies() {
    const data = await api('/api/proxies');
    state.proxies = data.proxies;
    renderProxies();
  }

  async function refreshState() {
    const data = await api('/api/state');
    renderState(data.state);
  }

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      button.disabled = true;

      try {
        if (action === 'start') {
          const profileId = await saveCurrentProfile({ requireComplete: true });
          await api('/api/bot/start', { method: 'POST', body: { profileId } });
          showToast('Profile saved and start requested');
        } else if (action === 'stop') {
          await api('/api/bot/stop', { method: 'POST' });
          showToast('Stop requested');
        } else if (action === 'restart') {
          const profileId = await saveCurrentProfile({ requireComplete: true });
          await api('/api/bot/restart', { method: 'POST', body: { profileId } });
          showToast('Profile saved and restart requested');
        } else if (action === 'reconnect') {
          const profileId = await saveCurrentProfile({ requireComplete: true });
          await api('/api/bot/reconnect', { method: 'POST', body: { profileId } });
          showToast('Profile saved and reconnect requested');
        } else if (action === 'kill' && window.confirm('Kill the Node process now?')) {
          try {
            await api('/api/bot/kill', { method: 'POST' });
          } catch {
            // The server can exit before the browser receives the response.
          }

          showToast('Process exit requested');
        }
      } catch (error) {
        showToast(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });

  profileSelect.addEventListener('change', () => {
    const id = Number(profileSelect.value);
    const profile = state.profiles.find((item) => item.id === id);

    if (profile) {
      state.selectedProfileId = profile.id;
      fillProfileForm(profile);
    }
  });

  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      await saveCurrentProfile({ requireComplete: true });
      showToast('Profile saved');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('newProfileBtn').addEventListener('click', () => {
    clearProfileForm();
    profileForm.elements.name.focus();
  });

  document.getElementById('duplicateProfileBtn').addEventListener('click', async () => {
    const id = Number(profileForm.elements.id.value);

    if (!id) {
      showToast('Select a profile first');
      return;
    }

    try {
      const data = await api(`/api/profiles/${id}/duplicate`, { method: 'POST' });
      state.selectedProfileId = data.profile.id;
      await refreshProfiles();
      showToast('Profile duplicated');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('deleteProfileBtn').addEventListener('click', async () => {
    const id = Number(profileForm.elements.id.value);

    if (!id || !window.confirm('Delete this profile?')) {
      return;
    }

    try {
      await api(`/api/profiles/${id}`, { method: 'DELETE' });
      state.selectedProfileId = null;
      await refreshProfiles();
      showToast('Profile deleted');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.message;

    try {
      await api('/api/chat/send', { method: 'POST', body: { message: input.value } });
      input.value = '';
      showToast('Message sent');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('commandForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.command;

    try {
      await api('/api/command/send', { method: 'POST', body: { command: input.value } });
      input.value = '';
      showToast('Command sent');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('runMacroBtn').addEventListener('click', async () => {
    try {
      await api('/api/macro/run', {
        method: 'POST',
        body: { commands: profileForm.elements.macroCommands.value }
      });
      showToast('Macro started');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('proxyImportForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      const data = await api('/api/proxies/import', {
        method: 'POST',
        body: { proxies: event.currentTarget.elements.proxies.value }
      });
      state.proxies = data.proxies;
      renderProxies();
      await refreshProfiles();
      showToast(`Imported ${data.imported} proxies`);
    } catch (error) {
      showToast(error.message);
    }
  });

  proxyList.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-delete-proxy]');

    if (!button || !window.confirm('Delete this proxy?')) {
      return;
    }

    try {
      await api(`/api/proxies/${button.dataset.deleteProxy}`, { method: 'DELETE' });
      await refreshProxies();
      await refreshProfiles();
      showToast('Proxy deleted');
    } catch (error) {
      showToast(error.message);
    }
  });

  document.getElementById('clearConsoleBtn').addEventListener('click', () => {
    logConsole.innerHTML = '';
  });

  const socket = io();
  socket.on('state', renderState);
  socket.on('log', appendLog);
  socket.on('logs:bulk', (logs) => {
    logConsole.innerHTML = '';
    logs.forEach(appendLog);
  });
  socket.on('connect_error', () => {
    showToast('Live socket disconnected');
  });

  refreshProxies()
    .then(refreshProfiles)
    .then(refreshState)
    .catch((error) => showToast(error.message));
})();
