// Общая конфигурация расширения «Перекур»
// Используется и в popup.js, и в background.js (через importScripts),
// поэтому все функции должны регистрироваться в self/globalThis.
(function (root) {
  const SERVER_PORT = 3000;

  // GitHub-репозиторий для проверки версии.
  // Внимание: сам адрес version.txt здесь НЕ нужен — popup.js запрашивает
  // его через GitHub API (api.github.com), а не через raw.githubusercontent.
  const DEFAULT_GITHUB_REPO = 'Shaunus22/perekur';

  // Превращает введённый адрес в полный URL сервера:
  //  192.168.1.132           -> http://192.168.1.132:3000
  //  localhost               -> http://localhost:3000
  //  perekur.example.com     -> https://perekur.example.com
  //  https://perekur.example.com/ -> как есть (без слеша)
  function normalizeServerURL(input) {
    if (!input) return '';
    let v = String(input).trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(v)) return v;
    if (v === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
      return 'http://' + v + ':' + SERVER_PORT;
    }
    return 'https://' + v;
  }

  // Заголовки для запросов к серверу. Если в настройках задан общий токен,
  // отправляем его в X-Perekur-Token — сервер без токена запросов не принимает.
  function apiHeaders(token) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token != null ? token : (root.PEREKUR_TOKEN || '');
    if (t) headers['X-Perekur-Token'] = t;
    return headers;
  }

  root.SERVER_PORT = SERVER_PORT;
  root.DEFAULT_GITHUB_REPO = DEFAULT_GITHUB_REPO;
  root.normalizeServerURL = normalizeServerURL;
  root.apiHeaders = apiHeaders;
})(typeof self !== 'undefined' ? self : this);
