import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MAX_FILE = 5 * 1024 * 1024;
const SESSION_TTL = 3 * 86400; // initData живёт 3 суток
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
const send = (chat_id, text, reply_markup) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup });

async function sendFile(chat_id, buf, type, name, caption, reply_markup) {
  const kind = type.startsWith('image/') && type !== 'image/gif' ? ['sendPhoto', 'photo'] : type.startsWith('video/') ? ['sendVideo', 'video'] : ['sendDocument', 'document'];
  const go = ([method, field]) => {
    const fd = new FormData();
    fd.append('chat_id', String(chat_id));
    fd.append(field, new Blob([buf], { type }), name);
    fd.append('caption', caption.slice(0, 1000));
    fd.append('parse_mode', 'HTML');
    if (reply_markup) fd.append('reply_markup', JSON.stringify(reply_markup));
    return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', body: fd }).then(r => r.json()).catch(() => ({ ok: false }));
  };
  const r = await go(kind);
  return !r.ok && kind[0] !== 'sendDocument' ? go(['sendDocument', 'document']) : r;
}

async function tgDownload(file_id) {
  const f = await tg('getFile', { file_id });
  if (!f.ok || (f.result.file_size ?? 0) > MAX_FILE) return null;
  const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.result.file_path}`);
  return r.ok ? r.arrayBuffer() : null;
}

const chatBtn = id => ({ text: '💬 Открыть чат', web_app: { url: `${WEBAPP_URL}/#order=${id}` }, style: 'primary' });
const adminKb = o => ({ inline_keyboard: [
  [{ text: 'В работу', callback_data: `st:${o.id}:IN_PROGRESS`, style: 'primary' }, { text: 'Завершить', callback_data: `st:${o.id}:COMPLETED`, style: 'success' }],
  [{ text: 'Отклонить', callback_data: `st:${o.id}:REJECTED`, style: 'danger' }, chatBtn(o.id)],
] });
const chatKb = id => ({ inline_keyboard: [[chatBtn(id)]] });

// сообщение админу + запоминаем его id: ответ (reply) на него в боте уйдёт клиенту в чат
async function toAdmin(s, orderId, r) {
  const mid = r?.result?.message_id;
  if (mid) await putJ(s, `tg:${mid}`, orderId);
}

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
async function patchOrder(s, id, fn) {          // чтение → правка → запись как можно короче
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
  if (o && changed) await send(o.user_id, `Статус вашего заказа <b>#${o.id}</b> изменён:\n${LABEL[status]}`, chatKb(o.id));
  return o;
}

// каждое сообщение — отдельный ключ: параллельные записи не затирают друг друга
const mkey = (oid, id) => `msg:${oid}:${String(id).padStart(16, '0')}`;
async function addMsg(s, o, isAdmin, text, file, buf, origType) {
  const id = Date.now() * 10 + crypto.randomInt(10);
  const msg = { id, order_id: o.id, sender_type: isAdmin ? 'ADMIN' : 'CLIENT', text, created_at: Date.now() };
  if (file) msg.file = file;
  await putJ(s, mkey(o.id, id), msg);
  await patchOrder(s, o.id, x => {
    x.last = { at: msg.created_at, from: msg.sender_type, text: text ? text.slice(0, 80) : '📎 ' + (file?.name || 'файл') };
    x[isAdmin ? 'unread_client' : 'unread_admin'] = true;
  });
  const to = isAdmin ? o.user_id : ADMIN_ID;
  const head = isAdmin ? `💬 <b>Заказ #${o.id}</b>` : `💬 <b>Заказ #${o.id}</b> · ${esc(o.name)}`;
  const body = `${head}${text ? '\n' + esc(text) : ''}`;
  const r = file ? await sendFile(to, buf, origType || file.type, file.name, body, chatKb(o.id)) : await send(to, body, chatKb(o.id));
  if (!isAdmin) await toAdmin(s, o.id, r);
  return msg;
}
async function attach(s, o, isAdmin, buf, origType, name, caption) {
  const type = SAFE.has(origType) ? origType : 'application/octet-stream';
  const fid = crypto.randomBytes(12).toString('hex');
  await s.set(`file:${fid}`, buf, { metadata: { type, name, order_id: o.id } });
  return addMsg(s, o, isAdmin, caption, { id: fid, name, type, size: buf.byteLength }, buf, origType);
}

/* ---------- Webhook бота ---------- */
async function webhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  const u = await req.json().catch(() => ({}));
  try {
    const s = store();
    const m = u.message;
    if (m?.text?.startsWith('/start')) {
      await send(m.chat.id, 'Добро пожаловать в MAISONAX! Кнопка «Открыть MAISONAX» внизу всегда под рукой.',
        { keyboard: [[{ text: 'Открыть MAISONAX', web_app: { url: WEBAPP_URL }, style: 'primary' }]], resize_keyboard: true, is_persistent: true });
    } else if (m && m.from?.id === ADMIN_ID && m.reply_to_message) {
      // админ отвечает reply'ем на уведомление → сообщение уходит клиенту в чат заказа
      const oid = await getJ(s, `tg:${m.reply_to_message.message_id}`);
      const o = oid && await getOrder(s, oid);
      if (o) {
        let ok = false;
        const cap = clip(m.caption || m.text, 1000);
        if (m.text) { await addMsg(s, o, true, clip(m.text, 2000)); ok = true; }
        else if (m.photo || m.document) {
          const buf = await tgDownload(m.photo ? m.photo.at(-1).file_id : m.document.file_id);
          if (buf) { await attach(s, o, true, buf, m.photo ? 'image/jpeg' : (m.document.mime_type || ''), clip(m.document?.file_name || 'photo.jpg', 100), cap); ok = true; }
        }
        await tg('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: ok ? '👍' : '👎' }] });
      }
    }
    const cb = u.callback_query;
    const c = cb?.data?.match(/^st:(\d+):(\w+)$/);
    if (c) {
      if (cb.from.id !== ADMIN_ID || !STATUSES.includes(c[2])) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' }); }
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
  return json({ ok: true }); // всегда 200, чтобы Telegram не повторял запрос бесконечно
}

/* ---------- API ---------- */
const handle = async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

  if (path === '/webhook' && req.method === 'POST') return webhook(req);

  if (path === '/setup') { // разово: /api/setup?key=<WEBHOOK_SECRET>
    if (!WEBHOOK_SECRET || url.searchParams.get('key') !== WEBHOOK_SECRET) return json({ error: 'forbidden', secret_set: !!WEBHOOK_SECRET, token_set: !!BOT_TOKEN, admin_set: !!ADMIN_ID, url_set: !!WEBAPP_URL }, 403);
    const hook = await tg('setWebhook', { url: `${WEBAPP_URL}/api/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'MAISONAX', web_app: { url: WEBAPP_URL } } });
    const cmds = await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть MAISONAX' }] });
    return json({ webhook: hook, menu, cmds });
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
    const r = await send(ADMIN_ID,
      `🔔 <b>Новый заказ #${o.id}</b>\n👤 Имя: ${esc(name)}\n📞 Тел: ${esc(phone)}\n` +
      `✈️ TG: ${o.username ? '@' + esc(o.username) : `<a href="tg://user?id=${o.user_id}">профиль</a>`}\n` +
      `💼 Услуга: ${esc(service_type)}\n📝 Задача: ${esc(description)}\n\n<i>Ответьте (reply) на это сообщение — текст уйдёт клиенту в чат.</i>`, adminKb(o));
    await toAdmin(s, o.id, r);
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
