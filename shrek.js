const params = new URLSearchParams(window.location.search);
const img = params.get('img');
const title = params.get('title') || '👹 ШРЕК УЖЕ ИДЕТ!';

const gif = document.getElementById('gif');
const sender = document.getElementById('sender');

gif.src = img;
sender.textContent = title;
document.title = title;

const close = () => window.close();
document.getElementById('hint').addEventListener('click', close);
gif.addEventListener('click', close);
sender.addEventListener('click', close);

// Авто-закрытие через 12 секунд — окно не должно висеть вечно
setTimeout(close, 12000);

// Центрируем окно на том мониторе, где оно открылось
try {
  if (typeof chrome !== 'undefined' && chrome.windows) {
    chrome.windows.getCurrent((win) => {
      if (!win) return;
      const scr = window.screen;
      const w = win.width || window.outerWidth;
      const h = win.height || window.outerHeight;
      const left = Math.round((scr.availLeft || 0) + (scr.availWidth - w) / 2);
      const top = Math.round((scr.availTop || 0) + (scr.availHeight - h) / 2);
      chrome.windows.update(win.id, { left, top, focused: true });
    });
  }
} catch (e) {
  // центрирование — необязательный бонус, не ломаем из-за него ничего
  console.log('Не удалось отцентрировать окно:', e.message);
}
