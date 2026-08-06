document.addEventListener('DOMContentLoaded', function() {
  const callBtn = document.getElementById('callBtn');
  const statusDiv = document.getElementById('status');
  const clientsSpan = document.getElementById('clientsCount');
  const nameInput = document.getElementById('name');
  const serverIPInput = document.getElementById('serverIP');
  const checkBtn = document.getElementById('checkBtn');
  const currentVersionSpan = document.getElementById('currentVersion');
  const updateStatusDiv = document.getElementById('updateStatus');

  const currentVersion = chrome.runtime.getManifest().version;
  currentVersionSpan.textContent = currentVersion;

  let SERVER_URL = '';

  chrome.storage.local.get(['serverIP', 'clientName'], function(result) {
    if (result.serverIP) {
      serverIPInput.value = result.serverIP;
      SERVER_URL = `http://${result.serverIP}:${SERVER_PORT}`;
    } else {
      statusDiv.textContent = 'Введите IP сервера выше';
      statusDiv.className = '';
    }
    if (result.clientName) {
      nameInput.value = result.clientName;
    }
    checkStatus();
    autoCheckForUpdates();
  });

  nameInput.addEventListener('change', function() {
    const name = nameInput.value.trim() || 'Кто-то';
    chrome.storage.local.set({ clientName: name }, function() {
      chrome.runtime.sendMessage({
        action: 'updateName',
        data: { name: name }
      });
    });
    nameInput.value = name;
  });

  serverIPInput.addEventListener('change', function() {
    const ip = serverIPInput.value.trim();
    if (!ip) return;
    chrome.storage.local.set({ serverIP: ip }, function() {
      chrome.runtime.sendMessage({
        action: 'updateServerURL',
        data: { serverIP: ip }
      });
      SERVER_URL = `http://${ip}:${SERVER_PORT}`;
      checkStatus();
    });
  });

  checkBtn.addEventListener('click', checkForUpdates);

  document.getElementById('repoBtn').addEventListener('click', function() {
    chrome.tabs.create({ url: `https://github.com/${getRepo()}` });
  });

  function autoCheckForUpdates() {
    chrome.storage.local.get(['lastVersionCheck'], function(result) {
      const last = result.lastVersionCheck || 0;
      if (Date.now() - last > 30 * 60 * 1000) {
        checkForUpdates();
      }
    });
  }

  function getRepo() {
    // Репозиторий задан в config.js (DEFAULT_GITHUB_REPO)
    return DEFAULT_GITHUB_REPO;
  }

  function checkForUpdates() {
    const repo = getRepo();
    checkBtn.disabled = true;
    updateStatusDiv.textContent = 'Проверяем обновления...';
    updateStatusDiv.className = '';

    // GitHub API отдаёт свежие данные и не кэшируется CDN как raw.githubusercontent
    fetch(`https://api.github.com/repos/${repo}/contents/version.txt`, {
      headers: { 'Accept': 'application/vnd.github.v3.raw' },
      cache: 'no-store'
    })
      .then(response => {
        if (!response.ok) throw new Error('Репозиторий не найден');
        return response.text();
      })
      .then(text => {
        const latest = text.trim();
        chrome.storage.local.set({ lastVersionCheck: Date.now() });
        renderUpdateResult(repo, latest);
      })
      .catch(() => {
        updateStatusDiv.textContent = '⚠️ Не удалось проверить: проверьте репозиторий';
        updateStatusDiv.className = 'status-error';
      })
      .finally(() => {
        checkBtn.disabled = false;
      });
  }

  function renderUpdateResult(repo, latest) {
    updateStatusDiv.innerHTML = '';
    const cmp = compareVersions(latest, currentVersion);

    if (cmp > 0) {
      updateStatusDiv.className = 'status-warn';
      updateStatusDiv.appendChild(document.createTextNode(`🔔 Доступна версия ${latest}! `));

      const link = document.createElement('a');
      link.href = `https://github.com/${repo}/releases`;
      link.target = '_blank';
      link.textContent = 'Открыть GitHub';
      updateStatusDiv.appendChild(link);
    } else if (cmp === 0) {
      updateStatusDiv.className = 'status-ok';
      updateStatusDiv.textContent = '✅ У вас актуальная версия';
    } else {
      updateStatusDiv.className = 'status-ok';
      updateStatusDiv.textContent = `✅ Ваша версия (${currentVersion}) новее, чем на GitHub (${latest})`;
    }
  }

  function compareVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(Number);
    const pb = String(b).replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  function checkStatus() {
    if (!SERVER_URL) {
      statusDiv.textContent = 'Введите IP сервера выше';
      statusDiv.className = '';
      return;
    }
    fetch(`${SERVER_URL}/status`)
      .then(response => response.json())
      .then(data => {
        statusDiv.textContent = `✅ Сервер активен (${data.clients} клиентов)`;
        statusDiv.className = 'status-ok';
        clientsSpan.textContent = `👥 В сети: ${data.clients}`;
      })
      .catch(() => {
        statusDiv.textContent = '⚠️ Сервер недоступен!';
        statusDiv.className = 'status-error';
      });
  }

  callBtn.addEventListener('click', function() {
    callBtn.disabled = true;
    statusDiv.textContent = '📨 Отправляем...';
    statusDiv.className = '';

    const messages = [
      '🎉 Перекур объявлен!',
      '🏃 Все на перекур!'
    ];
    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    
    chrome.storage.local.get(['clientName'], (result) => {
      const name = result.clientName || 'Кто-то';
      
      chrome.runtime.sendMessage({
        action: 'createPoll',
        data: {
          message: randomMessage,
          sender: name
        }
      }, function(response) {
        if (response && response.success) {
          statusDiv.textContent = '✅ Опрос создан!';
          statusDiv.className = 'status-ok';
        } else {
          statusDiv.textContent = '❌ Ошибка: ' + (response?.error || 'неизвестная');
          statusDiv.className = 'status-error';
        }
        
        callBtn.disabled = false;
        setTimeout(() => {
          if (statusDiv.className !== 'status-error') {
            statusDiv.textContent = 'Готов к работе';
            statusDiv.className = '';
          }
        }, 3000);
      });
    });
  });

  setInterval(checkStatus, 10000);
});
