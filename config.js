// Общая конфигурация расширения «Перекур»
const SERVER_PORT = 3000;
const DEFAULT_SERVER_IP = '192.168.185.128';
const DEFAULT_SERVER_URL = `http://${DEFAULT_SERVER_IP}:${SERVER_PORT}`;

// GitHub-репозиторий для проверки версии (замените на ваш owner/repo)
const DEFAULT_GITHUB_REPO = 'username/perekur';
const GITHUB_BRANCH = 'main';
const GITHUB_VERSION_URL = `https://raw.githubusercontent.com/${DEFAULT_GITHUB_REPO}/${GITHUB_BRANCH}/version.txt`;
