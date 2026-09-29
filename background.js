console.log('🔧 BACKGROUND ЗАГРУЖЕН!');

importScripts('config.js');

let SERVER_URL = '';
let clientId = null;
let currentName = null;

const ICON_URL = chrome.runtime.getURL('icons/icon128.png');

// Состояние хранится в chrome.storage.local, чтобы не теряться
// при «засыпании» service worker'а (MV3).
let state = {
  currentPollId: null,
  lastResultsId: null,
  resultsShown: false,
  shownShrekIds: [],
  shrekAttempts: {} // { id шрека: сколько раз не удалось открыть окно }
};

// Сколько раз пробуем открыть окно шрека, прежде чем сдаться
const SHREK_MAX_ATTEMPTS = 3;

function saveState() {
  chrome.storage.local.set(state);
}

// ============================================
// 0. Отчёт на сервер: что расширение реально показало
// ============================================
// По этому журналу на сервере видно, дошло ли сообщение до клиента
// и что он с ним сделал — даже если человек не заметил.
function reportEvent(event, detail) {
  if (!SERVER_URL || !clientId) return;
  fetch(`${SERVER_URL}/client-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: clientId,
      name: currentName || 'без имени',
      event: event,
      detail: detail || ''
    })
  }).catch(() => {});
}

// ============================================
// 1. Получение ID клиента
// ============================================
function getClientId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['clientId'], (result) => {
      if (result.clientId) {
        resolve(result.clientId);
      } else {
        const newId = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        chrome.storage.local.set({ clientId: newId }, () => {
          resolve(newId);
        });
      }
    });
  });
}

// ============================================
// 2. Регистрация на сервере
// ============================================
function registerClient() {
  if (!SERVER_URL) return;
  getClientId().then(id => {
    clientId = id;
    chrome.storage.local.get(['clientName'], (result) => {
      currentName = result.clientName || 'PC_' + id.slice(0, 6);

      fetch(`${SERVER_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, name: currentName })
      })
      .then(() => {
        console.log('✅ Зарегистрирован');
        checkPoll();
        checkResults();
        checkShrek();
      })
      .catch(() => console.log('⚠️ Сервер недоступен'));
    });
  });
}

// ============================================
// 3. Проверка опроса
// ============================================
function checkPoll() {
  if (!clientId) return;
  if (!SERVER_URL) return;
  
  fetch(`${SERVER_URL}/get-poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId, name: currentName })
  })
  .then(r => r.json())
  .then(data => {
    // Нет опроса
    if (!data.poll) {
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    const poll = data.poll;
    
    // Если это наш опрос (мы отправитель) — ждем результатов
    if (poll.senderId === clientId) {
      console.log('📝 Мы отправитель, ждем результаты...');
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    // Если уже голосовали
    if (poll.hasVoted) {
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    // Если это тот же опрос и уведомление уже показывали - НЕ показываем повторно
    if (state.currentPollId === poll.id) {
      return;
    }
    
    // Показываем уведомление с опросом
    state.currentPollId = poll.id;
    saveState();
    showPollNotification(poll);
  })
  .catch(() => {});
}

// ============================================
// 4. Проверка результатов
// ============================================
function checkResults() {
  if (!clientId) return;
  if (!SERVER_URL) return;
  
  fetch(`${SERVER_URL}/get-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId, name: currentName })
  })
  .then(r => r.json())
  .then(data => {
    if (data.results) {
      // Проверяем, не показывали ли уже эти результаты
      const resultsId = data.results.resultsId || data.results.timestamp || Date.now();
      
      if (state.resultsShown && state.lastResultsId === resultsId) {
        console.log('⏭️ Результаты уже показаны, пропускаем');
        return;
      }
      
      console.log('📊 Получены новые результаты!');
      state.resultsShown = true;
      state.lastResultsId = resultsId;
      state.currentPollId = null;
      saveState();
      
      showResultsNotification(data.results, data.poll);
    }
  })
  .catch(() => {});
}

// ============================================
// 5. Показ уведомления опроса
// ============================================
function showPollNotification(poll) {
  const id = 'poll_' + poll.id;
  const time = new Date(poll.timestamp).toLocaleTimeString();
  
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: ICON_URL,
    title: `${poll.sender} предлагает перекур!`,
    message: `${poll.message}\n⏱️ ${time}`,
    buttons: [
      { title: '✅ Пойду' },
      { title: '❌ Не пойду' }
    ],
    priority: 1,
    requireInteraction: false
  }, () => {
    if (chrome.runtime.lastError) {
      console.log('⚠️ Ошибка уведомления опроса:', chrome.runtime.lastError.message);
      return;
    }
    console.log('✅ Уведомление опроса показано (ID:', poll.id, ')');
    reportEvent('📨 показал призыв на перекур', poll.sender);
    
    // Убираем уведомление через 60 секунд, если не проголосовали
    setTimeout(() => chrome.notifications.clear(id), 60000);
  });
}

// ============================================
// 6. Показ уведомления результатов
// ============================================
function showResultsNotification(results, poll) {
  // Если голосование отменили (только 1 человек в опросе) — показываем причину
  if (results.cancelled) {
    const id = 'cancel_' + (results.resultsId || Date.now());
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: ICON_URL,
      title: '❌ Голосование отменено',
      message: (results.reason || 'Только 1 человек в опросе') + '\n' + (poll && poll.sender ? 'От: ' + poll.sender : ''),
      priority: 1,
      requireInteraction: false
    }, () => {
      if (chrome.runtime.lastError) return;
      console.log('❌ Уведомление об отмене опроса показано');
      setTimeout(() => chrome.notifications.clear(id), 10000);
    });
    return;
  }

  const yesVoters = (results.yesVoters || []).join(', ');
  const noVoters = (results.noVoters || []).join(', ');
  const total = results.total || 0;
  const totalClients = results.totalClients || 0;
  
  let message = `✅ ${results.yes || 0} идут  ❌ ${results.no || 0} не идут\n`;
  if (yesVoters) message += `🟢 ${yesVoters}\n`;
  if (noVoters) message += `🔴 ${noVoters}\n`;
  message += `Проголосовало: ${total} из ${totalClients}`;
  
  const id = 'results_' + (results.resultsId || Date.now());
  
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: ICON_URL,
    title: '📊 Результаты опроса!',
    message: message.slice(0, 500),
    priority: 1,
    requireInteraction: false
  }, () => {
    if (chrome.runtime.lastError) {
      console.log('⚠️ Ошибка уведомления результатов:', chrome.runtime.lastError.message);
      return;
    }
    console.log('✅ Уведомление результатов показано');
    reportEvent('📊 показал итоги голосования', `${results.yes || 0} за / ${results.no || 0} против`);
    
    // Убираем уведомление через 30 секунд
    setTimeout(() => chrome.notifications.clear(id), 30000);
  });
}

// ============================================
// 7. Шрек
// ============================================
function checkShrek() {
  if (!clientId) return;
  if (!SERVER_URL) return;
  
  fetch(`${SERVER_URL}/get-shrek`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId, name: currentName })
  })
  .then(r => r.json())
  .then(data => {
    const list = data.shreks || [];
    // Показываем только те шреки, которые ещё не показали (или которые
    // не удалось показать — тогда предпримем ещё попытку).
    const unseen = list.filter(s =>
      !state.shownShrekIds.includes(s.id) &&
      (state.shrekAttempts[s.id] || 0) < SHREK_MAX_ATTEMPTS
    );
    if (!unseen.length) return;
    
    unseen.forEach(s => showShrekNotification(s));
  })
  .catch(err => {
    // Раньше здесь стоял пустой catch, и любая ошибка исчезала молча —
    // из-за этого было невозможно понять, почему окно не открывается.
    console.log('⚠️ Ошибка проверки шреков:', err && err.message);
    reportEvent('❌ ошибка запроса шреков', err && err.message);
  });
}

// Помечает шрек показанным, но только ПОСЛЕ того, как окно реально открылось.
// Раньше id добавлялся в список заранее, и одна неудача навсегда теряла шрек.
function markShrekShown(shrek) {
  if (!state.shownShrekIds.includes(shrek.id)) state.shownShrekIds.push(shrek.id);
  if (state.shownShrekIds.length > 100) state.shownShrekIds = state.shownShrekIds.slice(-100);
  delete state.shrekAttempts[shrek.id];
  saveState();
}

// Счётчик неудачных попыток: чтобы совсем безнадёжный шрек не мучил вечно.
function countShrekAttempt(shrek, giveUp) {
  state.shrekAttempts[shrek.id] = (state.shrekAttempts[shrek.id] || 0) + 1;
  if (giveUp) {
    // Сдались — считаем шрек показанным, чтобы не повторялся бесконечно.
    if (!state.shownShrekIds.includes(shrek.id)) state.shownShrekIds.push(shrek.id);
    if (state.shownShrekIds.length > 100) state.shownShrekIds = state.shownShrekIds.slice(-100);
    delete state.shrekAttempts[shrek.id];
  }
  saveState();
}

function showShrekNotification(shrek) {
  // Системные уведомления Chrome не анимируют GIF (показывают первый кадр),
  // поэтому показываем шрека в маленьком всплывающем окне, где GIF проигрывается.
  // cache-buster, чтобы каждая картинка была новой и не кэшировалась.
  const imageUrl = SERVER_URL + '/shrek-image?t=' + Date.now();
  const title = shrek.sender + ' зовет на перекур!';
  const url = 'shrek.html?img=' + encodeURIComponent(imageUrl) + '&title=' + encodeURIComponent(title);

  const basic = {
    url: url,
    type: 'popup',
    width: 420,
    height: 420,
    focused: true
  };

  // alwaysOnTop поддерживается не всеми версиями Chrome. Если он не принят,
  // открываем окно без него — лучше окно не поверх всего, чем никакого окна.
  // Chrome сообщает о таком ДВУМЯ способами: бросает исключение сразу
  // ("Unexpected property") либо возвращает chrome.runtime.lastError.
  // Поэтому проверяем оба.
  const tryCreate = (options, canFallback) => {
    try {
      chrome.windows.create(options, () => {
        const err = chrome.runtime.lastError;
        if (!err) return onShrekWindowOpened(shrek, canFallback ? null : 'без alwaysOnTop');
        if (canFallback && /alwaysOnTop/i.test(err.message)) return tryCreate(basic, false);
        onShrekWindowFailed(shrek, err.message);
      });
    } catch (e) {
      if (canFallback && /alwaysOnTop/i.test(e.message)) return tryCreate(basic, false);
      onShrekWindowFailed(shrek, e.message);
    }
  };

  tryCreate({ ...basic, alwaysOnTop: true }, true);
}

function onShrekWindowOpened(shrek, note) {
  console.log('🟢 Окно Шрека открыто');
  markShrekShown(shrek);
  reportEvent('👹 показал окно шрека', note ? shrek.sender + ' (' + note + ')' : shrek.sender);
}

function onShrekWindowFailed(shrek, message) {
  const attempts = (state.shrekAttempts[shrek.id] || 0) + 1;
  console.log('⚠️ Ошибка открытия окна шрека:', message);
  reportEvent('❌ окно шрека НЕ открылось', `попытка ${attempts}: ${message}`);
  // 3 неудачи подряд — больше не мучаемся, но сообщаем на сервер.
  countShrekAttempt(shrek, attempts >= SHREK_MAX_ATTEMPTS);
}

// ============================================
// 8. Обработка кликов по уведомлениям
// ============================================
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  console.log('🔘 Кнопка уведомления:', notificationId, buttonIndex);
  
  // Убираем уведомление опроса сразу после клика
  chrome.notifications.clear(notificationId);
  
  if (!notificationId.startsWith('poll_')) return;
  
  const vote = buttonIndex === 0 ? 'yes' : 'no';
  sendVote(vote);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
});

function sendVote(vote) {
  if (!clientId) return;
  if (!SERVER_URL) return;
  
  console.log('🗳️ Голос:', vote);
  
  // Сбрасываем флаг результатов при голосовании
  state.resultsShown = false;
  state.lastResultsId = null;
  saveState();
  
  fetch(`${SERVER_URL}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: clientId,
      vote: vote,
      name: currentName
    })
  })
  .then(r => r.json())
  .then(data => {
    console.log('✅ Голос обработан');
    if (data.success !== false) {
      const id = 'vote_' + Date.now();
      const text = vote === 'yes' ? '✅ Вы идете на перекур!' : '❌ Вы не идете на перекур';
      chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: ICON_URL,
        title: text,
        message: 'Ждем остальных...',
        requireInteraction: false
      });
      setTimeout(() => chrome.notifications.clear(id), 3000);
    }
  })
  .catch(err => console.log('⚠️ Ошибка голосования:', err.message));
}

// ============================================
// 8. Обработка сообщений
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // Создание опроса
  if (request.action === 'createPoll') {
    // Сбрасываем только id опроса. Флаги показанных итогов НЕ трогаем:
    // resultsId уникален для каждого завершения, и если сбросить их здесь,
    // то после создания нового опроса клиент снова получил бы из архива
    // итоги старого опроса, в котором он голосовал.
    state.currentPollId = null;
    saveState();
    
    fetch(`${SERVER_URL}/create-poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: request.data.sender,
        senderId: clientId,
        message: request.data.message
      })
    })
    .then(r => r.json())
    .then(data => {
      console.log('✅ Опрос создан!');
      sendResponse({ success: data.success !== false, pollId: data.pollId, error: data.message });
    })
    .catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  
  // Отправка Шрека коллегам
  if (request.action === 'sendShrek') {
    fetch(`${SERVER_URL}/send-shrek`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: request.data.sender,
        senderId: clientId
      })
    })
    .then(r => r.json())
    .then(data => {
      sendResponse({ success: data.success !== false });
    })
    .catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  
  // Обновление IP сервера из настроек
  if (request.action === 'updateServerURL') {
    const ip = request.data && request.data.serverIP;
    if (ip) {
      SERVER_URL = normalizeServerURL(ip);
      console.log(`🔌 Сервер изменен: ${SERVER_URL}`);
      registerClient();
    }
    sendResponse({ ok: true });
  }
  
  // Обновление имени (перечитывает имя из storage и перерегистрируется)
  if (request.action === 'updateName') {
    registerClient();
    sendResponse({ ok: true });
  }
});

// ============================================
// 9. Запуск
// ============================================
chrome.storage.local.get(['serverIP', 'currentPollId', 'lastResultsId', 'resultsShown', 'shownShrekIds', 'shrekAttempts'], (result) => {
  // Восстанавливаем состояние после «засыпания» worker'а
  state.currentPollId = result.currentPollId || null;
  state.lastResultsId = result.lastResultsId || null;
  state.resultsShown = !!result.resultsShown;
  state.shownShrekIds = Array.isArray(result.shownShrekIds) ? result.shownShrekIds : [];
  state.shrekAttempts = result.shrekAttempts && typeof result.shrekAttempts === 'object' ? result.shrekAttempts : {};
  
  if (result.serverIP) {
    SERVER_URL = normalizeServerURL(result.serverIP);
    registerClient();
  } else {
    console.log('⚠️ IP сервера не задан — введите его в настройках расширения');
  }
});

// Проверка опроса каждые 30 секунд (chrome.alarms - надежный способ для MV3)
chrome.alarms.create('checkPoll', { periodInMinutes: 0.5 });
chrome.alarms.create('checkResults', { periodInMinutes: 0.5 });
chrome.alarms.create('checkShrek', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkPoll') checkPoll();
  if (alarm.name === 'checkResults') checkResults();
  if (alarm.name === 'checkShrek') checkShrek();
});

// При активации вкладки
chrome.tabs.onActivated.addListener(() => {
  checkPoll();
  checkResults();
  checkShrek();
});

console.log('✅ Background готов!');
