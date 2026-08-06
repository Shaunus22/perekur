// Получаем данные из URL
const params = new URLSearchParams(window.location.search);
const dataParam = params.get('data');

if (dataParam) {
  try {
    const poll = JSON.parse(decodeURIComponent(dataParam));
    
    document.getElementById('img').src = poll.image || 'https://cdn-icons-png.flaticon.com/512/3132/3132691.png';
    document.getElementById('sender').textContent = poll.sender + ' предлагает перекур';
    document.getElementById('message').textContent = poll.message || '';
    document.getElementById('time').textContent = '⏱️ ' + new Date(poll.timestamp).toLocaleTimeString();
    
    const pollId = poll.id;
    
    document.getElementById('btnYes').addEventListener('click', function() {
      sendVote('yes', pollId);
    });
    
    document.getElementById('btnNo').addEventListener('click', function() {
      sendVote('no', pollId);
    });
    
  } catch (e) {
    console.error('Ошибка:', e);
  }
}

function sendVote(vote, pollId) {
  // Блокируем кнопки
  document.getElementById('btnYes').disabled = true;
  document.getElementById('btnNo').disabled = true;
  
  chrome.runtime.sendMessage({
    action: 'vote',
    data: { pollId: pollId, vote: vote }
  }, function(response) {
    if (response && response.success) {
      const container = document.getElementById('container');
      const emoji = vote === 'yes' ? '✅' : '❌';
      const text = vote === 'yes' ? 'Вы идете на перекур!' : 'Вы не идете на перекур';
      const color = vote === 'yes' ? '#4CAF50' : '#f44336';
      
      container.innerHTML = `
        <div style="padding: 20px 0;">
          <div style="font-size: 50px;">${emoji}</div>
          <div style="font-size: 20px; font-weight: bold; color: ${color};">${text}</div>
          <div style="font-size: 14px; color: #666; margin-top: 8px;">Ждем остальных...</div>
        </div>
      `;
      
      setTimeout(() => window.close(), 3000);
    } else {
      alert((response && response.data && response.data.message) || 'Ошибка! Попробуйте еще раз.');
      document.getElementById('btnYes').disabled = false;
      document.getElementById('btnNo').disabled = false;
    }
  });
}