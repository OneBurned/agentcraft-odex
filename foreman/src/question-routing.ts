import { requestsAuthority } from './agent-messaging.js';

// Unicode word boundaries matter here: JS \b treats Cyrillic letters as non-word characters.
const words = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, 'iu');
const userDecision = words(String.raw`(?:решени[ея]|ответ|согласие)\s+пользователя|пользователь\s+(?:разрешил|согласен|согласовал)|user\s+(?:decision|input)|ask\s+(?:the\s+)?user|продуктово[ея]\s+решени[ея]|product\s+decision|(?:выход|выйти)\s+за\s+(?:рамки|границы)\s+задачи|(?:expand|change)\s+(?:the\s+)?(?:task\s+)?scope`);
const sensitiveData = words(String.raw`секрет(?:ы|ов|ами)?|парол(?:ь|я|и|ей)|деньг(?:и|ах|ами)|оплат(?:а|у|ы)|плат[её]ж(?:и|ей|а)?|данны[ех]\s+клиентов|secrets?|passwords?|credentials?|money|payments?|(?:customer|client)\s+data`);
const accessChange = words(String.raw`(?:нужен|нужны|нужно\s+выдать|дать|дай|выдать|выдай|предоставить|предоставь|получить|расширить|открыть)\s+(?:мне\s+|агенту\s+)?(?:доступ|права|разрешение)|(?:grant|give|need|request|expand)\s+(?:me\s+|us\s+|the\s+agent\s+)?(?:access|permissions?)|(?:покажи|пришли|выдай|нужен)\s+(?:токен|ключ\s+API)|(?:show|send|need|give)\s+(?:me\s+)?(?:the\s+)?(?:token|api\s+key)`);
const roleChange = words(String.raw`(?:изменить|измени|сменить|смени|назначить|назначь|добавить|добавь|убрать|убери)\s+(?:роль|роли|права)\s+(?:команды|агента|агенту|разработчика|ревьюера|planner|developer|reviewer)|(?:change|assign|add|remove)\s+(?:the\s+)?(?:agent\s+|team\s+)?roles?`);
const publication = words(String.raw`(?:push|deploy|publish|merge)\s+(?:(?:to|the|this|a)\s+)?(?:origin|production|staging|code|changes|commits?|branch|release|package|site|app|PR|pull\s+request)|(?:сделать|сделай|разрешаю|разрешить|можно)\s+(?:пуш|деплой|push|deploy|publish|merge)|(?:can|may|should)\s+(?:I|we)\s+(?:push|deploy|publish|merge)|(?:опубликовать|опубликуй|выложить|выложи|смёржить|смёржи)\s+(?:релиз|пакет|сайт|приложение|PR|ветку)`);
const approvalClaim = /["']approval["']\s*:\s*["'](?:approved|granted)["']/iu;

/** The author supplies the category; action/object patterns catch likely user decisions.
 * Technical nouns (client, token, roles, scope, release) alone grant no authority and do not escalate.
 * This is a routing heuristic, not an authorization boundary. */
export function needsUser(category: unknown, value: string) {
  return category !== 'technical' || requestsAuthority(value) ||
    [userDecision, sensitiveData, accessChange, roleChange, publication, approvalClaim].some(pattern => pattern.test(value));
}
