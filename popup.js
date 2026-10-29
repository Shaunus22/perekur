document.addEventListener('DOMContentLoaded', function() {
  const callBtn = document.getElementById('callBtn');
  const shrekBtn = document.getElementById('shrekBtn');
  const statusDiv = document.getElementById('status');
  const nameInput = document.getElementById('name');
  const serverIPInput = document.getElementById('serverIP');
  const serverTokenInput = document.getElementById('serverToken');
  const checkBtn = document.getElementById('checkBtn');
  const currentVersionSpan = document.getElementById('currentVersion');
  const updateStatusDiv = document.getElementById('updateStatus');
  const clientsList = document.getElementById('clientsList');
  const onlineHead = document.getElementById('onlineHead');
  const onlineCount = document.getElementById('onlineCount');
  const serverPill = document.getElementById('serverPill');
  const serverPillText = document.getElementById('serverPillText');
  const settingsBox = document.getElementById('settingsBox');

  const currentVersion = chrome.runtime.getManifest().version;
  currentVersionSpan.textContent = currentVersion;

  let SERVER_URL = '';
  let TOKEN = '';
  let clientsOpen = false;
  let myClientId = null;
  let statusResetTimer = null;

  // ---------- Вспомогательные ----------

  // Статусная строка: kind = '' | 'ok' | 'error' | 'warn'
  function setStatus(text, kind, autoResetMs) {
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
    statusDiv.textContent = text;
    statusDiv.className = kind ? 'status-' + kind : '';
    if (autoResetMs) {
      statusResetTimer = setTimeout(() => {
        statusResetTimer = null;
        if (statusDiv.className !== 'status-error') setStatus('Готов к работе', '');
      }, autoResetMs);
    }
  }

  function setPill(text, kind) {
    serverPillText.textContent = text;
    serverPill.className = 'pill' + (kind ? ' ' + kind : '');
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // ---------- Список онлайн ----------

  onlineHead.addEventListener('click', function() {
    clientsOpen = !clientsOpen;
    clientsList.classList.toggle('hidden', !clientsOpen);
    onlineHead.classList.toggle('open', clientsOpen);
    if (clientsOpen) loadOnlineList();
  });

  function loadOnlineList() {
    if (!SERVER_URL) {
      clientsList.innerHTML = '<div class="empty">сначала укажите сервер</div>';
      return;
    }
    fetch(`${SERVER_URL}/clients`, { headers: apiHeaders(TOKEN) })
      .then(response => response.json())
      .then(data => {
        const list = (data.clients || []).slice()
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
        onlineCount.textContent = list.length;
        if (!list.length) {
          clientsList.innerHTML = '<div class="empty">сейчас никого нет</div>';
          return;
        }
        clientsList.innerHTML = '';
        list.forEach(c => {
          const isMe = c.id === myClientId;
          const row = document.createElement('div');
          row.className = 'client' + (isMe ? ' me' : '');

          // Имя вставляем через textContent, а не innerHTML — чтобы спецсимволы
          // в имени не превратились в HTML
          const avatar = document.createElement('span');
          avatar.className = 'avatar';
          avatar.textContent = initials(c.name);

          const nameEl = document.createElement('span');
          nameEl.className = 'client-name';
          nameEl.textContent = c.name;

          row.appendChild(avatar);
          row.appendChild(nameEl);

          if (isMe) {
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = 'вы';
            row.appendChild(tag);
          }
          clientsList.appendChild(row);
        });
      })
      .catch(() => {
        clientsList.innerHTML = '<div class="empty">не удалось получить список</div>';
      });
  }

  // ---------- Стартовое состояние ----------

  chrome.storage.local.get(['serverIP', 'serverToken', 'clientName', 'clientId'], function(result) {
    myClientId = result.clientId || null;
    TOKEN = result.serverToken || '';
    if (TOKEN) serverTokenInput.value = TOKEN;
    if (result.serverIP) {
      serverIPInput.value = result.serverIP;
      SERVER_URL = normalizeServerURL(result.serverIP);
      // Старое разрешение могло быть отозвано пользователем или браузером
      requestHostPermission(SERVER_URL).then((ok) => {
        if (!ok) {
          setStatus('⚠️ Нет доступа к серверу — введите адрес заново', 'error');
          setPill('нет доступа', 'err');
          settingsBox.open = true;
          return;
        }
        checkStatus();
      });
    } else {
      setStatus('Укажите адрес сервера в настройках', 'warn');
      setPill('не настроен', 'warn');
      settingsBox.open = true;
    }
    if (result.clientName) {
      nameInput.value = result.clientName;
    }
    currentVersionSpan.parentElement.title = 'Установленная версия расширения';
    autoCheckForUpdates();
    // Разбудить фон: он сразу проверит опрос, итоги и шреков, не дожидаясь аларма
    chrome.runtime.sendMessage({ action: 'ping' }, () => {
      void chrome.runtime.lastError;
    });
  });

  // ---------- Настройки ----------

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
    SERVER_URL = normalizeServerURL(ip);
    requestHostPermission(SERVER_URL).then((ok) => {
      if (!ok) {
        setStatus('⚠️ Нет доступа к этому адресу сервера', 'error');
        return;
      }
      chrome.storage.local.set({ serverIP: ip }, function() {
        chrome.runtime.sendMessage({
          action: 'updateServerURL',
          data: { serverIP: ip }
        });
        checkStatus();
      });
    });
  });

  serverTokenInput.addEventListener('change', function() {
    TOKEN = serverTokenInput.value.trim();
    chrome.storage.local.set({ serverToken: TOKEN }, function() {
      chrome.runtime.sendMessage({
        action: 'updateServerURL',
        data: { token: TOKEN }
      });
      checkStatus();
    });
  });

  // Расширение больше не просит доступ ко всем сайтам сразу: при вводе адреса
  // запрашиваем разрешение только на этот сервер и его порт.
  function requestHostPermission(serverURL) {
    if (!serverURL || !chrome.permissions) return Promise.resolve(true);
    let origin;
    try {
      const u = new URL(serverURL);
      origin = u.protocol + '//' + u.host + '/*';
    } catch (e) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      chrome.permissions.contains({ origins: [origin] }, (has) => {
        if (has) {
          resolve(true);
          return;
        }
        chrome.permissions.request({ origins: [origin] }, (granted) => {
          // Загрузка распакованного расширения иногда не даёт вызвать запрос
          // (нет жеста пользователя / политика) — не ломаем попап, просто
          // считаем, что доступ есть, и дадим серверу ответить самому.
          if (chrome.runtime.lastError) {
            console.log('⚠️ Запрос доступа:', chrome.runtime.lastError.message);
            resolve(true);
            return;
          }
          resolve(!!granted);
        });
      });
    });
  }

  // ---------- Проверка обновлений ----------

  document.getElementById('repoBtn').addEventListener('click', function() {
    chrome.tabs.create({ url: `https://github.com/${getRepo()}` });
  });

  checkBtn.addEventListener('click', checkForUpdates);

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
      updateStatusDiv.textContent = '✅ Актуальная версия';
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

  // ---------- Статус сервера ----------

  function checkStatus() {
    if (!SERVER_URL) {
      setStatus('Укажите адрес сервера в настройках', 'warn');
      setPill('не настроен', 'warn');
      return;
    }
    fetch(`${SERVER_URL}/status`, { headers: apiHeaders(TOKEN) })
      .then(response => {
        if (response.status === 401 || response.status === 403) {
          throw new Error('unauthorized');
        }
        if (!response.ok) throw new Error('server');
        return response.json();
      })
      .then(data => {
        setStatus('Сервер активен — можно звать коллег', 'ok');
        setPill('онлайн', 'ok');
        if (!clientsOpen) onlineCount.textContent = data.onlineCount ?? data.clients ?? 0;
      })
      .catch((err) => {
        if (err && err.message === 'unauthorized') {
          // 401 бывает только если на сервере задан PEREKUR_TOKEN.
          // Токен необязателен — говорим, что нужно сделать, а не «ошибка».
          setStatus("🔒 Сервер просит токен — впишите его в настройках", 'error');
          setPill('нужен токен', 'err');
          settingsBox.open = true;
        } else {
          setStatus('⚠️ Сервер недоступен!', 'error');
          setPill('нет связи', 'err');
        }
      });
  }

  // ---------- Зов на перекур ----------

  callBtn.addEventListener('click', function() {
    if (!SERVER_URL) {
      setStatus('Сначала укажите адрес сервера в настройках', 'warn');
      settingsBox.open = true;
      return;
    }
    callBtn.disabled = true;
    setStatus('Отправляем…', '');

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
        if (response && response.cancelled) {
          setStatus('❌ ' + (response.cancelReason || 'Голосование отменено'), 'error');
        } else if (response && response.success) {
          // Итоги приходят только когда все проголосовали или прошло 2 минуты,
          // поэтому сразу предупреждаем, чтобы это не выглядело как поломка.
          setStatus('✅ Опрос создан! Итоги придут в течение 2 минут', 'ok', 8000);
        } else {
          setStatus('❌ Ошибка: ' + (response?.error || 'неизвестная'), 'error');
        }

        callBtn.disabled = false;
      });
    });
  });

  // ---------- Шрек ----------

  function sendShrek() {
    chrome.storage.local.get(['clientName'], (result) => {
      const name = result.clientName || 'Кто-то';

      chrome.runtime.sendMessage({
        action: 'sendShrek',
        data: { sender: name }
      }, function(response) {
        if (response && response.success) {
          setStatus('🟢 Шрек отправлен коллегам!', 'ok', 3000);
        } else {
          setStatus('❌ Ошибка: ' + (response?.error || 'сервер недоступен'), 'error');
        }
      });
    });
  }

  shrekBtn.addEventListener('click', sendShrek);
  document.getElementById('shrekImg').addEventListener('click', sendShrek);

  // ---------- Периодическое обновление ----------

  setInterval(function() {
    checkStatus();
    // Пока список раскрыт, подтягиваем имена — кто-то мог зайти/выйти
    if (clientsOpen) loadOnlineList();
  }, 10000);

  // ---------- Модалка итогов ----------
  // Показываем, если фон записал новые результаты, пока попап был закрыт.
  const resultsModal = document.getElementById('resultsModal');
  document.getElementById('resultsClose').addEventListener('click', closeResults);

  function closeResults() {
    resultsModal.classList.remove('open');
    resultsModalOpen = false;
    chrome.storage.local.set({ pendingResultsShown: true });
  }

  function showResults(results, poll) {
    const yes = results.yes || 0;
    const no = results.no || 0;
    document.getElementById('resYes').textContent = yes;
    document.getElementById('resNo').textContent = no;
    document.getElementById('resultsSub').textContent =
      (poll && poll.sender ? 'Опрос от ' + poll.sender : 'Голосование завершено');
    const total = yes + no;
    document.getElementById('resBar').style.width =
      (total ? Math.round((yes / total) * 100) : 0) + '%';

    const box = document.getElementById('resVoters');
    box.innerHTML = '';
    const addWho = (mark, names) => (names || []).forEach(n => {
      const row = document.createElement('div');
      row.className = 'who';
      const m = document.createElement('span');
      m.className = 'mark';
      m.textContent = mark;
      const t = document.createElement('span');
      t.textContent = n;
      row.appendChild(m);
      row.appendChild(t);
      box.appendChild(row);
    });
    addWho('🟢', results.yesVoters);
    addWho('🔴', results.noVoters);
    if (!box.children.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'никто не проголосовал';
      box.appendChild(p);
    }

    resultsModal.classList.add('open');
  }

  // Показ итогов ровно один раз: и при загрузке попапа, и по сообщению от фона
  // (иначе можно открыть модалку дважды — загрузка и resultsReady приходят почти одновременно)
  let resultsModalOpen = false;
  function showResultsOnce() {
    if (resultsModalOpen) return;
    chrome.storage.local.get(['pendingResults', 'pendingResultsPoll'], function(result) {
      if (resultsModalOpen) return;
      const res = result.pendingResults;
      if (!res) return;
      // Отменённый опрос уже сказал своё в статусе/уведомлении — модалка не нужна
      if (res.cancelled) {
        chrome.storage.local.set({ pendingResultsShown: true });
        return;
      }
      resultsModalOpen = true;
      showResults(res, result.pendingResultsPoll);
      chrome.storage.local.set({ pendingResultsShown: true });
    });
  }

  chrome.storage.local.get(['pendingResults', 'pendingResultsShown'], function(result) {
    if (result.pendingResults && !result.pendingResultsShown) showResultsOnce();
  });

  // Итоги пришли, пока попап открыт — показываем сразу
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.action !== 'resultsReady') return;
    showResultsOnce();
  });
});
