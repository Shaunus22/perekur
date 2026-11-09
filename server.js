const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

let clients = [];
let activePoll = null;
let shreks = []; // очередь всех отправленных шреков, чтобы ни один не потерялся

// ============================================
// Мгновенная доставка (long-poll)
// ============================================
// Раньше клиент проверял сервер раз в 30 секунд — шрек или призыв могли
// опоздать на полминуты. Теперь клиент держит запрос открытым: сервер сам
// отвечает, как только появилось событие (новый шрек, опрос, итоги).
// Если событий нет, запрос возвращается пустым через WAIT_MS — клиент
// тут же переоткрывает его.
const WAIT_MS = 25000; // сколько держим запрос, если ничего не произошло
// Тихий режим: клиент просит держать запрос дольше. Ответ по таймауту тогда
// содержит reason "idle", и клиент молча переподключается, ничего не запрашивая.
const WAIT_LONG_MS = 120000;
const waiters = new Set(); // { res, clientId }

// Кто недавно держал долгий запрос. Нужно на случай, если клиент как раз
// переподключается (ответ получен, новый запрос ещё не открыт) — в эту
// долю секунды его lastSeen мог не обновиться, и сервер ошибочно считал
// его офлайн. Так опрос не отменялся «в одиночку» при живом коллеге.
const ONLINE_MS = 90000;
const longPollSeen = new Map(); // clientId -> время последнего /wait

function markLongPoll(clientId) {
    if (!clientId || clientId === 'unknown') return;
    longPollSeen.set(clientId, Date.now());
    if (longPollSeen.size > 200) {
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [id, ts] of longPollSeen) if (ts < cutoff) longPollSeen.delete(id);
    }
}

function recentlyLongPolled(clientId) {
    const ts = longPollSeen.get(clientId);
    return !!ts && Date.now() - ts <= ONLINE_MS;
}

function notifyWaiters(reason, exceptClientId) {
    if (!waiters.size) return;
    let woken = 0;
    for (const w of Array.from(waiters)) {
        // Отправителя не будим его же событием: он и так знает, что нажал.
        // Раньше из-за этого у инициатора мгновенно всплывали «итоги»:
        // будильник срабатывал от create-poll, и клиент сразу шёл
        // в /get-results, забирая результаты предыдущего опроса.
        if (exceptClientId && w.clientId === exceptClientId && reason !== 'results') continue;
        waiters.delete(w);
        clearTimeout(w.timer);
        finishWait(w, reason);
        woken++;
    }
    if (woken) console.log(`⚡ Мгновенная доставка: будим ${woken} клиент(ов) — ${reason}`);
}

function finishWait(waiter, reason) {
    if (waiter.done) return;
    waiter.done = true;
    try {
        waiter.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        waiter.res.end(JSON.stringify({ ok: true, reason: reason }));
    } catch (e) {
        // клиент уже отключился — не страшно
    }
}


// ============================================
// Доступ: общий токен + белый список Origin
// ============================================
// Токен НЕОБЯЗАТЕЛЕН. Если PEREKUR_TOKEN не задан, сервер ведёт себя как
// раньше: принимает всех, и в настройках расширения токен можно не вписывать.
// Он нужен только если сервер открыт в интернет и вы хотите его закрыть.
const TOKEN = String(process.env.PEREKUR_TOKEN || '').trim();
// Разрешённые источники/домены через запятую, например:
//   PEREKUR_ALLOWED_ORIGINS=https://perekur.example.org,chrome-extension://abcdef...
const ALLOWED_ORIGINS = String(process.env.PEREKUR_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

function originAllowed(origin) {
    // Расширение шлёт chrome-extension://<id> — его идентификатор заранее не известен,
    // поэтому такие источники пропускаем. Это безопасно: обычный сайт не может
    // подделать Origin, а когда задан токен, без него доступ всё равно закрыт.
    if (!origin || origin === 'null') return false;
    if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
    if (!ALLOWED_ORIGINS.length) {
        // Белый список не настроен — режим «как раньше»: простые запросы с любых
        // сайтов разрешены. Так расширение работает без настройки вообще.
        // Если хотите закрыть сервер от чужих сайтов, задайте
        // PEREKUR_ALLOWED_ORIGINS (тогда сработает ветка ниже).
        return true;
    }
    return ALLOWED_ORIGINS.includes(origin);
}

// Проверка токена: заголовок X-Perekur-Token либо ?token= в query
// (query нужен /shrek-image: <img> не умеет заголовки).
function tokenOk(req, url) {
    if (!TOKEN) return true;
    const header = req.headers['x-perekur-token'];
    if (header && header === TOKEN) return true;
    const fromQuery = url.searchParams.get('token');
    return !!fromQuery && fromQuery === TOKEN;
}

// Архив завершённых опросов. Без него итоги пропадали бы в двух случаях:
//  1) клиент опоздал забрать их (опрос идёт раз в 30 сек);
//  2) кто-то создал новый опрос, пока старый ещё не закончился —
//     activePoll перезаписывается, и результаты старого становилось негде взять.
let finishedPolls = [];
const FINISHED_TTL = 15 * 60 * 1000; // храним итоги 15 минут
const FINISHED_MAX = 10;             // не больше 10 последних опросов

// ============================================
// Сохранение состояния на диск
// ============================================
// Без этого перезапуск сервера (обновление, падение, `Restart=always`)
// стирал активный опрос и итоги, которые клиенты ещё не успели забрать.
const STATE_FILE = process.env.PEREKUR_STATE_FILE || path.join(__dirname, 'state.json');
let saveTimer = null;

function saveStateSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        saveStateNow();
    }, 500);
}

function saveStateNow() {
    try {
        const data = JSON.stringify({ savedAt: Date.now(), clients, activePoll, shreks, finishedPolls });
        fs.writeFileSync(STATE_FILE + '.tmp', data);
        fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
        console.error('❌ Не удалось сохранить состояние:', e.message);
    }
}

function loadState() {
    let raw;
    try {
        raw = fs.readFileSync(STATE_FILE, 'utf8');
    } catch (e) {
        return; // файла ещё нет — стартуем с чистого листа
    }
    try {
        const data = JSON.parse(raw);
        clients = Array.isArray(data.clients) ? data.clients : [];
        shreks = Array.isArray(data.shreks) ? data.shreks : [];
        finishedPolls = Array.isArray(data.finishedPolls) ? data.finishedPolls : [];

        // Опрос, который уже «устарел» по таймаутам, восстанавливать незачем
        if (data.activePoll && !data.activePoll.ended) {
            const age = Date.now() - new Date(data.activePoll.timestamp).getTime();
            if (age < 120000) activePoll = data.activePoll;
        } else if (data.activePoll) {
            const endedAt = new Date(data.activePoll.endedAt || data.activePoll.timestamp).getTime();
            if (Date.now() - endedAt < 180000) activePoll = data.activePoll;
        }
        console.log(`💾 Состояние восстановлено: клиентов ${clients.length}, итогов ${finishedPolls.length}` +
            (activePoll ? ', активный опрос есть' : ''));
    } catch (e) {
        console.error('❌ Файл состояния повреждён, стартуем с чистого листа:', e.message);
    }
}

loadState();

// Папка с картинками Шрека. Просто добавьте файл сюда — и он будет
// выбираться рандомно, без изменения кода.
const SHREK_IMAGE_DIR = path.join(__dirname, 'prikol');
// Сжатые анимированные WebP-версии больших GIF (конвертация: convert-gifs.sh)
const SHREK_WEBP_DIR = path.join(__dirname, 'prikol-webp');
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

function getRandomShrekImage() {
    let files = [];
    try {
        files = fs.readdirSync(SHREK_IMAGE_DIR);
    } catch (e) {
        return null;
    }
    const images = files.filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()));
    if (!images.length) return null;
    const pick = path.join(SHREK_IMAGE_DIR, images[Math.floor(Math.random() * images.length)]);
    // Если для файла есть сжатая webp-версия — отдаём её (гифки грузятся быстрее)
    const base = path.basename(pick, path.extname(pick));
    const webp = path.join(SHREK_WEBP_DIR, base + '.webp');
    if (fs.existsSync(webp)) return webp;
    return pick;
}

// ============================================
// Вспомогательные функции
// ============================================

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let name in interfaces) {
        for (let iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// IP клиента. За прокси (например, Caddy) реальный IP берём из x-forwarded-for
function getClientIP(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.socket.remoteAddress;
}

// Регистрируем клиента или обновляем его имя/время активности.
// Вызывается на любом запросе от клиента, чтобы имена не терялись
// при перезапуске сервера.
function upsertClient(clientId, name, ip) {
    const client = clients.find(c => c.id === clientId);
    if (client) {
        if (name) client.name = name;
        if (ip) client.ip = ip;
        client.lastSeen = Date.now();
        saveStateSoon();
        return client;
    }
    const newClient = {
        id: clientId,
        name: name || 'Аноним',
        ip: ip || 'unknown',
        registeredAt: new Date().toISOString(),
        lastSeen: Date.now()
    };
    clients.push(newClient);
    saveStateSoon();
    return newClient;
}

// Кто сейчас реально онлайн: был активен недавно, либо держит долгий
// запрос /wait, либо держал его только что (переподключается).
// ВАЖНО: clients хранит всех, кто заходил за последние 10 минут, поэтому
// clients.length — это НЕ число онлайн-людей, и показывать его как
// «проголосовало 2 из 5» нельзя.
function isClientOnline(client) {
    if (!client) return false;
    if (Date.now() - client.lastSeen <= ONLINE_MS) return true;
    if (waiters.size) {
        for (const w of waiters) if (w.clientId === client.id) return true;
    }
    return recentlyLongPolled(client.id);
}

function onlineClients() {
    return clients.filter(isClientOnline);
}

function getRandomImage() {
    const images = [
        'https://cdn-icons-png.flaticon.com/512/3132/3132691.png',
        'https://cdn-icons-png.flaticon.com/512/3132/3132693.png',
        'https://cdn-icons-png.flaticon.com/512/3132/3132694.png',
        'https://cdn-icons-png.flaticon.com/512/3132/3132695.png',
        'https://cdn-icons-png.flaticon.com/512/3132/3132696.png',
        'https://cdn-icons-png.flaticon.com/512/3132/3132697.png'
    ];
    return images[Math.floor(Math.random() * images.length)];
}

// ============================================
// Архив завершённых опросов
// ============================================

// Кладёт опрос в архив, чтобы его итоги ещё можно было забрать,
// даже если активный опрос уже перезаписан новым.
function archivePoll(poll) {
    if (!poll || !poll.ended || !poll.results) return;
    if (finishedPolls.some(p => p.id === poll.id)) return;

    finishedPolls.push(poll);
    const now = Date.now();
    finishedPolls = finishedPolls.filter(p => now - new Date(p.endedAt || p.timestamp).getTime() <= FINISHED_TTL);
    if (finishedPolls.length > FINISHED_MAX) finishedPolls = finishedPolls.slice(-FINISHED_MAX);
    saveStateSoon();
}

// Какой опрос показать клиенту: сначала текущий, потом архив — от свежих к старым.
// Возвращает null, если клиент не голосовал и не был инициатором ни в одном из них,
// либо если итоги этого опроса клиент уже видел (seeResultsId или resultsShownTo).
//
// Раньше here отдавался просто самый свежий подходящий опрос из архива, и клиент
// получал одни и те же итоги снова и снова — в том числе сразу после нажатия
// «позвать на перекур», когда итоги прошлого опроса ещё лежали в архиве.
function findResultsFor(clientId, seeResultsId) {
    const candidates = [];
    if (activePoll) candidates.push(activePoll);
    for (let i = finishedPolls.length - 1; i >= 0; i--) candidates.push(finishedPolls[i]);

    for (const poll of candidates) {
        if (!poll || !poll.ended || !poll.results) continue;
        if (poll.voters.indexOf(clientId) === -1 && poll.senderId !== clientId) continue;
        // Эти итоги клиент уже получил — не повторяем.
        if (seeResultsId && poll.results.resultsId === seeResultsId) continue;
        if (Array.isArray(poll.resultsShownTo) && poll.resultsShownTo.indexOf(clientId) !== -1) continue;
        return poll;
    }
    return null;
}

function endPoll() {
    if (!activePoll || activePoll.ended) return;
    const yesCount = Object.values(activePoll.votes).filter(v => v === 'yes').length;
    const noCount = Object.values(activePoll.votes).filter(v => v === 'no').length;
    
    // Получаем имена проголосовавших
    const yesVoters = [];
    const noVoters = [];
    
    for (let [clientId, vote] of Object.entries(activePoll.votes)) {
        const client = clients.find(c => c.id === clientId);
        const name = client ? client.name : clientId.slice(0, 8);
        if (vote === 'yes') {
            yesVoters.push(name);
        } else {
            noVoters.push(name);
        }
    }
    
    activePoll.ended = true;
    activePoll.endedAt = new Date().toISOString();
    // Сколько людей должны были голосовать: отправитель + те, кто был в сети
    // при создании опроса. Показывать clients.length нельзя — это все, кто
    // заходил за 10 минут, включая ушедших.
    const expected = Array.isArray(activePoll.expectedVoters) ? activePoll.expectedVoters : [];
    const expectedTotal = new Set([...(activePoll.senderId ? [activePoll.senderId] : []), ...expected]).size;
    const participants = Math.max(expectedTotal, activePoll.voters.length);

    activePoll.results = {
        resultsId: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 6), // Уникальный ID для результатов
        yes: yesCount,
        no: noCount,
        total: activePoll.voters.length,
        // Количество участников этого опроса, а не «всех клиентов на сервере»
        totalClients: participants,
        expectedVoters: expected.length,
        onlineAtEnd: onlineClients().length,
        yesVoters: yesVoters,
        noVoters: noVoters,
        timestamp: new Date().toISOString()
    };
    
    archivePoll(activePoll);
    
    console.log('========================================');
    console.log('📊 ИТОГИ ГОЛОСОВАНИЯ!');
    console.log(`📢 Инициатор: ${activePoll.sender}`);
    console.log(`✅ ЗА (${yesCount}): ${yesVoters.join(', ') || 'никого'}`);
    console.log(`❌ ПРОТИВ (${noCount}): ${noVoters.join(', ') || 'никого'}`);
    console.log(`📊 Проголосовало: ${activePoll.voters.length} из ${participants} участников` +
                ` (онлайн сейчас: ${onlineClients().length}, всего в базе: ${clients.length})`);
    console.log('========================================');

    // Будим всех, кто ждёт новостей долгим запросом — итоги должны
    // прийти сразу, а не через полминуты. Здесь будим и инициатора:
    // это уже именно ЭТОТ опрос, а не результаты прошлого.
    notifyWaiters('results');
}

// ============================================
// Создание сервера
// ============================================

const server = http.createServer((req, res) => {
    // Логируем запросы для отладки
    console.log(`📨 ${req.method} ${req.url}`);

    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch (e) {
        url = new URL('http://localhost/');
    }

    // CORS: не «*», а только разрешённые источники
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Perekur-Token');
    }

    if (req.method === 'OPTIONS') {
        if (origin && !originAllowed(origin)) {
            res.writeHead(403);
            res.end();
            return;
        }
        res.writeHead(204);
        res.end();
        return;
    }

    // Запрос из браузера с чужого сайта — отклоняем сразу
    if (origin && !originAllowed(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Origin not allowed' }));
        return;
    }

    // Токен: защищает все API-роуты. OPTIONS и 404 пропускаем как есть.
    if (!tokenOk(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid or missing token' }));
        return;
    }

    req.url = url.pathname + url.search;
    handle(req, res);
});

function handle(req, res) {

    // ==========================================
    // 1. РЕГИСТРАЦИЯ КЛИЕНТА
    // ==========================================
    if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || getClientIP(req);
                const clientName = data.name || 'Аноним';
                
                const wasRegistered = clients.some(c => c.id === clientId);
                upsertClient(clientId, clientName, getClientIP(req));
                
                if (wasRegistered) {
                    console.log(`🔄 Обновлена регистрация: ${clientName}`);
                } else {
                    console.log(`✅ ЗАРЕГИСТРИРОВАН: ${clientName}`);
                    console.log(`📊 Всего клиентов: ${clients.length}`);
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    clientsCount: onlineClients().length 
                }));
            } catch (e) {
                console.error('❌ Ошибка регистрации:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ==========================================
    // 2. СПИСОК КЛИЕНТОВ
    // ==========================================
    if (req.method === 'GET' && req.url === '/clients') {
        // Отдаём только тех, кто реально онлайн, иначе в списке всплывали бы
        // люди, которые закрыли браузер, но недавно заходили.
        const online = onlineClients();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            onlineCount: online.length,
            clients: online.map(c => ({ id: c.id, name: c.name }))
        }));
        return;
    }

    // ==========================================
    // 3. СОЗДАНИЕ ОПРОСА
    // ==========================================
    if (req.method === 'POST' && req.url === '/create-poll') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                
                // Если есть активный опрос - завершаем его
                if (activePoll && !activePoll.ended) {
                    console.log('⚠️ Завершаем старый опрос');
                    endPoll();
                }
                // Если старый опрос уже был завершён, но его итоги ещё не забрали —
                // сохраняем в архив, иначе они пропадут при перезаписи activePoll ниже.
                archivePoll(activePoll);
                
                // Создаем новый опрос
                activePoll = {
                    id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 7),
                    message: data.message || 'Пойдем на перекур! ☕',
                    sender: data.sender || 'Кто-то',
                    senderId: data.senderId || null,
                    timestamp: new Date().toISOString(),
                    image: getRandomImage(),
                    votes: {},
                    voters: [],
                    expectedVoters: [],
                    ended: false,
                    results: null
                };
                
                // Отправляющий автоматически голосует ЗА
                if (data.senderId) {
                    activePoll.votes[data.senderId] = 'yes';
                    activePoll.voters.push(data.senderId);
                    console.log(`✅ Отправитель проголосовал ЗА`);
                }
                
                // Запоминаем, кто должен проголосовать (клиенты на момент создания опроса).
                // Только тех, кто реально онлайн — иначе опрос ждал бы «мертвых» клиентов,
                // которые закрыли браузер, и итоги висели бы до 2-минутного таймаута.
                const waiterIdsForExpected = new Set(Array.from(waiters).map(w => w.clientId));
                activePoll.expectedVoters = clients
                    .filter(c => c.id !== data.senderId)
                    .filter(c => Date.now() - c.lastSeen <= ONLINE_MS ||
                                 waiterIdsForExpected.has(c.id) ||
                                 recentlyLongPolled(c.id))
                    .map(c => c.id);

                // Если в опросе только сам отправитель (больше никого онлайн) — отменяем голосование.
                //
                // Раньше отмена срабатывала и тогда, когда у коллеги висел долгий
                // запрос /wait, но его lastSeen ещё не обновился. Теперь «в сети»
                // считается ещё и любой ожидающий в /wait — он заведомо онлайн.
                const waiterIds = new Set(Array.from(waiters).map(w => w.clientId));
                const isOnline = (c) =>
                    Date.now() - c.lastSeen <= ONLINE_MS ||
                    waiterIds.has(c.id) ||
                    recentlyLongPolled(c.id);
                const onlineOthers = clients.filter(c =>
                    c.id !== activePoll.senderId && isOnline(c)
                ).length;

                // Не отменяем дважды: выше мог сработать endPoll() и уже выставить итоги
                const cancelledNow = onlineOthers === 0 && !activePoll.ended;
                if (cancelledNow) {
                    activePoll.ended = true;
                    activePoll.cancelled = true;
                    activePoll.endedAt = new Date().toISOString();
                    activePoll.cancelReason = 'В опросе только 1 человек — голосование отменено';
                    activePoll.results = {
                        resultsId: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 6),
                        cancelled: true,
                        reason: activePoll.cancelReason,
                        sender: activePoll.sender,
                        timestamp: new Date().toISOString()
                    };
                    archivePoll(activePoll);
                    console.log('========================================');
                    console.log('❌ ОПРОС ОТМЕНЁН: только 1 человек (отправитель)');
                    console.log(`📝 От: ${activePoll.sender}`);
                    console.log('========================================');
                }

                console.log('========================================');
                console.log('📢 НОВЫЙ ОПРОС!');
                console.log(`🆔 ID: ${activePoll.id}`);
                console.log(`📝 От: ${activePoll.sender}`);
                console.log(`💬 Сообщение: ${activePoll.message}`);
                console.log(`👥 Клиентов в сети: ${onlineOthers}`);
                console.log('========================================');
                saveStateSoon();

                // Будим ожидающих: призыв должен появиться сразу у всех.
                // Отправителя не будим — иначе он забирал итоги прошлого опроса.
                notifyWaiters(cancelledNow ? 'poll-cancelled' : 'poll', data.senderId);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    pollId: activePoll.id,
                    clientsCount: onlineOthers,
                    cancelled: cancelledNow,
                    cancelReason: cancelledNow ? activePoll.cancelReason : null
                }));
            } catch (e) {
                console.error('❌ Ошибка создания опроса:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ==========================================
    // 4. ПОЛУЧЕНИЕ ОПРОСА
    // ==========================================
    if (req.method === 'POST' && req.url === '/get-poll') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || 'unknown';
                
                upsertClient(clientId, data.name, getClientIP(req));
                
                // Если нет активного опроса или он завершен
                if (!activePoll || activePoll.ended) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ poll: null }));
                    return;
                }
                
                // Если клиент - отправитель, не показываем ему опрос
                if (activePoll.senderId === clientId) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ poll: null }));
                    return;
                }
                
                // Проверяем, голосовал ли уже этот клиент
                const hasVoted = activePoll.voters.includes(clientId);
                
                // Если клиент уже проголосовал - не показываем опрос
                if (hasVoted) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ poll: null }));
                    return;
                }
                
                // Отправляем опрос только тем, кто еще не голосовал
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    poll: {
                        id: activePoll.id,
                        message: activePoll.message,
                        sender: activePoll.sender,
                        senderId: activePoll.senderId,
                        timestamp: activePoll.timestamp,
                        image: activePoll.image,
                        hasVoted: false,
                        userVote: null
                    }
                }));
                
            } catch (e) {
                console.error('❌ Ошибка получения опроса:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ poll: null }));
            }
        });
        return;
    }

    // ==========================================
    // 5. ГОЛОСОВАНИЕ
    // ==========================================
    if (req.method === 'POST' && req.url === '/vote') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || 'unknown';
                const vote = data.vote;
                
                upsertClient(clientId, data.name, getClientIP(req));
                
                if (vote !== 'yes' && vote !== 'no') {
                    console.log(`⚠️ Некорректный голос: ${vote}`);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Некорректный голос' }));
                    return;
                }
                
                console.log(`🗳️ ГОЛОС: ${clientId} -> ${vote === 'yes' ? 'ЗА' : 'ПРОТИВ'}`);
                
                if (!activePoll || activePoll.ended) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        message: 'Опрос завершен' 
                    }));
                    return;
                }
                
                if (activePoll.voters.includes(clientId)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        message: 'Вы уже голосовали' 
                    }));
                    return;
                }
                
                // Сохраняем голос
                activePoll.votes[clientId] = vote;
                activePoll.voters.push(clientId);
                
                const yesCount = Object.values(activePoll.votes).filter(v => v === 'yes').length;
                const noCount = Object.values(activePoll.votes).filter(v => v === 'no').length;
                const totalVoters = activePoll.voters.length;
                
                // «из N» — это участники опроса, а не все клиенты в базе сервера
                const expectedList = Array.isArray(activePoll.expectedVoters) ? activePoll.expectedVoters : [];
                const participants = new Set([...(activePoll.senderId ? [activePoll.senderId] : []), ...expectedList]).size;
                
                console.log(`📊 Проголосовало: ${totalVoters} из ${participants} участников`);
                console.log(`📊 ЗА: ${yesCount}, ПРОТИВ: ${noCount}`);
                
                // Проверяем, все ли клиенты проголосовали (только те, кто был в сети при создании опроса)
                const allVoted = expectedList.length > 0 &&
                    expectedList.every(id => activePoll.voters.includes(id));
                
                if (allVoted) {
                    console.log('✅ ВСЕ ПРОГОЛОСОВАЛИ! Завершаем опрос');
                    endPoll();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true,
                    votersCount: totalVoters,
                    totalClients: participants,
                    allVoted: allVoted
                }));
                
            } catch (e) {
                console.error('❌ Ошибка голосования:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    // ==========================================
    // 6. ПОЛУЧЕНИЕ РЕЗУЛЬТАТОВ
    // ==========================================
    if (req.method === 'POST' && req.url === '/get-results') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || 'unknown';
                const seeResultsId = data.seeResultsId || null;
                const ackResultsId = data.ackResultsId || null;
                
                upsertClient(clientId, data.name, getClientIP(req));

                // Клиент подтверждает, что показал итоги — больше их не отдаём ему.
                // Раньше сервер считал итоги «новыми» всегда, и клиент получал
                // одни и те же цифры при каждой проверке.
                if (ackResultsId) {
                    const all = [activePoll, ...finishedPolls];
                    const acked = all.find(p => p && p.results && p.results.resultsId === ackResultsId);
                    if (acked) {
                        if (!Array.isArray(acked.resultsShownTo)) acked.resultsShownTo = [];
                        if (acked.resultsShownTo.indexOf(clientId) === -1) {
                            acked.resultsShownTo.push(clientId);
                            saveStateSoon();
                        }
                    }
                }

                // Ищем самый свежий завершённый опрос, к которому у клиента есть отношение
                // (голосовал или сам создавал) и итоги которого он ещё не видел.
                // Архив спасает, когда клиент опоздал или активный опрос уже перезаписан новым.
                const poll = findResultsFor(clientId, seeResultsId);
                
                if (!poll) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ results: null }));
                    return;
                }
                
                const hasVoted = poll.voters.indexOf(clientId) !== -1;
                const isSender = poll.senderId === clientId;

                // Помечаем итоги выданными сразу, но клиент дублирует защиту
                // своим seenResultsIds. Двух защит нужно два, потому что
                // бывают разные потери:
                //  - ответ до сервера не дошёл → ack не сохранился → сервер
                //    должен отдать ещё раз (клиент такой ответ отбросит);
                //  - клиент потерял ack (перезапуск) → сервер уже помечен,
                //    второй раз не выдаст (клиент не увидит дубль).
                if (!Array.isArray(poll.resultsShownTo)) poll.resultsShownTo = [];
                if (poll.resultsShownTo.indexOf(clientId) === -1) {
                    poll.resultsShownTo.push(clientId);
                    saveStateSoon();
                }
                
                // Опрос завершен - отправляем результаты
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    results: poll.results,
                    poll: {
                        id: poll.id,
                        message: poll.message,
                        sender: poll.sender,
                        timestamp: poll.timestamp,
                        image: poll.image,
                        userVote: hasVoted ? poll.votes[clientId] : null,
                        isSender: isSender
                    }
                }));
                
            } catch (e) {
                console.error('❌ Ошибка получения результатов:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ results: null }));
            }
        });
        return;
    }

    // ==========================================
    // 7. СТАТУС СЕРВЕРА
    // ==========================================
    if (req.method === 'GET' && req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            serverIP: getLocalIP(),
            // clients — все, кто заходил за последние 10 минут (включая ушедших).
            // Для «сколько людей сейчас» используйте onlineCount.
            clients: clients.length,
            onlineCount: onlineClients().length,
            waiting: waiters.size,
            hasActivePoll: !!activePoll && !activePoll.ended,
            pollEnded: activePoll ? activePoll.ended : false
        }));
        return;
    }

    // ==========================================
    // 8. ОТПРАВКА ШРЕКА
    // ==========================================
    if (req.method === 'POST' && req.url === '/send-shrek') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                // Без senderId сервер не смог бы отличить отправителя от получателя,
                // и шрек вернулся бы тому же человеку. Такую отправку отклоняем.
                if (!data.senderId) {
                    console.log('⚠️ Шрек без senderId — отклоняем (некому адресовать)');
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'senderId is required' }));
                    return;
                }
                const shrek = {
                    id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 7),
                    sender: data.sender || 'Кто-то',
                    senderId: data.senderId || null,
                    timestamp: new Date().toISOString()
                };
                shreks.push(shrek);
                // Держим не более 50 последних шреков, чтобы очередь не разрасталась
                if (shreks.length > 50) shreks.shift();
                saveStateSoon();
                console.log('🟢 ШРЕК ОТПРАВЛЕН! От: ' + shrek.sender + ' | Всего в очереди: ' + shreks.length);
                // Мгновенная доставка: ожидающие клиенты получают ответ прямо сейчас.
                // Отправителя не будим — он всё равно отфильтрует свой шрек по senderId,
                // а лишнее пробуждение лишь тратит запрос.
                notifyWaiters('shrek', shrek.senderId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error('❌ Ошибка отправки шрека:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ==========================================
    // 9. ПОЛУЧЕНИЕ ШРЕКА
    // ==========================================
    if (req.method === 'POST' && req.url === '/get-shrek') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const clientId = data.clientId || 'unknown';
                
                upsertClient(clientId, data.name, getClientIP(req));
                
                // Отдаём ВСЕ шреки за последние 5 минут, кроме своих.
                // Клиент сам решает, какие ещё не показывал (по id).
                const cutoff = Date.now() - 5 * 60 * 1000;
                const visibleShreks = shreks.filter(s => {
                    if (s.senderId === clientId) return false;
                    return new Date(s.timestamp).getTime() >= cutoff;
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ shreks: visibleShreks }));
            } catch (e) {
                console.error('❌ Ошибка получения шрека:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ shreks: [] }));
            }
        });
        return;
    }

    // ==========================================
    // 9.4. ДОЛГИЙ ЗАПРОС: «сообщи, когда что-то появится»
    // ==========================================
    // Клиент открывает этот запрос и ждёт. Сервер держит его до 25 секунд
    // и отвечает раньше, если отправлен шрек, создан опрос или готовы итоги.
    // Так события доходят за доли секунды вместо 30-секундного опроса.
    if (req.method === 'POST' && req.url === '/wait') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let clientId = 'unknown';
            let name = null;
            let idle = false; // «тихий» режим: обрывы по таймауту не считаются событием
            try {
                const data = JSON.parse(body || '{}');
                clientId = data.clientId || 'unknown';
                name = data.name || null;
                idle = data.idle === true;
            } catch (e) { /* пустое тело — не критично */ }

            upsertClient(clientId, name, getClientIP(req));
            // Клиент, который держит долгий запрос, точно в сети — запоминаем
            // это отдельно от lastSeen, чтобы опросы не отменялись «в одиночку».
            markLongPoll(clientId);

            const waiter = { res, clientId, done: false, timer: null, idle };
            waiters.add(waiter);

            // Потолок ожидания: даже если ничего не случилось, отвечаем —
            // клиент тут же переоткроет запрос. В тихом режиме держим дольше,
            // чтобы не переподключаться каждые 25 секунд без причины.
            const budget = idle ? WAIT_LONG_MS : WAIT_MS;
            waiter.timer = setTimeout(() => {
                waiters.delete(waiter);
                finishWait(waiter, idle ? 'idle' : 'timeout');
            }, budget);

            // Клиент закрыл вкладку / браузер — убираем его из ожидающих,
            // иначе будильник будет писать в мёртвый ответ.
            // ВАЖНО: проверяем именно соединение (res), а не req. Событие
            // 'close' на req в Node срабатывает, когда тело запроса дочитано,
            // то есть сразу же — и тогда клиент никогда не дождался бы ответа.
            const drop = () => {
                clearTimeout(waiter.timer);
                waiters.delete(waiter);
                waiter.done = true;
            };
            res.on('close', drop);
        });
        return;
    }

    // ==========================================
    // 9.5. ЖУРНАЛ СОБЫТИЙ ОТ КЛИЕНТОВ
    // ==========================================
    // Расширение сообщает, что реально показало на экране (окно шрека открыто,
    // уведомление показано и т.д.). По этому журналу видно, дошёл ли шрек
    // до конкретного клиента, даже если он это не заметил.
    if (req.method === 'POST' && req.url === '/client-log') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const d = JSON.parse(body);
                const who = d.name || 'без имени';
                console.log('🖥️ ' + who + ' → ' + (d.event || '?') + (d.detail ? ' | ' + d.detail : ''));
            } catch (e) {
                console.error('❌ Ошибка разбора client-log:', e.message);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }

    // ==========================================
    // 10. СЛУЧАЙНАЯ КАРТИНКА ШРЕКА
    // ==========================================
    if (req.method === 'GET' && req.url.startsWith('/shrek-image')) {
        const file = getRandomShrekImage();
        if (!file) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('No shrek images in ' + SHREK_IMAGE_DIR);
            return;
        }
        const mime = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif'
        }[path.extname(file).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
        return;
    }

    // ==========================================
    // 11. 404
    // ==========================================
    res.writeHead(404);
    res.end('Not found');
}

// ============================================
// Таймеры для автоматического завершения
// ============================================

// Авто-завершение опроса через 2 минуты
setInterval(() => {
    if (activePoll && !activePoll.ended) {
        const age = Date.now() - new Date(activePoll.timestamp).getTime();
        if (age > 120000) { // 2 минуты
            console.log('⏰ Время истекло (2 минуты), завершаем опрос');
            endPoll();
        }
    }
}, 30000);

// Убираем завершенный опрос из активных через 3 минуты ПОСЛЕ ЗАВЕРШЕНИЯ.
// Считать надо от endedAt, а не от timestamp: иначе опрос, дожидавшийся
// 2-минутного таймаута, жил после итогов всего 60 секунд — клиент с опросом
// раз в 30 секунд мог не успеть забрать результаты.
// Сами итоги при этом остаются в архиве finishedPolls.
setInterval(() => {
    if (activePoll && activePoll.ended) {
        const endedAt = activePoll.endedAt || activePoll.timestamp;
        const age = Date.now() - new Date(endedAt).getTime();
        if (age > 180000) { // 3 минуты после завершения
            archivePoll(activePoll);
            console.log('🗑️ Убираем завершенный опрос из активных (итоги в архиве)');
            activePoll = null;
            saveStateSoon();
        }
    }
}, 5000);

// Очистка неактивных клиентов (раз в минуту)
setInterval(() => {
    const now = Date.now();
    const before = clients.length;
    clients = clients.filter(c => now - c.lastSeen <= 600000); // 10 минут без активности
    const removed = before - clients.length;
    if (removed > 0) {
        console.log(`🗑️ Удалено ${removed} неактивных клиентов`);
        saveStateSoon();
    }
}, 60000);

// Удаление старых шреков из очереди (старше 5 минут — уже все успели получить)
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const before = shreks.length;
    shreks = shreks.filter(s => new Date(s.timestamp).getTime() >= cutoff);
    const removed = before - shreks.length;
    if (removed > 0) {
        console.log(`🗑️ Удалено ${removed} старых шреков из очереди`);
        saveStateSoon();
    }
}, 30000);

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

const PORT = parseInt(process.env.PORT, 10) || 3000;
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('🚀 СЕРВЕР "ПЕРЕКУР" ЗАПУЩЕН!');
    console.log('========================================');
    console.log(`🌐 IP сервера: ${localIP}`);
    console.log(`📡 Порт: ${PORT}`);
    console.log(`📋 Проверка: http://${localIP}:${PORT}/status`);
    console.log('========================================');
    console.log('📋 Логика работы:');
    console.log('  1. Клиенты регистрируются на сервере');
    console.log('  2. Кто-то создает опрос о перекуре');
    console.log('  3. Все получают уведомление');
    console.log('  4. Голосуют ЗА или ПРОТИВ');
    console.log('  5. Когда все проголосовали - видят результаты');
    console.log('  6. Отправитель тоже видит результаты!');
    console.log('  7. Опрос удаляется через 3 минуты после завершения');
    console.log('========================================');
    console.log('👥 Ожидаем подключения клиентов...');
    console.log(TOKEN ? '🔒 Токен задан — запросы без X-Perekur-Token отклоняются' : '⚠️ Токен не задан (PEREKUR_TOKEN) — сервер открыт всем');
    if (ALLOWED_ORIGINS.length) console.log('🌍 Разрешённые Origin: ' + ALLOWED_ORIGINS.join(', '));
    console.log(`💾 Файл состояния: ${STATE_FILE}`);
    console.log('Нажмите Ctrl+C для остановки сервера');
    console.log('========================================');
});

// Обработка завершения
process.on('SIGINT', () => {
    saveStateNow();
    console.log('\n👋 Сервер остановлен');
    process.exit();
});process.on('SIGTERM', () => {
    saveStateNow();
    // Долгие запросы не должны держать соединения при остановке —
    // отвечаем им сразу, иначе systemd будет ждать их до истечения таймаута.
    for (const w of Array.from(waiters)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        finishWait(w, 'shutdown');
    }
    process.exit();
});

// Никогда не оставляем незаписанное состояние (аварийное завершение)
process.on('exit', () => {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveStateNow();
});