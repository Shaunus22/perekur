const params = new URLSearchParams(window.location.search);
const img = params.get('img');
const title = params.get('title') || '👹 ШРЕК УЖЕ ИДЕТ!';

const gif = document.getElementById('gif');
const sender = document.getElementById('sender');
const stage = document.getElementById('stage');
const rainHost = document.getElementById('shrekRain');
const pixelHost = document.getElementById('pixels');

// Если адрес картинки не пришёл — не грузим мусорный URL "null"
if (img) gif.src = img;
sender.textContent = title;
document.title = title;

// ============================================
// Стили появления — выбираются случайно
// ============================================
const STYLES = ['rain', 'pixel', 'walk'];

const style = params.get('style') && STYLES.includes(params.get('style'))
  ? params.get('style')
  : STYLES[Math.floor(Math.random() * STYLES.length)];
stage.dataset.style = style;

// Дождь из маленьких шреков. Копии используют тот же адрес картинки,
// поэтому браузер берёт её из кэша и не качает заново.
function spawnShrekRain() {
  const count = 16;
  for (let i = 0; i < count; i++) {
    const im = document.createElement('img');
    im.className = 'mini';
    im.src = gif.currentSrc || gif.src;
    im.alt = '';
    im.draggable = false;
    const size = 46 + Math.random() * 46;
    im.style.left = (Math.random() * 92) + '%';
    im.style.width = size + 'px';
    im.style.height = size + 'px';
    im.style.animationDuration = (1.6 + Math.random() * 1.6) + 's';
    im.style.animationDelay = (Math.random() * 0.85) + 's';
    im.addEventListener('animationend', () => im.remove(), { once: true });
    rainHost.appendChild(im);
  }
}

// Пиксели, слетающиеся к центру картинки (квадратики в цветах фона).
function spawnPixels() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const cx = w / 2;
  const cy = h / 2;
  const count = 90;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'px';
    const size = 7 + Math.random() * 13;
    // Стартуем за пределами экрана — издалека, по кругу
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.max(w, h) * (0.45 + Math.random() * 0.55);
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.left = (cx - size / 2) + 'px';
    p.style.top = (cy - size / 2) + 'px';
    p.style.setProperty('--dx', Math.round(Math.cos(angle) * dist) + 'px');
    p.style.setProperty('--dy', Math.round(Math.sin(angle) * dist) + 'px');
    p.style.background = Math.random() < 0.3 ? '#9dffc9' : '#35e07f';
    p.style.animationDelay = (Math.random() * 0.2) + 's';
    p.addEventListener('animationend', () => p.remove(), { once: true });
    pixelHost.appendChild(p);
  }
}

// ============================================
// Запуск показ: по факту загрузки картинки
// ============================================
// Анимация запускается по факту загрузки картинки, а не по факту
// открытия окна: картинка с сервера может грузиться заметное время, и если
// запустить анимацию сразу, она сыграет, пока окно ещё пустое.
let started = false;
const startAnimation = () => {
  if (started) return;
  started = true;

  gif.classList.add('is-ready');
  stage.classList.add('is-ready');

  if (style === 'rain') spawnShrekRain();
  if (style === 'pixel') spawnPixels();

  // «Шрек идёт»: после входа продолжает шагать на месте
  if (style === 'walk') {
    setTimeout(() => gif.classList.add('is-placed'), 1050);
  }
};

if (gif.complete && gif.naturalWidth) {
  startAnimation();
} else {
  gif.addEventListener('load', startAnimation, { once: true });
  // Если картинка не загрузилась — всё равно показываем окно, а не пустоту
  gif.addEventListener('error', startAnimation, { once: true });
  // Страховка: сеть могла подвиснуть — через 3 сек показываем что есть
  setTimeout(startAnimation, 3000);
}

// ============================================
// Закрытие
// ============================================
// Плавный уход: сначала анимация, потом закрытие окна
let closed = false;
const close = () => {
  if (closed) return;
  closed = true;
  document.body.classList.add('leaving');
  setTimeout(() => window.close(), 200);
};
document.getElementById('hint').addEventListener('click', close);
gif.addEventListener('click', close);
sender.addEventListener('click', close);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') close();
});

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

      // alwaysOnTop недоступен в этой версии Chrome, поэтому вместо «поверх
      // всех окон» периодически подсвечиваем окно в панели задач — так шрек
      // не потеряется среди других окон. drawAttention не забирает фокус.
      let pulses = 0;
      const pulse = setInterval(() => {
        if (pulses >= 4) { clearInterval(pulse); return; }
        pulses++;
        try {
          chrome.windows.update(win.id, { drawAttention: true }, () => {
            // намеренно игнорируем lastError
            void chrome.runtime.lastError;
          });
        } catch (e) { /* не критично */ }
      }, 2500);
    });
  }
} catch (e) {
  // центрирование — необязательный бонус, не ломаем из-за него ничего
  console.log('Не удалось отцентрировать окно:', e.message);
}
