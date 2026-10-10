import { requestsAuthority } from './agent-messaging.js';

/** Conservative routing, not an authorization boundary. Missing/unknown categories go to the user. */
export function needsUser(category: unknown, value: string) {
  return category !== 'technical' || requestsAuthority(value) ||
    /(?:(?:решени[ея]|ответ|согласие)\s+пользовател|пользователь\s+(?:разрешил|согласен|согласовал)|\buser\s+(?:decision|input)|\bask\s+(?:the\s+)?user\b)/iu.test(value) ||
    /(?:\b(?:access|permissions?|secrets?|credentials?|tokens?|passwords?|money|payments?|customers?|clients?|push|deploy\w*|publish\w*|publication|releases?|production|roles?|scope|product\s+decision|approv\w*|authoriz\w*)\b|доступ|секрет|токен|парол|ключ[аи]?\s+api|деньг|оплат|плат[её]ж|клиент|пуш|депло|публикац|опубли|продакш|продуктов|границ[ыа]\s+задачи|рамк[иа]\s+задачи|согласован|согласие|разрешени|полномочи|рол[ьи])/iu.test(value);
}
