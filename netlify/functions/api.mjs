import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MAX_FILE = 5 * 1024 * 1024;
const SESSION_TTL = 3 * 86400;      // initData живёт 3 суток
const RENOTIFY_MS = 30 * 60 * 1000; // повторное уведомление о непрочитанном — не чаще раза в 30 минут
const STATUSES = ['NEW', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'];
const LABEL = { NEW: '🟡 В ожидании', IN_PROGRESS: '🔵 В работе', COMPLETED: '🟢 Исполнен', REJECTED: '🔴 Отклонён' };
const SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm']);

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const store = () => getStore({ name: 'maisonax', consistency: 'strong' });
const getJ = (s, k) => s.get(k, { type: 'json' });
const putJ = (s, k, v, o) => s.set(k, JSON.stringify(v), o);

/* ---------- Telegram ---------- */
const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
const send = (chat_id, text, reply_markup) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });

// ВАЖНО: web_app через inline-кнопку (или кнопку меню) передаёт initData. Кнопка обычной клавиатуры — нет.
const appBtn = (text, hash = '', style = 'primary') => ({ text, web_app: { url: WEBAPP_URL + (hash ? '/#' + hash : '') }, style });
const chatBtn = id => appBtn('💬 Открыть чат', `order=${id}`);
const chatKb = id => ({ inline_keyboard: [[chatBtn(id)]] });
const profileBtn = o => ({ text: '✈️ Профиль клиента', url: o.username ? `https://t.me/${o.username}` : `tg://user?id=${o.user_id}` });
const adminKb = o => ({ inline_keyboard: [
  [{ text: 'В работу', callback_data: `st:${o.id}:IN_PROGRESS`, style: 'primary' }, { text: 'Завершить', callback_data: `st:${o.id}:COMPLETED`, style: 'success' }],
  [{ text: 'Отклонить', callback_data: `st:${o.id}:REJECTED`, style: 'danger' }, chatBtn(o.id)],
  [profileBtn(o)],
] });
const clientMenu = { keyboard: [[{ text: '📝 Новая заявка' }, { text: '📋 Мои заказы' }], [{ text: '❓ Помощь' }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Выберите действие' };
const adminMenu = { keyboard: [[{ text: '📋 Все заказы' }, { text: '📊 Статистика' }], [{ text: '❓ Помощь' }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Выберите действие' };

const STATUS_TEXT = {
  NEW: id => `🟡 Заказ <b>#${id}</b> снова в ожидании.`,
  IN_PROGRESS: id => `🔵 Заказ <b>#${id}</b> принят в работу. Мы на связи в чате.`,
  COMPLETED: id => `🟢 Заказ <b>#${id}</b> исполнен. Спасибо, что выбрали MAISONAX!`,
  REJECTED: id => `🔴 Заказ <b>#${id}</b> отклонён. Подробности — в чате.`,
};

/* ---------- Авторизация ---------- */
function verifyInitData(raw) {
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > SESSION_TTL) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------- Хранилище ---------- */
const getOrder = (s, id) => getJ(s, `order:${id}`);
async function patchOrder(s, id, fn) {
  const o = await getOrder(s, id);
  if (!o) return null;
  fn(o);
  await putJ(s, `order:${id}`, o);
  return o;
}
async function listOrders(s) {
  const { blobs } = await s.list({ prefix: 'order:' });
  const all = await Promise.all(blobs.map(b => getJ(s, b.key)));
  return all.filter(Boolean).sort((a, b) => b.id - a.id);
}
async function createOrder(s, data) {
  let seq = (await getJ(s, 'seq')) ?? 1000;
  for (;;) {
    seq++;
    if (await s.get(`order:${seq}`)) continue;
    const o = { ...data, id: seq };
    const r = await s.set(`order:${seq}`, JSON.stringify(o), { onlyIfNew: true });
    if (r?.modified === false) continue;
    await putJ(s, 'seq', seq);
    return o;
  }
}
async function setStatus(s, id, status) {
  let changed = false;
  const o = await patchOrder(s, id, x => { changed = x.status !== status; x.status = status; });
  if (o && changed) await send(o.user_id, STATUS_TEXT[status](o.id), chatKb(o.id));
  return o;
}

// Каждое сообщение — отдельный ключ. В Telegram текст переписки НЕ дублируется:
// получатель видит только уведомление «непрочитанное сообщение» (не чаще раза в 30 минут, пока не прочитает).
const mkey = (oid, id) => `msg:${oid}:${String(id).padStart(16, '0')}`;
async function addMsg(s, o, isAdmin, text, file) {
  const id = Date.now() * 10 + crypto.randomInt(10);
  const msg = { id, order_id: o.id, sender_type: isAdmin ? 'ADMIN' : 'CLIENT', text, created_at: Date.now() };
  if (file) msg.file = file;
  await putJ(s, mkey(o.id, id), msg);
  const side = isAdmin ? 'client' : 'admin', flag = 'unread_' + side;
  let notify = false;
  const fresh = await patchOrder(s, o.id, x => {
    const now = Date.now();
    x.notif ||= {};
    notify = !x[flag] || now - (x.notif[side] || 0) > RENOTIFY_MS;
    x[flag] = true;
    if (notify) x.notif[side] = now;
    x.last = { at: msg.created_at, from: msg.sender_type, text: text ? text.slice(0, 80) : '📎 ' + (file?.name || 'файл') };
  });
  if (notify && fresh) {
    if (isAdmin) await send(fresh.user_id, `💬 У Вас непрочитанное сообщение (Заказ #${fresh.id})`, chatKb(fresh.id));
    else await send(ADMIN_ID, `💬 У Вас непрочитанное сообщение (Заказ #${fresh.id} · ${esc(fresh.name)})`, chatKb(fresh.id));
  }
  return msg;
}
async function attach(s, o, isAdmin, buf, origType, name, caption) {
  const type = SAFE.has(origType) ? origType : 'application/octet-stream';
  const fid = crypto.randomBytes(12).toString('hex');
  await s.set(`file:${fid}`, buf, { metadata: { type, name, order_id: o.id } });
  return addMsg(s, o, isAdmin, caption, { id: fid, name, type, size: buf.byteLength });
}

/* ---------- Бот ---------- */
const HELP_CLIENT = `<b>MAISONAX</b> — сайты, чат-боты и автоматизация для бизнеса.

📝 <b>Новая заявка</b> — опишите задачу, мы свяжемся с вами
📋 <b>Мои заказы</b> — статусы и чат с командой
💬 Переписка идёт в приложении, а сюда приходят уведомления

Команды: /new · /orders · /help`;
const HELP_ADMIN = `<b>Панель администратора</b>

📋 <b>Все заказы</b> — список и чаты в приложении
📊 <b>Статистика</b> — сводка по статусам
Статус заказа можно менять кнопками в уведомлении или в приложении.

Команды: /orders · /stats · /help`;

async function stats(s) {
  const all = await listOrders(s);
  const by = k => all.filter(o => o.status === k).length;
  const today = all.filter(o => Date.now() - o.created_at < 86400000).length;
  const unread = all.filter(o => o.unread_admin).length;
  return `📊 <b>Статистика</b>\n\nВсего заказов: <b>${all.length}</b>\nЗа 24 часа: <b>${today}</b>\n\n🟡 В ожидании: ${by('NEW')}\n🔵 В работе: ${by('IN_PROGRESS')}\n🟢 Исполнено: ${by('COMPLETED')}\n🔴 Отклонено: ${by('REJECTED')}\n\n💬 С непрочитанными: <b>${unread}</b>`;
}

async function onMessage(s, m) {
  if (m.chat.type !== 'private') return;
  const isAdmin = m.from.id === ADMIN_ID;
  const t = (m.text || '').trim();
  const cmd = t.startsWith('/') ? t.split(/[\s@]/)[0].toLowerCase() : t;
  const id = m.chat.id;

  if (cmd === '/start') {
    await send(id, `Добро пожаловать в <b>MAISONAX</b>! 👋\n\nОставляйте заявки и общайтесь с командой прямо в Telegram. Нажмите кнопку ниже:`,
      { inline_keyboard: [[appBtn(isAdmin ? '🚀 Открыть панель' : '🚀 Открыть MAISONAX')], ...(isAdmin ? [] : [[appBtn('📝 Новая заявка', 'new', 'success'), appBtn('📋 Мои заказы', 'orders', 'primary')]])] });
    return send(id, 'Быстрое меню включено 👇', isAdmin ? adminMenu : clientMenu);
  }
  if (cmd === '/new' || t === '📝 Новая заявка') {
    return send(id, 'Оформите заявку за минуту — опишите задачу, и мы свяжемся с вами 👇', { inline_keyboard: [[appBtn('📝 Оставить заявку', 'new', 'success')]] });
  }
  if (cmd === '/orders' || t === '📋 Мои заказы' || t === '📋 Все заказы') {
    if (isAdmin) {
      const all = await listOrders(s);
      const fresh = all.filter(o => o.status === 'NEW').length, unread = all.filter(o => o.unread_admin).length;
      return send(id, `📋 Заказов: <b>${all.length}</b>\n🟡 Новых: <b>${fresh}</b>\n💬 С непрочитанными: <b>${unread}</b>`, { inline_keyboard: [[appBtn('Открыть заказы', 'orders')]] });
    }
    const mine = (await listOrders(s)).filter(o => o.user_id === m.from.id).slice(0, 5);
    if (!mine.length) return send(id, 'У вас пока нет заказов. Оставьте первую заявку 👇', { inline_keyboard: [[appBtn('📝 Оставить заявку', 'new', 'success')]] });
    const lines = mine.map(o => `<b>#${o.id}</b> · ${esc(o.service_type)} — ${LABEL[o.status]}${o.unread_client ? ' 💬' : ''}`).join('\n');
    return send(id, `📋 <b>Ваши заказы</b>\n\n${lines}`, { inline_keyboard: [...mine.map(o => [appBtn(`#${o.id} · ${LABEL[o.status].slice(3)}`, `order=${o.id}`, 'primary')]), [appBtn('Все заказы', 'orders')]] });
  }
  if (cmd === '/stats' || t === '📊 Статистика') {
    if (!isAdmin) return;
    return send(id, await stats(s), { inline_keyboard: [[appBtn('Открыть заказы', 'orders')]] });
  }
  if (cmd === '/help' || t === '❓ Помощь') return send(id, isAdmin ? HELP_ADMIN : HELP_CLIENT, { inline_keyboard: [[appBtn('🚀 Открыть MAISONAX')]] });
  if (!isAdmin) return send(id, 'Чтобы написать команде по заказу, откройте чат в приложении 👇', { inline_keyboard: [[appBtn('📋 Мои заказы', 'orders'), appBtn('📝 Новая заявка', 'new', 'success')]] });
}

async function webhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  const u = await req.json().catch(() => ({}));
  try {
    const s = store();
    if (u.update_id) { // Telegram иногда присылает апдейт повторно — пропускаем уже обработанные
      const seen = (await getJ(s, 'lastupd')) ?? 0;
      if (u.update_id <= seen) return json({ ok: true });
      await putJ(s, 'lastupd', u.update_id);
    }
    if (u.message) await onMessage(s, u.message);
    const cb = u.callback_query;
    const c = cb?.data?.match(/^st:(\d+):(\w+)$/);
    if (c) {
      if (cb.from.id !== ADMIN_ID || !STATUSES.includes(c[2])) await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' });
      else {
        const o = await setStatus(s, c[1], c[2]);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: o ? LABEL[c[2]] : 'Заказ не найден' });
        if (o) {
          const base = (cb.message?.text || '').split('\n\nСтатус:')[0];
          await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML',
            text: `${esc(base)}\n\n<b>Статус: ${LABEL[c[2]]}</b>`, reply_markup: adminKb(o) });
        }
      }
    }
  } catch (e) { console.error('webhook', e); }
  return json({ ok: true }); // всегда 200, чтобы Telegram не повторял запрос
}

/* ---------- API ---------- */
const handle = async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

  if (path === '/webhook' && req.method === 'POST') return webhook(req);

  if (path === '/setup') { // разово после деплоя: /api/setup?key=<WEBHOOK_SECRET>
    const plain = (o, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!WEBHOOK_SECRET || url.searchParams.get('key') !== WEBHOOK_SECRET) return plain({ error: 'forbidden', secret_set: !!WEBHOOK_SECRET, token_set: !!BOT_TOKEN, admin_set: !!ADMIN_ID, url_set: !!WEBAPP_URL }, 403);
    const r = {};
    r.webhook = (await tg('setWebhook', { url: `${WEBAPP_URL}/api/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false })).ok;
    r.menu = (await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'MAISONAX', web_app: { url: WEBAPP_URL } } })).ok;
    r.commands = (await tg('setMyCommands', { commands: [
      { command: 'start', description: 'Открыть MAISONAX' }, { command: 'new', description: 'Новая заявка' },
      { command: 'orders', description: 'Мои заказы' }, { command: 'help', description: 'Помощь' }] })).ok;
    r.admin_commands = (await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [
      { command: 'start', description: 'Панель' }, { command: 'orders', description: 'Все заказы' },
      { command: 'stats', description: 'Статистика' }, { command: 'help', description: 'Помощь' }] })).ok;
    r.description = (await tg('setMyDescription', { description: 'MAISONAX — сайты, чат-боты и автоматизация для бизнеса. Оставьте заявку и общайтесь с командой прямо в Telegram: статусы заказов, чат и уведомления в одном месте.' })).ok;
    r.short = (await tg('setMyShortDescription', { short_description: 'Заявки и чат с командой MAISONAX' })).ok;
    return plain(r);
  }

  const user = verifyInitData(req.headers.get('x-init-data'));
  if (!user) return json({ error: 'unauthorized' }, 401);
  const isAdmin = user.id === ADMIN_ID;
  const s = store();
  const isJson = (req.headers.get('content-type') || '').includes('json');
  const body = ['POST', 'PATCH'].includes(req.method) && isJson ? await req.json().catch(() => ({})) : {};

  if (path === '/me') return json({ id: user.id, name: user.first_name, admin: isAdmin });

  if (path === '/orders' && req.method === 'POST') {
    const name = clip(body.name, 80), phone = clip(body.phone, 30), service_type = clip(body.service_type, 80), description = clip(body.description, 2000);
    if (!name || !/^\+?[\d\s()\-]{6,20}$/.test(phone) || !service_type || !description) return json({ error: 'invalid_fields' }, 400);
    const mine = (await listOrders(s)).filter(o => o.user_id === user.id);
    if (!isAdmin && mine.filter(o => Date.now() - o.created_at < 600000).length >= 3) return json({ error: 'rate_limit' }, 429);
    const o = await createOrder(s, { user_id: user.id, username: user.username || null, name, phone, service_type, description, status: 'NEW', created_at: Date.now() });
    await send(ADMIN_ID,
      `🔔 <b>Новый заказ #${o.id}</b>\n\n👤 ${esc(name)}\n📞 ${esc(phone)}\n✈️ ${o.username ? '@' + esc(o.username) : 'без username'}\n💼 ${esc(service_type)}\n\n📝 ${esc(description)}`, adminKb(o));
    await send(o.user_id, `✅ Заявка <b>#${o.id}</b> принята!\nМы свяжемся с вами в ближайшее время. Статус и переписка — в чате заказа 👇`, chatKb(o.id));
    return json(o);
  }
  if (path === '/orders/my') return json((await listOrders(s)).filter(o => o.user_id === user.id));
  if (path === '/orders/admin') return isAdmin ? json(await listOrders(s)) : json({ error: 'forbidden' }, 403);

  const fm = path.match(/^\/files\/([0-9a-f]{24})$/);
  if (fm) {
    const f = await s.getWithMetadata(`file:${fm[1]}`, { type: 'arrayBuffer' });
    if (!f) return json({ error: 'not_found' }, 404);
    const fo = await getOrder(s, f.metadata.order_id);
    if (!fo || (!isAdmin && fo.user_id !== user.id)) return json({ error: 'forbidden' }, 403);
    return new Response(f.data, { headers: { 'Content-Type': f.metadata.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } });
  }

  const m = path.match(/^\/orders\/(\d+)(?:\/(status|messages|upload))?$/);
  if (!m) return json({ error: 'not_found' }, 404);
  const o = await getOrder(s, m[1]);
  if (!o) return json({ error: 'not_found' }, 404);
  if (!isAdmin && o.user_id !== user.id) return json({ error: 'forbidden' }, 403);

  if (!m[2]) return json(o);

  if (m[2] === 'status' && req.method === 'PATCH') {
    if (!isAdmin) return json({ error: 'forbidden' }, 403);
    if (!STATUSES.includes(body.status)) return json({ error: 'bad_status' }, 400);
    return json(await setStatus(s, o.id, body.status));
  }

  if (m[2] === 'upload' && req.method === 'POST') {
    if (Number(req.headers.get('content-length')) > MAX_FILE + 2048) return json({ error: 'size' }, 413);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_FILE) return json({ error: 'size' }, 413);
    const dec = h => { try { return decodeURIComponent(req.headers.get(h) || ''); } catch { return ''; } };
    const name = clip(dec('x-file-name') || 'file', 100).replace(/[\r\n"]/g, '');
    const origType = clip(req.headers.get('x-file-type'), 100).toLowerCase() || 'application/octet-stream';
    return json(await attach(s, o, isAdmin, buf, origType, name, clip(dec('x-caption'), 1000)));
  }

  if (m[2] === 'messages') {
    if (req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      const { blobs } = await s.list({ prefix: `msg:${o.id}:` });
      const keys = blobs.map(b => b.key).filter(k => Number(k.split(':')[2]) > after).sort();
      const msgs = (await Promise.all(keys.map(k => getJ(s, k)))).filter(Boolean);
      const flag = isAdmin ? 'unread_admin' : 'unread_client';
      if (o[flag]) await patchOrder(s, o.id, x => { x[flag] = false; });
      return json(msgs);
    }
    if (req.method === 'POST') {
      const text = clip(body.text, 2000);
      if (!text) return json({ error: 'empty' }, 400);
      return json(await addMsg(s, o, isAdmin, text));
    }
  }
  return json({ error: 'not_found' }, 404);
};

export default async (req) => {
  try { return await handle(req); }
  catch (e) { console.error(e); await send(ADMIN_ID, '⚠️ Ошибка сервера: ' + esc(e.message)); return json({ error: 'server' }, 500); }
};

export const config = { path: '/api/*' };
