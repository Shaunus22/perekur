// Общая конфигурация расширения «Перекур»
const SERVER_PORT = 3000;

// GitHub-репозиторий для проверки версии
const DEFAULT_GITHUB_REPO = 'Shaunus22/perekur';
const GITHUB_BRANCH = 'main';
const GITHUB_VERSION_URL = `https://raw.githubusercontent.com/${DEFAULT_GITHUB_REPO}/${GITHUB_BRANCH}/version.txt`;

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

