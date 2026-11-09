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
// Но если картинка «замерла» (полупустой ответ от сети), страховка в 3 сек
// показывает окно раньше — и появление теряется. Поэтому старт ждём до 1.5 с,
// а после этой границы не ждём загрузку вообще и показываем сразу.
const START_DEADLINE_MS = 1500;
let started = false;
const startAnimation = () => {
  if (started) return;
  started = true;

  // Красивое появление нужно только если картинка на месте. Если её нет
  // (ошибка сети), то эффектно «влетает» пустота — лучше показать сразу.
  const hasImage = gif.complete && gif.naturalWidth > 0;
  if (hasImage) {
    gif.classList.add('is-ready');
  } else {
    gif.style.opacity = '1';
  }
  stage.classList.add('is-ready');

  if (hasImage) {
    // Отчёт в журнал (160 мс после старта — анимация уже должна двигаться).
    // Панель &diag=1 показывает то же самое прямо в окне.
    setTimeout(reportAnimation, 160);
    if (params.get('diag') === '1') probeAnimation();
  }

  if (style === 'rain') spawnShrekRain();
  if (style === 'pixel') spawnPixels();

  // «Шрек идёт»: после входа продолжает шагать на месте
  if (style === 'walk' && hasImage) {
    setTimeout(() => gif.classList.add('is-placed'), 1050);
  }
};

// Ждём кадр и смотрим: сколько анимаций на картинке и не замёрзли ли они.
// Используется и для панели &diag=1, и для тихого отчёта в журнал сервера.
function measureAnimation(cb) {
  // Даём браузеру начать анимации: сразу после classList.add их ещё нет.
  requestAnimationFrame(() => {
    const anims = (typeof gif.getAnimations === 'function') ? gif.getAnimations() : [];
    if (!anims.length) {
      cb({ found: false, moved: 0, total: 0, names: [] });
      return;
    }
    const names = anims.map(a => a.animationName || a.id || 'animation');
    const before = anims.map(a => Number(a.currentTime));
    // Сравниваем прогресс через 120 мс: если не сдвинулся — время анимации
    // стоит (так бывает при отключённых анимациях в системе).
    setTimeout(() => {
      const moved = anims.filter((a, i) => Number(a.currentTime) !== before[i]).length;
      cb({ found: true, moved: moved, total: anims.length, names: names });
    }, 120);
  });
}

// Тихий отчёт в журнал сервера — чтобы причину было видно без доступа к ПК.
function reportAnimation() {
  measureAnimation(r => {
    if (!r.found) return reportEvent('❌ у появления картинки нет анимации');
    if (!r.moved) return reportEvent('⚠️ появление не движется (система просит без движения)');
    reportEvent('🎞️ появление: ' + r.names.join(', '));
  });
}

function reportEvent(note) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        action: 'shrekDiag',
        data: { style: style, reducedMotion: reducedMotion, gpu: gpuRenderer, note: note }
      }, () => { void chrome.runtime.lastError; });
    }
  } catch (e) { /* диагностика не должна ломать показ */ }
}

function probeAnimation() {
  const box = document.getElementById('diag');
  if (!box) return;
  const add = (text, ok) => {
    const d = document.createElement('div');
    d.textContent = text;
    if (!ok) d.className = 'warn';
    box.appendChild(d);
  };

  const anims = (typeof gif.getAnimations === 'function') ? gif.getAnimations() : [];
  if (!anims.length) {
    add('появление: НЕТ анимации (сразу на месте)', false);
    return;
  }
  add('появление: ' + anims.map(a => (a.animationName || a.id || 'animation')).join(', '), true);
  measureAnimation(r => {
    add('играет: ' + r.moved + ' из ' + r.total, r.moved === r.total);
    if (!r.moved) add('→ анимация не движется: система просит без движения', false);
  });
}

if (gif.complete && gif.naturalWidth) {
  startAnimation();
} else {
  // До границы ждём загрузку, чтобы анимировать уже готовую картинку
  gif.addEventListener('load', startAnimation, { once: true });
  // Если картинка не загрузилась — всё равно показываем окно, а не пустоту
  gif.addEventListener('error', startAnimation, { once: true });
  // Страховка: сеть могла подвиснуть — через 3 сек показываем что есть
  setTimeout(startAnimation, 3000);
  // Если картинка к этому моменту ещё грузится — дальше уже ждать нечего:
  // показываем окно сразу, а картинка дорисуется без анимации появления.
  setTimeout(() => {
    if (!started) {
      gif.style.opacity = '1';
      startAnimation();
    }
  }, START_DEADLINE_MS);
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

// ============================================
// Диагностика: почему на некоторых ПК нет анимаций
// ============================================
// Самая частая причина — системная настройка «уменьшить движение»
// (Windows: отключены анимации в параметрах специальных возможностей).
// Тогда Chrome сообщает странице prefers-reduced-motion: reduce.
// Раньше это гасило и появление — теперь нет, но проверить всё равно надо.
const reducedMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

// Без аппаратного ускорения Chrome рисует blur в CSS-фильтрах на CPU, и
// появление «в расфокусе» может дёргаться или не проигрываться вовсе.
// В таком случае берём вариант без blur: только transform и opacity.
// Проверяем настоящую видеокарту: у софт-рендера рендерер просит
// «SwiftShader» или «ANGLE (Software».
const gpuRenderer = (() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
  } catch (e) {
    return '';
  }
})();
const softwareRenderer = !gpuRenderer || /swiftshader|software|llvmpipe|basic render/i.test(gpuRenderer);
if (softwareRenderer) document.documentElement.classList.add('no-blur');

console.log('[перекур] стиль появления:', style,
            '| уменьшить движение:', reducedMotion ? 'ВКЛ (система просит меньше анимаций)' : 'выкл',
            '| видео:', gpuRenderer || 'нет',
            '| разрешение:', window.screen.width + 'x' + window.screen.height);

// Если открыто с &diag=1 — показываем причины прямо в окне.
// Так на «проблемном» компьютере сразу видно, что чинить.
const diagBox = document.getElementById('diag');
if (diagBox && params.get('diag') === '1') {
  diagBox.hidden = false;
  diagBox.innerHTML = '';
  const line = (text, warn) => {
    const d = document.createElement('div');
    d.textContent = text;
    if (warn) d.className = 'warn';
    diagBox.appendChild(d);
    return d;
  };
  line('стиль: ' + style + (document.documentElement.classList.contains('no-blur') ? ' (без blur)' : ''));
  line('анимации системы: ' + (reducedMotion ? 'отключены' : 'включены'),
       reducedMotion);
  line('видео: ' + (gpuRenderer || 'нет (софт-рендер)'), !gpuRenderer);
  line('экран: ' + window.screen.width + ' x ' + window.screen.height);
  line('размер окна: ' + window.innerWidth + ' x ' + window.innerHeight);
  if (reducedMotion) {
    line('→ Windows: Параметры → Специальные возможности →');
    line('   Отображение → «Показывать анимации в Windows»: ВКЛ');
    line('   (появление шрека работает и без этого)');
  }
}

// Отчёт на сервер, чтобы причину было видно в журнале без доступа к ПК.
try {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({
      action: 'shrekDiag',
      data: { style: style, reducedMotion: reducedMotion }
    }, () => { void chrome.runtime.lastError; });
  }
} catch (e) { /* диагностика не должна ломать показ */ }
