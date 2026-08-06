console.log('🔧 BACKGROUND ЗАГРУЖЕН!');

importScripts('config.js');

let SERVER_URL = '';
let clientId = null;
let currentName = null;
let activeWindowId = null;

// Состояние хранится в chrome.storage.local, чтобы не теряться
// при «засыпании» service worker'а (MV3). Иначе после перезапуска
// закрытые окна опроса/результатов открывались бы снова.
let state = {
  currentPollId: null,
  lastResultsId: null,
  resultsShown: false
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
      if (activeWindowId && !state.resultsShown) closeWindow();
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    const poll = data.poll;
    
    // Если это наш опрос (мы отправитель)
    if (poll.senderId === clientId) {
      console.log('📝 Мы отправитель, ждем результаты...');
      if (activeWindowId && !state.resultsShown) closeWindow();
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    // Если уже голосовали
    if (poll.hasVoted) {
      if (activeWindowId && !state.resultsShown) closeWindow();
      if (state.currentPollId) {
        state.currentPollId = null;
        saveState();
      }
      return;
    }
    
    // Если это тот же опрос и уже был показан (или закрыт) - НЕ открываем повторно
    if (state.currentPollId === poll.id) {
      return;
    }
    
    // Показываем опрос
    state.currentPollId = poll.id;
    saveState();
    showPoll(poll);
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
      saveState();
      
      // Показываем результаты
      showResults(data.results, data.poll);
    }
  })
  .catch(() => {});
}

// ============================================
// 5. Показ опроса
// ============================================
function showPoll(poll) {
  if (activeWindowId) {
    chrome.windows.remove(activeWindowId, () => {
      activeWindowId = null;
    });
  }
  
  const encoded = encodeURIComponent(JSON.stringify(poll));
  const url = chrome.runtime.getURL('notification.html') + '?data=' + encoded;
  
  chrome.windows.create({
    url: url,
    type: 'popup',
    width: 450,
    height: 520,
    focused: true
  }, (win) => {
    if (win) {
      activeWindowId = win.id;
      console.log('✅ Окно опроса открыто (ID:', poll.id, ')');
      // Авто-закрытие окна выполняется в самой странице (notification.js).
      // currentPollId сохранен в storage — окно повторно не откроется.
    }
  });
}

// ============================================
// 6. Показ результатов
// ============================================
function showResults(results, poll) {
  // Закрываем старое окно если оно есть
  if (activeWindowId) {
    chrome.windows.remove(activeWindowId, () => {
      activeWindowId = null;
    });
  }
  
  // Сбрасываем флаг опроса — опрос завершен
  state.currentPollId = null;
  saveState();
  
  // Определяем, кто мы: отправитель или проголосовавший
  let userVote = null;
  if (poll && poll.userVote) {
    userVote = poll.userVote;
  } else if (poll && poll.isSender) {
    userVote = 'yes';
  }
  
  const data = { 
    results: results, 
    poll: poll,
    isSender: poll ? poll.isSender : false,
    userVote: userVote
  };
  
  const encoded = encodeURIComponent(JSON.stringify(data));
  const url = chrome.runtime.getURL('results.html') + '?data=' + encoded;
  
  chrome.windows.create({
    url: url,
    type: 'popup',
    width: 420,
    height: 520,
    focused: true
  }, (win) => {
    if (win) {
      activeWindowId = win.id;
      console.log('✅ Окно результатов открыто');
      // Авто-закрытие окна выполняется в самой странице (results.js).
      // resultsShown/lastResultsId сохранены в storage — результаты
      // не будут показаны повторно, даже после «засыпания» worker'а.
    }
  });
}

// ============================================
// 7. Закрытие окна
// ============================================
function closeWindow() {
  if (activeWindowId) {
    chrome.windows.remove(activeWindowId, () => {
      activeWindowId = null;
    });
  }
}

// ============================================
// 8. Сброс состояния при новом опросе
// ============================================
function resetState() {
  state.currentPollId = null;
  state.lastResultsId = null;
  state.resultsShown = false;
  saveState();
}

// ============================================
// 9. Обработка сообщений
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // Создание опроса
  if (request.action === 'createPoll') {
    // Сбрасываем флаги перед созданием нового опроса
    resetState();
    
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
  
  // Голосование
  if (request.action === 'vote') {
    console.log('🗳️ Голос:', request.data.vote);
    
    // Сбрасываем флаг результатов при голосовании
    state.resultsShown = false;
    state.lastResultsId = null;
    saveState();
    
    fetch(`${SERVER_URL}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId,
        vote: request.data.vote,
        name: currentName
      })
    })
    .then(r => r.json())
    .then(data => {
      console.log('✅ Голос обработан');
      sendResponse({ success: data.success !== false, data: data });
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
      SERVER_URL = `http://${ip}:${SERVER_PORT}`;
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
// 10. Запуск
// ============================================
chrome.storage.local.get(['serverIP', 'currentPollId', 'lastResultsId', 'resultsShown'], (result) => {
  // Восстанавливаем состояние после «засыпания» worker'а
  state.currentPollId = result.currentPollId || null;
  state.lastResultsId = result.lastResultsId || null;
  state.resultsShown = !!result.resultsShown;
  
  if (result.serverIP) {
    SERVER_URL = `http://${result.serverIP}:${SERVER_PORT}`;
    registerClient();
  } else {
    console.log('⚠️ IP сервера не задан — введите его в настройках расширения');
  }
});

// Проверка опроса каждые 30 секунд (chrome.alarms - надежный способ для MV3)
chrome.alarms.create('checkPoll', { periodInMinutes: 0.5 });
chrome.alarms.create('checkResults', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkPoll') checkPoll();
  if (alarm.name === 'checkResults') checkResults();
});

// При активации вкладки
chrome.tabs.onActivated.addListener(() => {
  checkPoll();
  checkResults();
});

// При закрытии окна опроса/результатов
chrome.windows.onRemoved.addListener((id) => {
  if (id === activeWindowId) {
    activeWindowId = null;
  }
});

console.log('✅ Background готов!');
