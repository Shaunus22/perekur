const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

let clients = [];
let activePoll = null;
let shreks = []; // очередь всех отправленных шреков, чтобы ни один не потерялся

// Архив завершённых опросов. Без него итоги пропадали бы в двух случаях:
//  1) клиент опоздал забрать их (опрос идёт раз в 30 сек);
//  2) кто-то создал новый опрос, пока старый ещё не закончился —
//     activePoll перезаписывается, и результаты старого становилось негде взять.
let finishedPolls = [];
const FINISHED_TTL = 15 * 60 * 1000; // храним итоги 15 минут
const FINISHED_MAX = 10;             // не больше 10 последних опросов

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
    return newClient;
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
}

// Какой опрос показать клиенту: сначала текущий, потом архив — от свежих к старым.
// Возвращает null, если клиент не голосовал и не был инициатором ни в одном из них.
function findResultsFor(clientId) {
    const candidates = [];
    if (activePoll) candidates.push(activePoll);
    for (let i = finishedPolls.length - 1; i >= 0; i--) candidates.push(finishedPolls[i]);

    for (const poll of candidates) {
        if (!poll || !poll.ended || !poll.results) continue;
        if (poll.voters.indexOf(clientId) === -1 && poll.senderId !== clientId) continue;
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
    activePoll.results = {
        resultsId: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 6), // Уникальный ID для результатов
        yes: yesCount,
        no: noCount,
        total: activePoll.voters.length,
        totalClients: clients.length,
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
    console.log(`📊 Проголосовало: ${activePoll.voters.length} из ${clients.length}`);
    console.log('========================================');
}

// ============================================
// Создание сервера
// ============================================

const server = http.createServer((req, res) => {
    // Логируем запросы для отладки
    console.log(`📨 ${req.method} ${req.url}`);
    
    // Настройка CORS для локальной сети
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

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
                    clientsCount: clients.length 
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            clients: clients.map(c => ({ id: c.id, name: c.name }))
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
                
                // Запоминаем, кто должен проголосовать (клиенты на момент создания опроса)
                activePoll.expectedVoters = clients
                    .filter(c => c.id !== data.senderId)
                    .map(c => c.id);

                // Если в опросе только сам отправитель (больше никого онлайн) — отменяем голосование
                const onlineOthers = clients.filter(c =>
                    c.id !== activePoll.senderId &&
                    Date.now() - c.lastSeen <= 90000
                ).length;

                if (onlineOthers === 0) {
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
                console.log(`👥 Клиентов в сети: ${clients.length}`);
                console.log('========================================');
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    pollId: activePoll.id,
                    clientsCount: clients.length,
                    cancelled: activePoll.cancelled || false,
                    cancelReason: activePoll.cancelReason || null
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
                
                console.log(`📊 Проголосовало: ${totalVoters} из ${clients.length}`);
                console.log(`📊 ЗА: ${yesCount}, ПРОТИВ: ${noCount}`);
                
                // Проверяем, все ли клиенты проголосовали (только те, кто был в сети при создании опроса)
                const allVoted = activePoll.expectedVoters.length > 0 &&
                    activePoll.expectedVoters.every(id => activePoll.voters.includes(id));
                
                if (allVoted && clients.length > 0) {
                    console.log('✅ ВСЕ ПРОГОЛОСОВАЛИ! Завершаем опрос');
                    endPoll();
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true,
                    votersCount: totalVoters,
                    totalClients: clients.length,
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
                
                upsertClient(clientId, data.name, getClientIP(req));
                
                // Ищем самый свежий завершённый опрос, к которому у клиента есть отношение
                // (голосовал или сам создавал). Архив спасает, когда клиент опоздал
                // или активный опрос уже перезаписан новым.
                const poll = findResultsFor(clientId);
                
                if (!poll) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ results: null }));
                    return;
                }
                
                const hasVoted = poll.voters.indexOf(clientId) !== -1;
                const isSender = poll.senderId === clientId;
                
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
            clients: clients.length,
            // Реально онлайн: активность за последние 90 секунд (клиенты пингуют раз в 30с)
            onlineCount: clients.filter(c => Date.now() - c.lastSeen <= 90000).length,
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
                const shrek = {
                    id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 7),
                    sender: data.sender || 'Кто-то',
                    senderId: data.senderId || null,
                    timestamp: new Date().toISOString()
                };
                shreks.push(shrek);
                // Держим не более 50 последних шреков, чтобы очередь не разрасталась
                if (shreks.length > 50) shreks.shift();
                console.log('🟢 ШРЕК ОТПРАВЛЕН! От: ' + shrek.sender + ' | Всего в очереди: ' + shreks.length);
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
});

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
    console.log('Нажмите Ctrl+C для остановки сервера');
    console.log('========================================');
});

// Обработка завершения
process.on('SIGINT', () => {
    console.log('\n👋 Сервер остановлен');
    process.exit();
});