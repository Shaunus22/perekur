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
