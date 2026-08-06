const params = new URLSearchParams(window.location.search);
const dataParam = params.get('data');
const content = document.getElementById('content');

function appendVoters(parent, label, voters, labelText) {
  const wrap = document.createElement('div');
  wrap.className = 'voters';
  const labelEl = document.createElement('div');
  labelEl.className = 'voters-label';
  labelEl.textContent = label;
  wrap.appendChild(labelEl);
  wrap.appendChild(document.createTextNode(' ' + voters.join(', ')));
  parent.appendChild(wrap);
}

if (dataParam) {
  try {
    const data = JSON.parse(decodeURIComponent(dataParam));
    const results = data.results;
    const poll = data.poll;
    const isSender = data.isSender || false;
    const userVote = data.userVote || null;

    // Определяем статус голосующего
    let voteEmoji = '✅';
    let voteText = 'вы идете';

    if (userVote === 'no') {
      voteEmoji = '❌';
      voteText = 'вы не идете';
    } else if (isSender) {
      voteText = 'вы инициировали перекур и идете';
    }

    const yesVoters = results.yesVoters || [];
    const noVoters = results.noVoters || [];

    content.innerHTML = '';

    const voteDiv = document.createElement('div');
    voteDiv.style.cssText = 'font-size:13px;color:#888;margin-bottom:5px;';
    voteDiv.textContent = `${voteEmoji} ${voteText}`;
    content.appendChild(voteDiv);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '📊 Результаты опроса!';
    content.appendChild(title);

    const yesDiv = document.createElement('div');
    yesDiv.className = 'result-yes';
    yesDiv.textContent = `✅ ${results.yes || 0} человек идут`;
    content.appendChild(yesDiv);

    const noDiv = document.createElement('div');
    noDiv.className = 'result-no';
    noDiv.textContent = `❌ ${results.no || 0} человек не идут`;
    content.appendChild(noDiv);

    if (yesVoters.length > 0) {
      appendVoters(content, `🟢 Идут (${yesVoters.length}):`, yesVoters);
    }
    if (noVoters.length > 0) {
      appendVoters(content, `🔴 Не идут (${noVoters.length}):`, noVoters);
    }

    // Показываем кто инициировал опрос
    if (poll && poll.sender) {
      const initDiv = document.createElement('div');
      initDiv.style.cssText = 'font-size:12px;color:#888;margin:8px 0;padding:6px;background:#f0f0f0;border-radius:6px;';
      initDiv.textContent = `📢 Инициатор: ${poll.sender}`;
      content.appendChild(initDiv);
    }

    const votedDiv = document.createElement('div');
    votedDiv.style.cssText = 'font-size:12px;color:#999;margin:8px 0;';
    votedDiv.textContent = `Проголосовало: ${results.total || 0} из ${results.totalClients || 0}`;
    content.appendChild(votedDiv);

    const btn = document.createElement('button');
    btn.className = 'btn-go';
    btn.textContent = '🏃 Идем на перекур!';
    btn.addEventListener('click', () => window.close());
    content.appendChild(btn);

  } catch (e) {
    console.error('Ошибка:', e);
    content.textContent = '❌ Ошибка загрузки результатов';
  }
  
  // Авто-закрытие окна результатов
  setTimeout(() => window.close(), 30000);
}
