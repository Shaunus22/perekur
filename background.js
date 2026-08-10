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
  lastShrekId: null
};

function saveState() {
  chrome.storage.local.set(state);
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
    
    // Убираем уведомление через 60 секунд, если не проголосовали
    setTimeout(() => chrome.notifications.clear(id), 60000);
  });
}

// ============================================
// 6. Показ уведомления результатов
// ============================================
function showResultsNotification(results, poll) {
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
    if (!data.shrek) return;
    if (state.lastShrekId === data.shrek.id) return;
    
    state.lastShrekId = data.shrek.id;
    saveState();
    showShrekNotification(data.shrek);
  })
  .catch(() => {});
}

function showShrekNotification(shrek) {
  const id = 'shrek_' + shrek.id;
  const images = [
    'prikol/1.webp',
    'prikol/2.jpg',
    'prikol/3.webp',
    'prikol/4.webp',
    'prikol/5.jpg',
    'prikol/6.jpg',
    'prikol/7.webp'
  ];
  const imageUrl = chrome.runtime.getURL(images[Math.floor(Math.random() * images.length)]);
  
  chrome.notifications.create(id, {
    type: 'image',
    iconUrl: ICON_URL,
    imageUrl: imageUrl,
    title: `${shrek.sender} зовет на перекур!`,
    message: '👹 ШРЕК УЖЕ ИДЕТ! 🟢',
    priority: 2,
    requireInteraction: true
  }, () => {
    if (chrome.runtime.lastError) {
      console.log('⚠️ Ошибка уведомления шрека:', chrome.runtime.lastError.message);
      return;
    }
    console.log('🟢 Уведомление Шрека показано');
    setTimeout(() => chrome.notifications.clear(id), 30000);
  });
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
    // Сбрасываем флаги перед созданием нового опроса
    state.currentPollId = null;
    state.lastResultsId = null;
    state.resultsShown = false;
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
chrome.storage.local.get(['serverIP', 'currentPollId', 'lastResultsId', 'resultsShown', 'lastShrekId'], (result) => {
  // Восстанавливаем состояние после «засыпания» worker'а
  state.currentPollId = result.currentPollId || null;
  state.lastResultsId = result.lastResultsId || null;
  state.resultsShown = !!result.resultsShown;
  state.lastShrekId = result.lastShrekId || null;
  
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
