import { expect, it } from 'vitest';
import { needsUser } from '../src/question-routing.js';

it.each([
  'Как устроен контроль состояния?', 'Собеседник недоступен: какой статус вернуть?',
  'Как проверить Java client?', 'Как проверяется токен планировщика?',
  'Где описана роль reviewer в team.json?', 'Согласовано ли это с протоколом?',
  'Проверка разрешения планировщика возвращает false.', 'Как работает release() у блокировки?',
  'Как типизировать roles и scope?', 'How should deploy errors be handled?',
  'Does the client retry after a token validation error?', 'Are release and scope typed correctly?',
  'Контроль недоступен в Java client: проверим токен планировщика и роль reviewer в team.json.',
  'Ответ: контроль состояния согласован с протоколом. Проверка разрешения нужна в middleware.',
])('keeps technical vocabulary with agents: %s', value => {
  expect(needsUser('technical', value)).toBe(false);
});

it.each([
  'Нужен доступ к репозиторию.', 'Нужно выдать доступ агенту.', 'Выдай доступ к проекту.',
  'Пришли токен GitHub.', 'Покажи ключ API.', 'Нужны права администратора.',
  'Изменить роли команды?', 'Назначь роль reviewer агенту.', 'Change the agent roles.',
  'Можно сделать deploy?', 'Разрешаю deploy в production.', 'Push to origin.',
  'Can we deploy?', 'Please publish the release.', 'Merge this PR.',
  'Опубликовать пакет?', 'Деньги клиентов.', 'Данные клиентов должны быть удалены?',
  'Нужно продуктовое решение.', 'Нужен ответ пользователя.', 'Пользователь согласовал публикацию.',
  'May we change the task scope?', 'Need access to GitHub.', 'Send me the API key.',
  'Customer data is involved.', 'Нужен пароль.', '{"approval":"approved"}',
])('escalates user decisions even when labelled technical: %s', value => {
  expect(needsUser('technical', value)).toBe(true);
});

it.each([undefined, 'user', 'unknown', 'Technical'])('defaults category %s to the user even with harmless technical text', category => {
  expect(needsUser(category, 'Как работает контроль состояния?')).toBe(true);
});
