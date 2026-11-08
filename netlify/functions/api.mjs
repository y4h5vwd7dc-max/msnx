import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
const ADMIN_ID = Number(process.env.ADMIN_ID);

const STATUSES = ['NEW', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'];
const LABEL = { NEW: '🟡 В ожидании', IN_PROGRESS: '🔵 В работе', COMPLETED: '🟢 Исполнен', REJECTED: '🔴 Отклонён' };
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const store = () => getStore({ name: 'maisonax', consistency: 'strong' });

/* ---------- Telegram ---------- */
const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

const send = (chat_id, text, reply_markup) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup });
const chatBtn = id => ({ text: '💬 Открыть чат', web_app: { url: `${WEBAPP_URL}/#order=${id}` }, style: 'primary' });
const adminKb = o => ({ inline_keyboard: [
  [{ text: 'В работу', callback_data: `st:${o.id}:IN_PROGRESS`, style: 'primary' }, { text: 'Завершить', callback_data: `st:${o.id}:COMPLETED`, style: 'success' }],
  [{ text: 'Отклонить', callback_data: `st:${o.id}:REJECTED`, style: 'danger' }, chatBtn(o.id)],
] });
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
  if (!r.ok && kind[0] !== 'sendDocument') await go(['sendDocument', 'document']);
}
const SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm']);
const chatKb = id => ({ inline_keyboard: [[chatBtn(id)]] });

/* ---------- Авторизация (подпись initData) ---------- */
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
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

/* ---------- Хранилище ---------- */
const getOrder = (s, id) => s.get(`order:${id}`, { type: 'json' });
async function listOrders(s) {
  const { blobs } = await s.list({ prefix: 'order:' });
  const all = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' })));
  return all.filter(Boolean).sort((a, b) => b.id - a.id);
}
async function createOrder(s, data) {
  let seq = (await s.get('seq', { type: 'json' })) ?? 1000;
  for (;;) {
    seq++;
    const o = { ...data, id: seq };
    if (await s.get(`order:${seq}`)) continue;
    const r = await s.set(`order:${seq}`, JSON.stringify(o), { onlyIfNew: true });
    if (r?.modified === false) continue;
    await s.set('seq', JSON.stringify(seq)); return o;
  }
}
async function setStatus(s, o, status) {
  o.status = status;
  await s.set(`order:${o.id}`, JSON.stringify(o));
  await send(o.user_id, `Статус вашего заказа <b>#${o.id}</b> изменён:\n${LABEL[status]}`, chatKb(o.id));
}

async function addMsg(s, o, isAdmin, text, file, buf) {
  const key = `msgs:${o.id}`;
  const msgs = (await s.get(key, { type: 'json' })) ?? [];
  const msg = { id: (msgs.at(-1)?.id ?? 0) + 1, order_id: o.id, sender_type: isAdmin ? 'ADMIN' : 'CLIENT', text, created_at: Date.now() };
  if (file) msg.file = file;
  msgs.push(msg);
  await s.set(key, JSON.stringify(msgs));
  const to = isAdmin ? o.user_id : ADMIN_ID;
  const head = isAdmin ? `💬 <b>Заказ #${o.id}</b>` : `💬 <b>Заказ #${o.id}</b> · ${esc(o.name)}`;
  const body = `${head}${text ? '\n' + esc(text) : ''}`;
  if (file) await sendFile(to, buf, file.origType || file.type, file.name, body, chatKb(o.id));
  else await send(to, body, chatKb(o.id));
  return msg;
}

/* ---------- Webhook бота ---------- */
async function webhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  const u = await req.json().catch(() => ({}));
  if (u.message?.text?.startsWith('/start')) {
    await send(u.message.chat.id, 'Добро пожаловать в MAISONAX! Кнопка «Открыть MAISONAX» внизу всегда под рукой.',
      { keyboard: [[{ text: 'Открыть MAISONAX', web_app: { url: WEBAPP_URL }, style: 'primary' }]], resize_keyboard: true, is_persistent: true });
  }
  const cb = u.callback_query;
  const m = cb?.data?.match(/^st:(\d+):(\w+)$/);
  if (m) {
    if (cb.from.id !== ADMIN_ID) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' }); return json({ ok: true }); }
    const s = store(); const o = await getOrder(s, m[1]);
    if (!o || !STATUSES.includes(m[2])) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ошибка' }); return json({ ok: true }); }
    await setStatus(s, o, m[2]);
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: LABEL[m[2]] });
    const base = (cb.message?.text || '').split('\n\nСтатус:')[0];
    await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML',
      text: `${esc(base)}\n\n<b>Статус: ${LABEL[m[2]]}</b>`, reply_markup: adminKb(o) });
  }
  return json({ ok: true });
}

/* ---------- Роутер ---------- */
export default async (req) => { try { return await handle(req); } catch (e) { await send(ADMIN_ID, '⚠️ Ошибка сервера: ' + esc(e.message)); return json({ error: 'server' }, 500); } };
const handle = async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

  if (path === '/webhook' && req.method === 'POST') return webhook(req);

  // Разовая настройка: открыть в браузере /api/setup?key=<WEBHOOK_SECRET>
  if (path === '/setup') {
    if (!WEBHOOK_SECRET || url.searchParams.get('key') !== WEBHOOK_SECRET) return json({ error: 'forbidden', secret_set: !!WEBHOOK_SECRET, token_set: !!BOT_TOKEN, admin_set: !!ADMIN_ID, url_set: !!WEBAPP_URL }, 403);
    const hook = await tg('setWebhook', { url: `${WEBAPP_URL}/api/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'MAISONAX', web_app: { url: WEBAPP_URL } } });
    return json({ webhook: hook, menu });
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
    const o = await createOrder(s, { user_id: user.id, username: user.username || null, name, phone, service_type, description, status: 'NEW', created_at: Date.now() });
    await send(ADMIN_ID,
      `🔔 <b>Новый заказ #${o.id}</b>\n👤 Имя: ${esc(name)}\n📞 Тел: ${esc(phone)}\n` +
      `✈️ TG: ${o.username ? '@' + esc(o.username) : `<a href="tg://user?id=${o.user_id}">профиль</a>`}\n` +
      `💼 Услуга: ${esc(service_type)}\n📝 Задача: ${esc(description)}`, adminKb(o));
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
    return new Response(f.data, { headers: { 'Content-Type': f.metadata.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
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
    await setStatus(s, o, body.status);
    return json(o);
  }

  if (m[2] === 'upload' && req.method === 'POST') {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 5 * 1024 * 1024) return json({ error: 'size' }, 413);
    const dec = h => { try { return decodeURIComponent(req.headers.get(h) || ''); } catch { return ''; } };
    const name = clip(dec('x-file-name') || 'file', 100).replace(/[\r\n"]/g, '');
    const origType = clip(req.headers.get('x-file-type'), 100).toLowerCase() || 'application/octet-stream';
    const type = SAFE.has(origType) ? origType : 'application/octet-stream';
    const fid = crypto.randomBytes(12).toString('hex');
    await s.set(`file:${fid}`, buf, { metadata: { type, name, order_id: o.id } });
    const msg = await addMsg(s, o, isAdmin, clip(dec('x-caption'), 1000), { id: fid, name, type, size: buf.byteLength, origType }, buf);
    delete msg.file.origType;
    return json(msg);
  }

  if (m[2] === 'messages') {
    const key = `msgs:${o.id}`;
    const msgs = (await s.get(key, { type: 'json' })) ?? [];
    if (req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0;
      return json(msgs.filter(x => x.id > after));
    }
    if (req.method === 'POST') {
      const text = clip(body.text, 2000);
      if (!text) return json({ error: 'empty' }, 400);
      return json(await addMsg(s, o, isAdmin, text));
    }
  }
  return json({ error: 'not_found' }, 404);
};

export const config = { path: '/api/*' };
