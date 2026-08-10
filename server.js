const http = require('http');
const os = require('os');

let clients = [];
let activePoll = null;
let activeShrek = null;

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
                    clientsCount: clients.length
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
                
                if (!activePoll) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ results: null }));
                    return;
                }
                
                // Проверяем, голосовал ли клиент ИЛИ является ли отправителем
                const hasVoted = activePoll.voters.includes(clientId);
                const isSender = activePoll.senderId === clientId;
                
                // Если клиент не голосовал и не отправитель - не показываем результаты
                if (!hasVoted && !isSender) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ results: null }));
                    return;
                }
                
                // Если опрос еще не завершен
                if (!activePoll.ended) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ results: null }));
                    return;
                }
                
                // Опрос завершен - отправляем результаты
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    results: activePoll.results,
                    poll: {
                        id: activePoll.id,
                        message: activePoll.message,
                        sender: activePoll.sender,
                        timestamp: activePoll.timestamp,
                        image: activePoll.image,
                        userVote: hasVoted ? activePoll.votes[clientId] : null,
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
                activeShrek = {
                    id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 7),
                    sender: data.sender || 'Кто-то',
                    senderId: data.senderId || null,
                    timestamp: new Date().toISOString()
                };
                console.log('🟢 ШРЕК ОТПРАВЛЕН! От: ' + activeShrek.sender);
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
                
                // Отправителю не показываем
                if (!activeShrek || activeShrek.senderId === clientId) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ shrek: null }));
                    return;
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ shrek: activeShrek }));
            } catch (e) {
                console.error('❌ Ошибка получения шрека:', e);
                res.writeHead(400);
                res.end(JSON.stringify({ shrek: null }));
            }
        });
        return;
    }

    // ==========================================
    // 10. 404
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

// Удаление завершенного опроса через 3 минуты (время на получение результатов при цикле опроса 30с)
setInterval(() => {
    if (activePoll && activePoll.ended) {
        const age = Date.now() - new Date(activePoll.timestamp).getTime();
        if (age > 180000) { // 3 минуты после завершения
            console.log('🗑️ Удаляем завершенный опрос');
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

// Удаление шрека через 5 минут
setInterval(() => {
    if (activeShrek) {
        const age = Date.now() - new Date(activeShrek.timestamp).getTime();
        if (age > 300000) { // 5 минут
            console.log('🗑️ Удаляем шрека');
            activeShrek = null;
        }
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