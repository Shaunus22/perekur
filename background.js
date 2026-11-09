console.log('🔧 BACKGROUND ЗАГРУЖЕН!');

importScripts('config.js');

let SERVER_URL = '';
let clientId = null;
let currentName = null;
// Общий токен доступа к серверу (задаётся в настройках расширения и в env сервера)
let TOKEN = '';

function headers() {
  return apiHeaders(TOKEN);
}

const ICON_URL = chrome.runtime.getURL('icons/icon128.png');

// Состояние хранится в chrome.storage.local, чтобы не теряться
// при «засыпании» service worker'а (MV3).
let state = {
  currentPollId: null,
  lastResultsId: null,
  ackResultsId: null,
  resultsShown: false,
  shownShrekIds: [],
  shrekAttempts: {} // { id шрека: сколько раз не удалось открыть окно }
};

// Сколько раз пробуем открыть окно шрека, прежде чем сдаться
const SHREK_MAX_ATTEMPTS = 3;

function saveState() {
  chrome.storage.local.set(state);
}

// Убирает прошлые итоги так, чтобы это гарантированно произошло раньше,
// чем придут новые. Раньше удаление и установка флага делались вразнобой,
// и «показано: true» могло затереть «показано: false» для настоящих итогов.
function clearPendingResults() {
  chrome.storage.local.remove(['pendingResults', 'pendingResultsPoll']);
  chrome.storage.local.set({ pendingResultsShown: true });
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
    headers: headers(),
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
// После «пробуждения» service worker'а переменные SERVER_URL и clientId
// пустые. Ни одна функция доставки без них не работает, поэтому перед
// подъёмом цикла гарантируем, что они восстановлены (из chrome.storage).
let readyPromise = null;

function ensureReady() {
  // Если всё уже на месте — ничего не делаем и ничего не кэшируем.
  if (SERVER_URL && clientId) return Promise.resolve();
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    chrome.storage.local.get(['serverIP'], (result) => {
      if (!SERVER_URL && result.serverIP) {
        SERVER_URL = normalizeServerURL(result.serverIP);
      }
      if (!SERVER_URL) {
        readyPromise = null;
        return resolve();
      }
      getClientId().then((id) => {
        clientId = id;
        // После восстановления кэш не держим: если worker снова заснёт,
        // переменные обнулятся, и следующий вызов обязан перечитать storage.
        readyPromise = null;
        if (!currentName) {
          chrome.storage.local.get(['clientName'], (r2) => {
            currentName = r2.clientName || 'PC_' + id.slice(0, 6);
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  });
  return readyPromise;
}

function registerClient() {
  if (!SERVER_URL) return;
  getClientId().then(id => {
    clientId = id;
    chrome.storage.local.get(['clientName'], (result) => {
      currentName = result.clientName || 'PC_' + id.slice(0, 6);

      fetch(`${SERVER_URL}/register`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ clientId: clientId, name: currentName })
      })
      .then(() => {
        console.log('✅ Зарегистрирован');
        // Проверки после регистрации шлём только если долгий запрос почему-то
        // не стартовал — иначе тройка запросов скачет зря.

        // Регистрация завершена — можно открывать долгий запрос
        const wasRunning = waitLoopRunning;
        startWaitLoop();
        if (!wasRunning) {
          checkPoll();
          checkResults();
          checkShrek();
        }
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
    headers: headers(),
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
    headers: headers(),
    // seeResultsId — какие итоги клиент уже показал. Без него сервер
    // каждый раз отдавал один и тот же старый опрос из архива.
    // ackResultsId — итоги, которые показаны и сохранены: сервер по нему
    // снимает их с очереди. Если ответ потерялся — вернёт снова.
    body: JSON.stringify({
      clientId: clientId,
      name: currentName,
      seeResultsId: state.lastResultsId,
      ackResultsId: state.ackResultsId || null
    })
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
      state.ackResultsId = resultsId;
      state.currentPollId = null;
      saveState();

      // Кладём итоги в storage: если попап открыт — красиво покажет их в окне,
      // если закрыт — покажет при следующем открытии.
      // Сначала обновляем флаги (попап сбрасывает pendingResultsShown при показе),
      // и только потом шлём resultsReady — иначе гонка затрёт флаг.
      chrome.storage.local.set({
        pendingResults: data.results,
        pendingResultsPoll: data.poll || null,
        pendingResultsShown: false
      }, () => {
        // Попап может быть открыт прямо сейчас — попробуем разбудить его.
        // Если попап не открыт, ошибки нет: он покажет итоги при открытии.
        chrome.runtime.sendMessage({ action: 'resultsReady' }, () => {
          void chrome.runtime.lastError;
        });
        // Подстраховка: если попап открыт, но открыт позже получения сообщения,
        // уведомление всё равно нужно показать — попап сам проверяет storage.
        showResultsNotification(data.results, data.poll);
      });
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
  // totalClients — участники именно этого опроса, а не все, кто когда-либо
  // заходил на сервер. Раньше здесь было «из 5» при двух людях в сети.
  const totalClients = Math.max(results.totalClients || 0, total);
  
  let message = `✅ ${results.yes || 0} идут  ❌ ${results.no || 0} не идут\n`;
  if (yesVoters) message += `🟢 ${yesVoters}\n`;
  if (noVoters) message += `🔴 ${noVoters}\n`;
  if (totalClients > total) {
    message += `Проголосовало: ${total} из ${totalClients} — ${totalClients - total} не ответили`;
  } else {
    message += `Проголосовали все: ${total}`;
  }
  
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
    headers: headers(),
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
  // Токен передаём в query: <img> в shrek.html не может задать заголовок.
  const imageUrl = SERVER_URL + '/shrek-image?t=' + Date.now() +
    (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
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
  
  // Сбрасываем флаг результатов при голосовании, чтобы получить
  // итоги именно этого опроса. ackResultsId тоже чистим — иначе сервер
  // считал бы новый опрос уже подтверждённым и не отдавал его итоги.
  state.resultsShown = false;
  state.lastResultsId = null;
  state.ackResultsId = null;
  saveState();
  
  fetch(`${SERVER_URL}/vote`, {
    method: 'POST',
    headers: headers(),
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

    // Очищаем прошлые итоги ДО запроса на сервер. Раньше здесь ставился
    // pendingResultsShown: true уже после ответа сервера — и эта запись
    // (асинхронная) могла лечь ПОСЛЕ того, как checkResults запишет
    // pendingResultsShown: false для настоящих итогов. Флаг оставался
    // «показано», и попап молчал: инициатор видел итоги только после
    // перезапуска worker'а. Фиксируем порядок: чистка → создание опроса.
    clearPendingResults();
    
    // Как и при отправке шрека: id берём из storage, а не из памяти —
    // иначе после «пробуждения» worker'а отправитель окажется без id,
    // и сервер не сможет понять, что это его собственный опрос.
    getClientId().then(id => {
      clientId = id;
      return fetch(`${SERVER_URL}/create-poll`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sender: request.data.sender,
          senderId: id,
          message: request.data.message
        })
      });
    })
    .then(r => r.json())
    .then(data => {
      console.log('✅ Опрос создан!');
      // cancelled/cancelReason важны: сервер отменяет опрос, если кроме
      // отправителя в сети никого нет, и попап должен сказать об этом.
      sendResponse({
        success: data.success !== false,
        pollId: data.pollId,
        cancelled: !!data.cancelled,
        cancelReason: data.cancelReason || null,
        error: data.message
      });
    })
    .catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  
  // Отправка Шрека коллегам
  if (request.action === 'sendShrek') {
    // senderId берём только из storage: переменная clientId в памяти
    // service worker'а может быть null, если он только что проснулся
    // (Chrome усыпляет worker и обнуляет всё). Именно из-за этого шрек
    // уходил без senderId и сервер возвращал его же отправителю.
    getClientId().then(id => {
      clientId = id;
      return fetch(`${SERVER_URL}/send-shrek`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          sender: request.data.sender,
          senderId: id
        })
      });
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
  
  // Обновление адреса сервера / токена из настроек
  if (request.action === 'updateServerURL') {
    const ip = request.data && request.data.serverIP;
    const token = request.data && request.data.token;
    if (ip) {
      SERVER_URL = normalizeServerURL(ip);
      console.log(`🔌 Сервер изменен: ${SERVER_URL}`);
      // Адрес сменился — старый долгий запрос висит на прежнем сервере
      stopWaitLoop();
    }
    if (token !== undefined) {
      TOKEN = String(token || '').trim();
    }
    if (ip || token !== undefined) registerClient();
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
chrome.storage.local.get(['serverIP', 'serverToken', 'currentPollId', 'lastResultsId', 'ackResultsId', 'resultsShown', 'shownShrekIds', 'shrekAttempts'], (result) => {
  // Восстанавливаем состояние после «засыпания» worker'а
  state.currentPollId = result.currentPollId || null;
  state.lastResultsId = result.lastResultsId || null;
  state.ackResultsId = result.ackResultsId || null;
  state.resultsShown = !!result.resultsShown;
  state.shownShrekIds = Array.isArray(result.shownShrekIds) ? result.shownShrekIds : [];
  state.shrekAttempts = result.shrekAttempts && typeof result.shrekAttempts === 'object' ? result.shrekAttempts : {};
  TOKEN = String(result.serverToken || '').trim();
  
  if (result.serverIP) {
    SERVER_URL = normalizeServerURL(result.serverIP);
    registerClient();
  } else {
    console.log('⚠️ IP сервера не задан — введите его в настройках расширения');
  }
});

// Страховка на старте: даже если worker поднялся не через registerClient
// (например, сразу после пробуждения), через минуту сторож поднимет цикл.

// СТОРОЖ ДОСТАВКИ. Главная проблема: Chrome усыпляет service worker
// даже с висящим fetch (особенно когда вкладка не в фокусе). После
// пробуждения память чистая, waitLoopRunning = false — цикл обрывается,
// и человек выпадает из онлайна, пока сам не откроет расширение.
// Поэтому раз в минуту проверяем: жив ли цикл, и если нет — поднимаем.
// Это не опрос сервера (никаких get-shrek/get-poll), а только подъём
// самого долгого запроса, так что трафик почти не растёт.
chrome.alarms.create('waitKeeper', { periodInMinutes: 1, delayInMinutes: 1 });

// Редкие страховочные проверки на случай, если сигнал /wait потерялся.
chrome.alarms.create('checkPoll', { periodInMinutes: 5 });
chrome.alarms.create('checkResults', { periodInMinutes: 5 });
chrome.alarms.create('checkShrek', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'waitKeeper') {
    // Аларм разбудил worker — переменные могли обнулиться, восстанавливаем.
    ensureReady().then(() => {
      startWaitLoop();
    });
    return;
  }
  if (alarm.name === 'checkPoll') checkPoll();
  if (alarm.name === 'checkResults') checkResults();
  if (alarm.name === 'checkShrek') checkShrek();
  // Будит «спящий» клиент — заодно проверяем, жив ли долгий запрос
  ensureReady().then(() => startWaitLoop());
});

// ============================================
// 10. Мгновенная доставка (долгий запрос /wait)
// ============================================
// Алармы выше — страховка. Основной канал — этот цикл: держим запрос
// открытым, сервер отвечает сразу, как только появился шрек/опрос/итоги.
// Так сообщение приходит за доли секунды вместо 30 секунд.
//
// Важно: пока идёт fetch, service worker не засыпает, поэтому цикл
// живёт всё время работы браузера. Если соединение оборвалось
// (сервер перезапустили, пропал интернет) — ждём и пробуем снова.
let waitLoopRunning = false;
let waitAbort = null;

function startWaitLoop() {
  if (waitLoopRunning) return;
  if (!SERVER_URL || !clientId) {
    // Worker только что проснулся — переменные обнулились.
    // Восстанавливаем их и приходим сюда снова.
    ensureReady().then(() => {
      if (SERVER_URL && clientId && !waitLoopRunning) {
        waitLoopRunning = true;
        waitOnce();
      }
    });
    return;
  }
  waitLoopRunning = true;
  waitOnce();
}

function stopWaitLoop() {
  waitLoopRunning = false;
  if (waitAbort) {
    try { waitAbort.abort(); } catch (e) { /* уже завершён */ }
    waitAbort = null;
  }
}

function waitOnce() {
  if (!waitLoopRunning) return;
  if (!SERVER_URL || !clientId) {
    waitLoopRunning = false;
    return;
  }

  const controller = new AbortController();
  waitAbort = controller;
  // Своя страховка: сервер держит запрос до 2 минут, даём ещё запас
  const guard = setTimeout(() => {
    try { controller.abort(); } catch (e) {}
  }, 150000);

  fetch(`${SERVER_URL}/wait`, {
    method: 'POST',
    headers: headers(),
    // idle: просим сервер держать запрос до 2 минут. Пока ничего не
    // происходит — ни одного лишнего запроса, только само соединение.
    body: JSON.stringify({ clientId: clientId, name: currentName, idle: true }),
    signal: controller.signal
  })
    .then(r => r.json())
    .then(data => {
      clearTimeout(guard);
      waitAbort = null;
      if (!waitLoopRunning) return;
      const reason = data && data.reason;
      // 'idle' / 'timeout' / 'shutdown' — событий не было. Молча
      // переподключаемся и НЕ дёргаем проверки: раньше здесь уходило
      // три лишних запроса каждые 25 секунд.
      if (reason && reason !== 'idle' && reason !== 'timeout' && reason !== 'shutdown') {
        console.log('⚡ Событие по мгновенной доставке:', reason);
        refreshFor(reason);
      }
      setTimeout(waitOnce, 0);
    })
    .catch(() => {
      clearTimeout(guard);
      waitAbort = null;
      if (!waitLoopRunning) return;
      // Сервер недоступен: сначала быстрый повтор, потом реже
      setTimeout(waitOnce, 5000);
    });
}

// Обновляем только то, что относится к событию: если пришёл шрек,
// незачем спрашивать заново про опрос и итоги.
function refreshFor(reason) {
  if (reason === 'shrek') checkShrek();
  else if (reason.startsWith && reason.startsWith('poll')) checkPoll();
  else if (reason === 'results') checkResults();
  else wakeCheck();
}

// При активации вкладки проверяем всё сразу.
// Разрешение "tabs" не запрашиваем ради одного события: без него
// chrome.tabs.onActivated падал бы с TypeError и ломал весь worker.
// Вместо этого — события «браузер запустился» и «расширение установлено/обновлено».
chrome.runtime.onStartup.addListener(wakeCheck);
chrome.runtime.onInstalled.addListener(wakeCheck);

function wakeCheck() {
  // После пробуждения worker'а переменные пусты — сначала восстанавливаем.
  ensureReady().then(() => {
    checkPoll();
    checkResults();
    checkShrek();
    // Если долгий запрос не идёт (первый запуск, сервер поднялся) — запускаем
    startWaitLoop();
  });
}

// Попап при открытии шлёт ping — проверяем всё сразу, не дожидаясь аларма
chrome.runtime.onMessage.addListener((request) => {
  if (request && request.action === 'ping') wakeCheck();
});

console.log('✅ Background готов!');
