console.log('🔧 BACKGROUND ЗАГРУЖЕН!');

importScripts('config.js');

let SERVER_URL = DEFAULT_SERVER_URL;
let clientId = null;
let activeWindowId = null;
let isPollShown = false;
let currentPollId = null;
let amISender = false;
let resultsShown = false; // Флаг - показаны ли уже результаты
let lastResultsId = null; // ID последних показанных результатов

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
  getClientId().then(id => {
    clientId = id;
    chrome.storage.local.get(['clientName'], (result) => {
      const name = result.clientName || 'PC_' + id.slice(0, 6);

      fetch(`${SERVER_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, name: name })
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
  
  fetch(`${SERVER_URL}/get-poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId })
  })
  .then(r => r.json())
  .then(data => {
    // Нет опроса
    if (!data.poll) {
      if (activeWindowId && !resultsShown) closeWindow();
      isPollShown = false;
      currentPollId = null;
      amISender = false;
      return;
    }
    
    const poll = data.poll;
    
    // Если это наш опрос (мы отправитель)
    if (poll.senderId === clientId) {
      console.log('📝 Мы отправитель, ждем результаты...');
      amISender = true;
      if (activeWindowId && !resultsShown) closeWindow();
      isPollShown = false;
      currentPollId = null;
      return;
    }
    
    // Если уже голосовали
    if (poll.hasVoted) {
      if (activeWindowId && !resultsShown) closeWindow();
      isPollShown = false;
      currentPollId = null;
      return;
    }
    
    // Если это тот же опрос и уже был показан (или закрыт) - НЕ открываем повторно
    if (currentPollId === poll.id) {
      return;
    }
    
    // Показываем опрос
    isPollShown = true;
    currentPollId = poll.id;
    amISender = false;
    showPoll(poll);
  })
  .catch(() => {});
}

// ============================================
// 4. Проверка результатов
// ============================================
function checkResults() {
  if (!clientId) return;
  
  fetch(`${SERVER_URL}/get-results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: clientId })
  })
  .then(r => r.json())
  .then(data => {
    if (data.results) {
      // Проверяем, не показывали ли уже эти результаты
      const resultsId = data.results.timestamp || data.results.total || Date.now();
      
      if (resultsShown && lastResultsId === resultsId) {
        console.log('⏭️ Результаты уже показаны, пропускаем');
        return;
      }
      
      console.log('📊 Получены новые результаты!');
      resultsShown = true;
      lastResultsId = resultsId;
      
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
      
      // Авто-закрытие через 60 секунд. currentPollId сохраняем,
      // чтобы повторно не открывать одно и то же окно.
      setTimeout(() => {
        if (activeWindowId) {
          chrome.windows.remove(activeWindowId, () => {
            activeWindowId = null;
            isPollShown = false;
          });
        }
      }, 60000);
    }
  });
}

// ============================================
// 6. Показ результатов
// ============================================
function showResults(results, poll) {
  // Закрываем старое окно если оно есть и это не окно с опросом
  if (activeWindowId) {
    chrome.windows.remove(activeWindowId, () => {
      activeWindowId = null;
    });
  }
  
  // Сбрасываем флаги опроса
  isPollShown = false;
  currentPollId = null;
  
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
      
      // Авто-закрытие через 30 секунд.
      // Флаг resultsShown не сбрасываем, чтобы не показывать результаты повторно.
      setTimeout(() => {
        if (activeWindowId) {
          chrome.windows.remove(activeWindowId, () => {
            activeWindowId = null;
          });
        }
      }, 30000);
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
      isPollShown = false;
      amISender = false;
    });
  }
}

// ============================================
// 8. Сброс флагов при завершении опроса
// ============================================
function resetFlags() {
  resultsShown = false;
  lastResultsId = null;
  isPollShown = false;
  currentPollId = null;
  amISender = false;
}

// ============================================
// 9. Обработка сообщений
// ============================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  
  // Создание опроса
  if (request.action === 'createPoll') {
    // Сбрасываем флаги перед созданием нового опроса
    resetFlags();
    
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
    resultsShown = false;
    lastResultsId = null;
    
    fetch(`${SERVER_URL}/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: clientId,
        vote: request.data.vote
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
    }
    sendResponse({ ok: true });
  }
});

// ============================================
// 10. Запуск
// ============================================
chrome.storage.local.get(['serverIP'], (result) => {
  if (result.serverIP) {
    SERVER_URL = `http://${result.serverIP}:${SERVER_PORT}`;
  }
  registerClient();
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
    isPollShown = false;
  }
});

console.log('✅ Background готов!');
