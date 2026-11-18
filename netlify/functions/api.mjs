import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const { BOT_TOKEN, WEBAPP_URL, WEBHOOK_SECRET } = process.env;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const MAX_FILE = 5 * 1024 * 1024;
const SESSION_TTL = 3 * 86400;
const RENOTIFY_MS = 30 * 60 * 1000;
const STATUSES = ['NEW', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'];
const PRIOR = ['normal', 'high', 'urgent'];
const VIA = ['telegram', 'phone', 'whatsapp'];
const TIMES = ['any', 'morning', 'day', 'evening'];
const VIA_RU = { telegram: 'Telegram', phone: 'звонок', whatsapp: 'WhatsApp' };
const TIME_RU = { any: 'любое время', morning: 'утро 9–12', day: 'день 12–18', evening: 'вечер 18–21' };
const EMOJI = ['👍', '❤️', '🔥', '😂', '👏', '✅'];
const LANGS = ['ru', 'en', 'hy'];
const SAFE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm', 'application/pdf']);

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : null; };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const store = () => getStore({ name: 'maisonax', consistency: 'strong' });
const getJ = (s, k) => s.get(k, { type: 'json' });
const putJ = (s, k, v, o) => s.set(k, JSON.stringify(v), o);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// «живой» чат: версия диалога меняется при любом событии; запрос ждёт изменения до ~6 секунд (long-polling)
const bump = async (s, key) => { const v = Date.now() * 10 + crypto.randomInt(10); await putJ(s, key, v); return v; };
async function waitVer(s, key, cv, waitSec) {
  let v = await getJ(s, key); const end = Date.now() + Math.min(6500, Math.max(0, waitSec * 1000));
  while (cv && String(v ?? 0) === String(cv) && Date.now() < end) { await sleep(900); v = await getJ(s, key); }
  return v ?? 0;
}
const TZ = Number(process.env.TZ_OFFSET ?? 4); // часовой пояс команды (для поздравлений), по умолчанию UTC+4
const DEFCFG = { sla_min: 30, auto_aband: true, auto_review: true, auto_holiday: true, ref_reward_pct: 5, ref_welcome_pct: 0 };
const getCfg = async s => ({ ...DEFCFG, ...((await getJ(s, 'cfg')) || {}) });
const DEFAULT_TPL = [
  { id: 't1', title: 'Принял заявку', text: 'Здравствуйте, {имя}! Принял заявку {номер}, изучаю детали.' },
  { id: 't2', title: 'Уточнить детали', text: '{имя}, уточните, пожалуйста, детали задачи по заказу {номер}.' },
  { id: 't3', title: 'Созвон', text: '{имя}, когда вам удобно созвониться?' },
  { id: 't4', title: 'Готово ✅', text: '{имя}, готово ✅ Посмотрите, пожалуйста, заказ {номер}.' },
];

/* ---------- Тексты бота (клиентские — на 3 языках; служебные для команды — на русском) ---------- */
const I = {
  ru: {
    welcome: 'Добро пожаловать в <b>MAISONAX</b>! 👋\n\nОставляйте заявки и общайтесь с командой прямо в Telegram. Нажмите кнопку ниже:',
    welcome_fix: 'Приложение открывается кнопкой под сообщением 👇 Старая кнопка в клавиатуре заменена.',
    menu_ready: 'Быстрое меню включено 👇', b_open: '🚀 Открыть MAISONAX', b_new: '📝 Новая заявка', b_orders: '📋 Мои заказы', b_help: '❓ Помощь', b_lang: '🌐 Язык', b_chat: '💬 Открыть чат', kb_ph: 'Выберите действие',
    new_prompt: 'Оформите заявку за минуту — опишите задачу, и мы свяжемся с вами 👇', new_btn: '📝 Оставить заявку',
    orders_none: 'У вас пока нет заказов. Оставьте первую заявку 👇', orders_title: '📋 <b>Ваши заказы</b>', orders_all: 'Все заказы',
    help: '<b>MAISONAX</b> — сайты, чат-боты и автоматизация для бизнеса.\n\n📝 <b>Новая заявка</b> — опишите задачу, мы свяжемся с вами\n📋 <b>Мои заказы</b> — статусы и чат с командой\n💬 Переписка идёт в приложении, а сюда приходят уведомления\n\nКоманды: /new · /orders · /lang · /subscribe · /unsubscribe · /help',
    fallback: 'Чтобы написать команде по заказу, откройте чат в приложении 👇',
    order_ok: '✅ Заявка <b>#{id}</b> принята!\nМы свяжемся с вами в ближайшее время. Статус и переписка — в чате заказа 👇',
    st_NEW: '🟡 Заказ <b>#{id}</b> снова в ожидании.', st_IN_PROGRESS: '🔵 Заказ <b>#{id}</b> принят в работу. Мы на связи в чате.',
    st_COMPLETED: '🟢 Заказ <b>#{id}</b> исполнен. Спасибо, что выбрали MAISONAX! Оцените работу в приложении ⭐', st_REJECTED: '🔴 Заказ <b>#{id}</b> отклонён.\n\n<b>Причина:</b> {reason}',
    lbl_NEW: '🟡 В ожидании', lbl_IN_PROGRESS: '🔵 В работе', lbl_COMPLETED: '🟢 Исполнен', lbl_REJECTED: '🔴 Отклонён',
    unread: '💬 У Вас непрочитанное сообщение (Заказ #{id})', lang_prompt: 'Выберите язык / Choose language / Ընտրեք լեզուն', lang_set: 'Язык: Русский 🇷🇺',
    sub_on: 'Вы подписаны на новости и акции. Отписаться: /unsubscribe', sub_off: 'Вы отписались от рассылки. Подписаться снова: /subscribe',
    phone_saved: '✅ Номер сохранён. Вернитесь в приложение.', ref_new: '🎁 По вашей ссылке пришёл новый клиент!', ref_done: '🎉 Ваш друг завершил заказ — вам бонус! Условия уточнит команда.', unsub_hint: '— Отписаться: /unsubscribe',
    ntn_status: 'Заказ #{id}: статус изменён', ntn_msg: 'Непрочитанное сообщение (заказ #{id})', ntn_ref: 'Друг завершил заказ — бонус!',
  },
  en: {
    welcome: 'Welcome to <b>MAISONAX</b>! 👋\n\nSubmit requests and chat with the team right in Telegram. Tap the button below:',
    welcome_fix: 'The app opens with the button under the message 👇 The old keyboard button was replaced.',
    menu_ready: 'Quick menu is on 👇', b_open: '🚀 Open MAISONAX', b_new: '📝 New request', b_orders: '📋 My orders', b_help: '❓ Help', b_lang: '🌐 Language', b_chat: '💬 Open chat', kb_ph: 'Choose an action',
    new_prompt: "Submit a request in a minute — describe the task and we'll get back to you 👇", new_btn: '📝 Submit a request',
    orders_none: 'You have no orders yet. Submit your first request 👇', orders_title: '📋 <b>Your orders</b>', orders_all: 'All orders',
    help: '<b>MAISONAX</b> — websites, chatbots and business automation.\n\n📝 <b>New request</b> — describe the task, we will contact you\n📋 <b>My orders</b> — statuses and chat with the team\n💬 Messages live in the app, notifications arrive here\n\nCommands: /new · /orders · /lang · /subscribe · /unsubscribe · /help',
    fallback: 'To message the team about an order, open the chat in the app 👇',
    order_ok: "✅ Request <b>#{id}</b> received!\nWe'll contact you soon. Status and messages are in the order chat 👇",
    st_NEW: '🟡 Order <b>#{id}</b> is pending again.', st_IN_PROGRESS: "🔵 Order <b>#{id}</b> is now in progress. We're in touch in the chat.",
    st_COMPLETED: '🟢 Order <b>#{id}</b> is completed. Thank you for choosing MAISONAX! Please rate our work in the app ⭐', st_REJECTED: '🔴 Order <b>#{id}</b> was declined.\n\n<b>Reason:</b> {reason}',
    lbl_NEW: '🟡 Pending', lbl_IN_PROGRESS: '🔵 In progress', lbl_COMPLETED: '🟢 Completed', lbl_REJECTED: '🔴 Declined',
    unread: '💬 You have an unread message (Order #{id})', lang_prompt: 'Выберите язык / Choose language / Ընտրեք լեզուն', lang_set: 'Language: English 🇬🇧',
    sub_on: 'You are subscribed to news and offers. Unsubscribe: /unsubscribe', sub_off: 'You have unsubscribed. Subscribe again: /subscribe',
    phone_saved: '✅ Number saved. Return to the app.', ref_new: '🎁 A new client joined via your link!', ref_done: '🎉 Your friend completed an order — you get a bonus! The team will share the terms.', unsub_hint: '— Unsubscribe: /unsubscribe',
    ntn_status: 'Order #{id}: status changed', ntn_msg: 'Unread message (order #{id})', ntn_ref: 'A friend completed an order — bonus!',
  },
  hy: {
    welcome: 'Բարի գալուստ <b>MAISONAX</b>։ 👋\n\nԹողեք հայտեր և շփվեք թիմի հետ անմիջապես Telegram-ում։ Սեղմեք ներքևի կոճակը՝',
    welcome_fix: 'Հավելվածը բացվում է հաղորդագրության տակի կոճակով 👇 Հին կոճակը փոխարինված է։',
    menu_ready: 'Արագ ընտրացանկը միացված է 👇', b_open: '🚀 Բացել MAISONAX', b_new: '📝 Նոր հայտ', b_orders: '📋 Իմ պատվերները', b_help: '❓ Օգնություն', b_lang: '🌐 Լեզու', b_chat: '💬 Բացել չաթը', kb_ph: 'Ընտրեք գործողություն',
    new_prompt: 'Թողեք հայտ րոպեի ընթացքում՝ նկարագրեք խնդիրը, և մենք կկապվենք ձեզ հետ 👇', new_btn: '📝 Թողնել հայտ',
    orders_none: 'Դուք դեռ պատվերներ չունեք։ Թողեք առաջին հայտը 👇', orders_title: '📋 <b>Ձեր պատվերները</b>', orders_all: 'Բոլոր պատվերները',
    help: '<b>MAISONAX</b> — կայքեր, չաթ-բոտեր և բիզնեսի ավտոմատացում։\n\n📝 <b>Նոր հայտ</b> — նկարագրեք խնդիրը, մենք կկապվենք\n📋 <b>Իմ պատվերները</b> — կարգավիճակներ և չաթ թիմի հետ\n💬 Նամակագրությունը հավելվածում է, այստեղ գալիս են ծանուցումները\n\nԿոմանդներ՝ /new · /orders · /lang · /subscribe · /unsubscribe · /help',
    fallback: 'Պատվերի վերաբերյալ թիմին գրելու համար բացեք չաթը հավելվածում 👇',
    order_ok: '✅ Հայտ <b>#{id}</b>-ը ընդունված է։\nՇուտով կկապվենք ձեզ հետ։ Կարգավիճակը և նամակագրությունը պատվերի չաթում են 👇',
    st_NEW: '🟡 Պատվեր <b>#{id}</b>-ը կրկին սպասման մեջ է։', st_IN_PROGRESS: '🔵 Պատվեր <b>#{id}</b>-ը ընդունված է աշխատանքի։ Մենք կապի մեջ ենք չաթում։',
    st_COMPLETED: '🟢 Պատվեր <b>#{id}</b>-ը կատարված է։ Շնորհակալություն MAISONAX-ին ընտրելու համար։ Գնահատեք աշխատանքը հավելվածում ⭐', st_REJECTED: '🔴 Պատվեր <b>#{id}</b>-ը մերժվել է։\n\n<b>Պատճառ՝</b> {reason}',
    lbl_NEW: '🟡 Սպասման մեջ', lbl_IN_PROGRESS: '🔵 Ընթացքի մեջ', lbl_COMPLETED: '🟢 Կատարված', lbl_REJECTED: '🔴 Մերժված',
    unread: '💬 Դուք ունեք չկարդացված հաղորդագրություն (Պատվեր #{id})', lang_prompt: 'Выберите язык / Choose language / Ընտրեք լեզուն', lang_set: 'Լեզուն՝ Հայերեն 🇦🇲',
    sub_on: 'Դուք բաժանորդագրվել եք նորություններին և ակցիաներին։ Ապաբաժանորդագրվելու համար՝ /unsubscribe', sub_off: 'Դուք ապաբաժանորդագրվել եք։ Կրկին բաժանորդագրվելու համար՝ /subscribe',
    phone_saved: '✅ Համարը պահպանված է։ Վերադարձեք հավելված։', ref_new: '🎁 Ձեր հղումով նոր հաճախորդ եկավ։', ref_done: '🎉 Ձեր ընկերը ավարտեց պատվերը՝ ձեզ բոնուս է հասնում։ Պայմանները կճշտի թիմը։', unsub_hint: '— Ապաբաժանորդագրվել՝ /unsubscribe',
    ntn_status: 'Պատվեր #{id}. կարգավիճակը փոխվեց', ntn_msg: 'Չկարդացված հաղորդագրություն (պատվեր #{id})', ntn_ref: 'Ընկերը ավարտեց պատվերը՝ բոնուս։',
  },
};
const I2 = {
  ru: { ref_reward: '🎉 Ваш друг завершил заказ! Ваш промокод <b>{code}</b> — скидка {pct}% на следующий заказ.', welcome_promo: '🎁 Для вас промокод <b>{code}</b>: скидка {pct}% на первый заказ. Введите его в форме заявки.', aband: '👋 Вы начали оформлять заявку. Завершите — мы ответим быстро!', review_ask: '⭐ Как вам работа по заказу <b>#{id}</b>? Оставьте короткий отзыв — это займёт полминуты.', hol_ny: '🎄 С Новым годом! Команда MAISONAX желает вам ярких проектов и больших успехов. ✨', hol_w: '🌷 С 8 Марта! Команда MAISONAX поздравляет вас и желает вдохновения и тепла.', hol_xm: '✨ С Рождеством!' },
  en: { ref_reward: '🎉 Your friend completed an order! Your promo code <b>{code}</b> gives {pct}% off your next order.', welcome_promo: '🎁 Promo code <b>{code}</b> for you: {pct}% off your first order. Enter it in the request form.', aband: "👋 You started a request. Finish it — we'll reply fast!", review_ask: '⭐ How was your order <b>#{id}</b>? Leave a short review — it takes half a minute.', hol_ny: '🎄 Happy New Year! The MAISONAX team wishes you bright projects and great success. ✨', hol_w: "🌷 Happy Women's Day! The MAISONAX team wishes you inspiration and warmth.", hol_xm: '✨ Merry Christmas!' },
  hy: { ref_reward: '🎉 Ձեր ընկերը ավարտեց պատվերը։ Ձեր պրոմոկոդը՝ <b>{code}</b>, {pct}% զեղչ հաջորդ պատվերի համար։', welcome_promo: '🎁 Ձեզ համար պրոմոկոդ՝ <b>{code}</b>, {pct}% զեղչ առաջին պատվերի համար։ Մուտքագրեք այն հայտի ձևում։', aband: '👋 Դուք սկսել եք հայտ լրացնել։ Ավարտեք՝ մենք արագ կպատասխանենք։', review_ask: '⭐ Ինչպե՞ս էր աշխատանքը <b>#{id}</b> պատվերով։ Թողեք կարճ կարծիք՝ կտևի կես րոպե։', hol_ny: '🎄 Շնորհավոր Նոր տարի։ MAISONAX թիմը ձեզ մաղթում է վառ նախագծեր և մեծ հաջողություններ։ ✨', hol_w: '🌷 Շնորհավոր Մարտի 8-ը։ MAISONAX թիմը ձեզ մաղթում է ոգեշնչում և ջերմություն։', hol_xm: '✨ Շնորհավոր Սուրբ Ծնունդ և Աստվածահայտնություն։ MAISONAX թիմը ձեզ մաղթում է խաղաղություն և ջերմություն։' },
};
for (const l of ['ru', 'en', 'hy']) Object.assign(I[l], I2[l]);
const tr = (l, k, v = {}) => (I[l]?.[k] ?? I.ru[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
const guessLang = c => c === 'hy' ? 'hy' : (!c || ['ru', 'uk', 'be', 'kk'].includes(c)) ? 'ru' : 'en';
const ACT = {}; // текст кнопки клавиатуры (любой язык) -> действие
for (const l of LANGS) for (const a of ['new', 'orders', 'help', 'lang']) ACT[I[l]['b_' + a]] = a;

/* ---------- Telegram ---------- */
const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
const send = (chat_id, text, reply_markup) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } });
// web_app через inline-кнопку или кнопку меню передаёт initData (кнопка обычной клавиатуры — нет)
const appBtn = (text, hash = '', style = 'primary') => ({ text, web_app: { url: WEBAPP_URL + (hash ? '/#' + hash : '') }, style });
const chatBtn = (id, l = 'ru') => appBtn(tr(l, 'b_chat'), `order=${id}`);
const chatKb = (id, l = 'ru') => ({ inline_keyboard: [[chatBtn(id, l)]] });
const adminKb = o => ({ inline_keyboard: [
  [{ text: 'В работу', callback_data: `st:${o.id}:IN_PROGRESS`, style: 'primary' }, { text: 'Завершить', callback_data: `st:${o.id}:COMPLETED`, style: 'success' }],
  [{ text: 'Отклонить', callback_data: `st:${o.id}:REJECTED`, style: 'danger' }, chatBtn(o.id)],
  [{ text: '✈️ Профиль клиента', url: o.username ? `https://t.me/${o.username}` : `tg://user?id=${o.user_id}` }],
] });
const clientMenu = l => ({ keyboard: [[{ text: tr(l, 'b_new') }, { text: tr(l, 'b_orders') }], [{ text: tr(l, 'b_lang') }, { text: tr(l, 'b_help') }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: tr(l, 'kb_ph') });
const staffMenu = { keyboard: [[{ text: '📋 Все заказы' }, { text: '📊 Статистика' }], [{ text: '❓ Помощь' }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: 'Выберите действие' };

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

/* ---------- Команда, роли ---------- */
let teamCache = { at: 0, v: {} };
async function getTeam(s) { if (Date.now() - teamCache.at < 8000) return teamCache.v; const v = (await getJ(s, 'team')) || {}; teamCache = { at: Date.now(), v }; return v; }
async function saveTeam(s, v) { await putJ(s, 'team', v); teamCache = { at: Date.now(), v }; }
const roleOf = (uid, team) => uid === ADMIN_ID ? 'owner' : (team[uid]?.role || null);
const writers = team => [ADMIN_ID, ...Object.keys(team).filter(i => team[i].role === 'manager').map(Number)];

/* ---------- Пользователи, уведомления, аудит, статистика ---------- */
const getUser = (s, id) => getJ(s, `usr:${id}`);
async function touchUser(s, tu, patch = {}) {
  let u = await getUser(s, tu.id), ch = false, isNew = false;
  if (!u) { u = { id: tu.id, first_seen: Date.now(), sub: false }; ch = isNew = true; }
  const nm = [tu.first_name, tu.last_name].filter(Boolean).join(' ');
  if (u.name !== nm) { u.name = nm; ch = true; }
  if (u.username !== (tu.username || null)) { u.username = tu.username || null; ch = true; }
  if (!u.lang) { u.lang = guessLang(tu.language_code); ch = true; }
  for (const [k, v] of Object.entries(patch)) if (u[k] !== v) { u[k] = v; ch = true; }
  if (!u.last_seen || Date.now() - u.last_seen > 3600000) { u.last_seen = Date.now(); ch = true; }
  if (ch) await putJ(s, `usr:${tu.id}`, u);
  return [u, isNew];
}
async function applyParam(s, u, param) {
  param = clip(param, 64);
  if (!param) return u;
  if (param.startsWith('ref_')) {
    const rid = Number(param.slice(4));
    if (rid && rid !== u.id && !u.ref && await getUser(s, rid)) {
      u.ref = rid; await putJ(s, `usr:${u.id}`, u);
      const rs = (await getJ(s, `refstat:${rid}`)) || { invited: 0, completed: 0 };
      rs.invited++; await putJ(s, `refstat:${rid}`, rs);
      const rl = (await getUser(s, rid))?.lang;
      await send(rid, tr(rl, 'ref_new'));
      await pushNt(s, rid, { type: 'ref', text: tr(rl, 'ref_new').replace(/^🎁 /, '') });
      const cfg = await getCfg(s);
      if (cfg.ref_welcome_pct > 0) { const code = await mkPromo(s, { percent: cfg.ref_welcome_pct, title: 'welcome', owner_uid: u.id, kind: 'ref_welcome' }); await send(u.id, tr(u.lang, 'welcome_promo', { code, pct: cfg.ref_welcome_pct })); }
    }
  } else if (param.startsWith('src_') && !u.src) {
    u.src = param.slice(4).replace(/[^\w-]/g, '').slice(0, 30) || null; await putJ(s, `usr:${u.id}`, u);
  }
  return u;
}
const CODECH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rndCode = (p = 'MX') => p + Array.from({ length: 6 }, () => CODECH[crypto.randomInt(CODECH.length)]).join('');
async function mkPromo(s, p) {
  let code = String(p.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20) || rndCode(String(p.kind || '').startsWith('ref') ? 'R' : 'MX');
  if (await getJ(s, `promo:${code}`)) code = rndCode();
  const pr = { code, percent: p.percent, title: p.title || '', kind: p.kind || 'public', owner_uid: p.owner_uid || null, expires_at: p.expires_at || null, max_uses: p.max_uses || null, uses: 0, active: true, banner: !!p.banner, mode: p.mode || 'multi', per_user: !!p.per_user, used_by: [], created_at: Date.now() };
  await putJ(s, `promo:${code}`, pr);
  const idx = pr.owner_uid ? `pmy:${pr.owner_uid}` : 'pubidx', a = (await getJ(s, idx)) || []; a.push(code); await putJ(s, idx, a.slice(idx === 'pubidx' ? -500 : -100));
  return code;
}
const promoState = (pr, uid) => !pr || !pr.active ? 'invalid' : (pr.expires_at && pr.expires_at < Date.now()) ? 'expired' : (pr.max_uses && pr.uses >= pr.max_uses) ? 'used_up' : (pr.owner_uid && pr.owner_uid !== uid) ? 'invalid' : (pr.per_user && (pr.used_by || []).includes(uid)) ? 'used_by_you' : 'ok';
// Атомарное изменение счётчика использований (защита от гонки: два клиента не займут один разовый код)
async function claimPromo(s, code, uid) {
  const key = `promo:${code}`;
  for (let i = 0; i < 6; i++) {
    const r = await s.getWithMetadata(key, { type: 'json' }), pr = r?.data, st = promoState(pr, uid);
    if (st !== 'ok') return { ok: false, reason: st };
    pr.uses = (pr.uses || 0) + 1;
    if (pr.owner_uid) pr.active = false;
    if (pr.per_user) (pr.used_by ||= []).push(uid);
    const w = await s.set(key, JSON.stringify(pr), r.etag ? { onlyIfMatch: r.etag } : undefined);
    if (w?.modified !== false) return { ok: true, pr };
  }
  return { ok: false, reason: 'busy' };
}
// delta -1: вернуть код (заказ отклонён / не создан), +1: занять снова (заказ вернули в работу)
async function adjustPromo(s, code, uid, delta) {
  const key = `promo:${code}`;
  for (let i = 0; i < 6; i++) {
    const r = await s.getWithMetadata(key, { type: 'json' }), pr = r?.data;
    if (!pr) return;
    pr.uses = Math.max(0, (pr.uses || 0) + delta);
    if (pr.owner_uid) pr.active = delta < 0;
    if (pr.per_user) {
      pr.used_by ||= [];
      if (delta < 0) { const k = pr.used_by.indexOf(uid); if (k >= 0) pr.used_by.splice(k, 1); }
      else pr.used_by.push(uid);
    }
    const w = await s.set(key, JSON.stringify(pr), r.etag ? { onlyIfMatch: r.etag } : undefined);
    if (w?.modified !== false) return;
  }
}
async function roster(s) {
  const team = await getTeam(s);
  return [{ id: ADMIN_ID, name: (await getUser(s, ADMIN_ID))?.name || 'Владелец', role: 'owner' }, ...Object.entries(team).map(([id, v]) => ({ id: Number(id), name: v.name, role: v.role }))];
}
async function notifyMentions(s, actor, text, markup, where) { // @Имя в чате команды или во внутренней заметке
  const names = [...String(text).matchAll(/@([\p{L}\p{N}_-]+)/gu)].map(m => m[1].toLowerCase()); if (!names.length) return;
  const ids = new Set(); for (const m of await roster(s)) if (names.includes(String(m.name).split(/\s+/)[0].toLowerCase())) ids.add(m.id);
  for (const uid of ids) if (uid !== actor.uid) { await send(uid, `🔔 <b>${esc(actor.name)}</b> упомянул(а) вас ${esc(where)}:\n${esc(String(text).slice(0, 200))}`, markup); await pushNt(s, uid, { type: 'mention', text: `${actor.name} упомянул(а) вас ${where}` }); }
}
async function pushNt(s, uid, n) {
  const k = `nt:${uid}`, a = (await getJ(s, k)) || [];
  a.unshift({ id: crypto.randomBytes(4).toString('hex'), at: Date.now(), read: false, ...n });
  await putJ(s, k, a.slice(0, 40));
}
async function audit(s, actor, action, order, detail = '') {
  await putJ(s, `audit:${String(Date.now()).padStart(15, '0')}${crypto.randomInt(100)}`, { at: Date.now(), uid: actor.uid, name: actor.name, action, order: order || null, detail: String(detail).slice(0, 200) });
}
async function track(s, uid, ev) {
  const k = `stat:${new Date().toISOString().slice(0, 10)}`, st = (await getJ(s, k)) || { open: [], form: [], submit: [] }, a = st[ev];
  if (a && !a.includes(uid) && a.length < 3000) { a.push(uid); await putJ(s, k, st); }
}
let botNameCache = process.env.BOT_USERNAME || '';
async function botName(s) {
  if (botNameCache) return botNameCache;
  botNameCache = (await getJ(s, 'botname')) || '';
  if (!botNameCache) { const r = await tg('getMe', {}); botNameCache = r.result?.username || ''; if (botNameCache) await putJ(s, 'botname', botNameCache); }
  return botNameCache;
}

/* ---------- Заказы ---------- */
const getOrder = (s, id) => getJ(s, `order:${id}`);
const HIDE = ['note', 'notif', 'priority', 'tags', 'budget', 'paid', 'deadline', 'source', 'ref_by', 'first_reply_at', 'unread_admin', 'ref_credited', 'tasks', 'time_log', 'time_total', 'sla_alert', 'sla_msg', 'review_asked', 'promo_released'];
const pub = (o, staff) => { // служебные поля — только команде
  if (staff || !o) return o;
  const r = { ...o }; HIDE.forEach(k => delete r[k]);
  if (r.assignee) r.assignee = { name: r.assignee.name };
  if (r.pinned?.internal) delete r.pinned;
  return r;
};
async function patchOrder(s, id, fn) { const o = await getOrder(s, id); if (!o) return null; fn(o); await putJ(s, `order:${id}`, o); return o; }
async function listOrders(s) {
  const { blobs } = await s.list({ prefix: 'order:' });
  return (await Promise.all(blobs.map(b => getJ(s, b.key)))).filter(Boolean).sort((a, b) => b.id - a.id);
}
async function createOrder(s, data) {
  let seq = (await getJ(s, 'seq')) ?? 1000;
  for (;;) {
    seq++;
    if (await s.get(`order:${seq}`)) continue;
    const o = { ...data, id: seq, history: [{ s: 'NEW', at: data.created_at }] };
    const r = await s.set(`order:${seq}`, JSON.stringify(o), { onlyIfNew: true });
    if (r?.modified === false) continue;
    await putJ(s, 'seq', seq);
    return o;
  }
}
async function setStatus(s, id, status, reason = '', actor = null) {
  let changed = false;
  const o = await patchOrder(s, id, x => {
    changed = x.status !== status || (status === 'REJECTED' && x.reject_reason !== reason);
    if (changed) (x.history ||= []).push({ s: status, at: Date.now(), ...(status === 'REJECTED' ? { r: reason } : {}) });
    x.status = status;
    if (status === 'REJECTED') { x.reject_reason = reason; x.rejected_at = Date.now(); } else { delete x.reject_reason; delete x.rejected_at; }
  });
  if (!o || !changed) return o;
  const l = (await getUser(s, o.user_id))?.lang || 'ru';
  await send(o.user_id, tr(l, 'st_' + status, { id: o.id, reason: esc(o.reject_reason || '') }), chatKb(o.id, l));
  await pushNt(s, o.user_id, { type: 'status', order: o.id, text: tr(l, 'ntn_status', { id: o.id }) + ' — ' + tr(l, 'lbl_' + status).slice(3) });
  if (actor) await audit(s, actor, 'status', o.id, status + (reason ? ': ' + reason : ''));
  if (status === 'COMPLETED' && o.ref_by && !o.ref_credited) {
    await patchOrder(s, o.id, x => { x.ref_credited = true; });
    const rs = (await getJ(s, `refstat:${o.ref_by}`)) || { invited: 0, completed: 0 };
    rs.completed++; await putJ(s, `refstat:${o.ref_by}`, rs);
    const rl = (await getUser(s, o.ref_by))?.lang;
    const cfg = await getCfg(s);
    if (cfg.ref_reward_pct > 0) { const code = await mkPromo(s, { percent: cfg.ref_reward_pct, title: 'ref', owner_uid: o.ref_by, kind: 'ref_reward' }); await send(o.ref_by, tr(rl, 'ref_reward', { code, pct: cfg.ref_reward_pct })); }
    else await send(o.ref_by, tr(rl, 'ref_done'));
    await pushNt(s, o.ref_by, { type: 'ref', text: tr(rl, 'ntn_ref') });
  }
  if (o.promo) { // отклонённый заказ возвращает промокод; если его вернули в работу — код снова занят
    if (status === 'REJECTED' && !o.promo_released) { await patchOrder(s, o.id, x => { x.promo_released = true; }); await adjustPromo(s, o.promo.code, o.user_id, -1); }
    else if (status !== 'REJECTED' && o.promo_released) { await patchOrder(s, o.id, x => { x.promo_released = false; }); await adjustPromo(s, o.promo.code, o.user_id, +1); }
  }
  await bump(s, `ver:${o.id}`);
  return o;
}

// Каждое сообщение — отдельный ключ. Текст переписки в Telegram НЕ дублируется — только уведомление.
const mkey = (oid, id) => `msg:${oid}:${String(id).padStart(16, '0')}`;
async function staffTargets(s, o) { const team = await getTeam(s); return o?.assignee?.id ? [o.assignee.id] : writers(team); }
async function addMsg(s, o, actor, text, { file, internal, reply, silent } = {}) {
  const staff = actor.staff, side = staff ? 'admin' : 'client', other = staff ? 'client' : 'admin', flag = 'unread_' + other;
  const id = Date.now() * 10 + crypto.randomInt(10);
  const msg = { id, order_id: o.id, sender_type: staff ? 'ADMIN' : 'CLIENT', sender_name: actor.name, text, created_at: Date.now() };
  if (staff) msg.sender_id = actor.uid;
  if (file) msg.file = file; if (internal) msg.internal = true; if (reply) msg.reply = reply;
  await putJ(s, mkey(o.id, id), msg);
  let notify = false;
  const fresh = await patchOrder(s, o.id, x => {
    const now = Date.now(); x['read_' + side + '_at'] = now;
    if (internal) return;
    x.notif ||= {};
    notify = !silent && (!x[flag] || now - (x.notif[other] || 0) > RENOTIFY_MS);
    x[flag] = true; if (notify) x.notif[other] = now;
    x.last = { at: now, from: msg.sender_type, text: text ? text.slice(0, 80) : '📎 ' + (file?.name || 'file') };
    if (staff && !x.first_reply_at) x.first_reply_at = now;
  });
  await bump(s, `ver:${o.id}`);
  if (internal) await notifyMentions(s, actor, text, chatKb(o.id), `в заметке заказа #${o.id}`);
  if (notify && fresh) {
    if (staff) {
      const l = (await getUser(s, fresh.user_id))?.lang || 'ru';
      await send(fresh.user_id, tr(l, 'unread', { id: fresh.id }), chatKb(fresh.id, l));
      await pushNt(s, fresh.user_id, { type: 'msg', order: fresh.id, text: tr(l, 'ntn_msg', { id: fresh.id }) });
    } else for (const uid of await staffTargets(s, fresh)) {
      await send(uid, `💬 У Вас непрочитанное сообщение (Заказ #${fresh.id} · ${esc(fresh.name)})`, chatKb(fresh.id));
      await pushNt(s, uid, { type: 'msg', order: fresh.id, text: `Сообщение · заказ #${fresh.id} · ${fresh.name}` });
    }
  }
  return msg;
}
async function attach(s, o, actor, buf, origType, name, caption, opt = {}) {
  const type = SAFE.has(origType) ? origType : 'application/octet-stream';
  const fid = crypto.randomBytes(12).toString('hex');
  await s.set(`file:${fid}`, buf, { metadata: { type, name, order_id: o.id } });
  return addMsg(s, o, actor, caption, { ...opt, file: { id: fid, name, type, size: buf.byteLength } });
}

/* ---------- Бот ---------- */
const HELP_STAFF = '<b>Панель команды</b>\n\n📋 <b>Все заказы</b> — список и чаты в приложении\n📊 <b>Статистика</b> — сводка по статусам\nСтатус можно менять кнопками в уведомлении или в приложении.\n\nКоманды: /orders · /stats · /help';
async function summary(s) {
  const all = await listOrders(s), by = k => all.filter(o => o.status === k).length;
  return `📊 <b>Статистика</b>\n\nВсего заказов: <b>${all.length}</b>\nЗа 24 часа: <b>${all.filter(o => Date.now() - o.created_at < 86400000).length}</b>\n\n🟡 В ожидании: ${by('NEW')}\n🔵 В работе: ${by('IN_PROGRESS')}\n🟢 Исполнено: ${by('COMPLETED')}\n🔴 Отклонено: ${by('REJECTED')}\n\n💬 С непрочитанными: <b>${all.filter(o => o.unread_admin).length}</b>`;
}
const langKb = () => ({ inline_keyboard: [[{ text: '🇷🇺 Русский', callback_data: 'lang:ru' }, { text: '🇬🇧 English', callback_data: 'lang:en' }, { text: '🇦🇲 Հայերեն', callback_data: 'lang:hy' }]] });

async function onMessage(s, m) {
  if (m.chat.type !== 'private') return;
  const tu = m.from, team = await getTeam(s), role = roleOf(tu.id, team), staff = !!role, write = role === 'owner' || role === 'manager';
  let [u] = await touchUser(s, tu);
  const l = u.lang, id = m.chat.id;
  if (m.contact) { // сохраняем только собственный контакт пользователя
    if (m.contact.user_id !== tu.id) return;
    await touchUser(s, tu, { phone: (m.contact.phone_number.startsWith('+') ? '' : '+') + clip(m.contact.phone_number, 29) });
    return send(id, tr(l, 'phone_saved'), staff ? staffMenu : clientMenu(l));
  }
  const t = (m.text || '').trim(), parts = t.split(/\s+/);
  const cmd = m.web_app_data ? '/start' : t.startsWith('/') ? parts[0].split('@')[0].toLowerCase() : t;
  const act = ACT[t];

  if (write) { // «Отклонить» в боте → следующее сообщение = причина
    const pend = await getJ(s, `pend:${tu.id}`);
    if (pend) {
      if (cmd === '/cancel') { await s.delete(`pend:${tu.id}`); return send(id, 'Отменено. Статус заказа не изменён.'); }
      if (t && !t.startsWith('/') && !['📋 Все заказы', '📊 Статистика', '❓ Помощь'].includes(t)) {
        await s.delete(`pend:${tu.id}`);
        if (Date.now() - pend.at > 15 * 60 * 1000) return send(id, 'Время ожидания причины истекло. Нажмите «Отклонить» ещё раз.');
        const reason = clip(t, 500), o = await setStatus(s, pend.orderId, 'REJECTED', reason, { uid: tu.id, name: tu.first_name });
        if (!o) return send(id, 'Заказ не найден.');
        if (pend.mid) await tg('editMessageText', { chat_id: id, message_id: pend.mid, parse_mode: 'HTML', text: `${esc(pend.base || '')}\n\n<b>Статус: 🔴 Отклонён</b>\nПричина: ${esc(reason)}`, reply_markup: adminKb(o) });
        return send(id, `🔴 Заказ <b>#${o.id}</b> отклонён. Причина отправлена клиенту.`);
      }
    }
  }

  if (cmd === '/start') {
    if (!m.web_app_data && parts[1]) u = await applyParam(s, u, parts[1]);
    await send(id, m.web_app_data ? tr(l, 'welcome_fix') : tr(l, 'welcome'), { inline_keyboard: [[appBtn(tr(l, 'b_open'))], ...(staff ? [] : [[appBtn(tr(l, 'b_new'), 'new', 'success'), appBtn(tr(l, 'b_orders'), 'orders')]])] });
    return send(id, tr(l, 'menu_ready'), staff ? staffMenu : clientMenu(l));
  }
  if (cmd === '/lang' || act === 'lang') return send(id, tr(l, 'lang_prompt'), langKb());
  if (cmd === '/subscribe' || cmd === '/unsubscribe') { const on = cmd === '/subscribe'; await touchUser(s, tu, { sub: on }); return send(id, tr(l, on ? 'sub_on' : 'sub_off')); }
  if (cmd === '/new' || act === 'new') return send(id, tr(l, 'new_prompt'), { inline_keyboard: [[appBtn(tr(l, 'new_btn'), 'new', 'success')]] });
  if (cmd === '/orders' || act === 'orders' || t === '📋 Все заказы') {
    if (staff) {
      const all = await listOrders(s);
      return send(id, `📋 Заказов: <b>${all.length}</b>\n🟡 Новых: <b>${all.filter(o => o.status === 'NEW').length}</b>\n💬 С непрочитанными: <b>${all.filter(o => o.unread_admin).length}</b>`, { inline_keyboard: [[appBtn('Открыть заказы', 'orders')]] });
    }
    const mine = (await listOrders(s)).filter(o => o.user_id === tu.id).slice(0, 5);
    if (!mine.length) return send(id, tr(l, 'orders_none'), { inline_keyboard: [[appBtn(tr(l, 'new_btn'), 'new', 'success')]] });
    return send(id, `${tr(l, 'orders_title')}\n\n${mine.map(o => `<b>#${o.id}</b> · ${esc(o.service_type)} — ${tr(l, 'lbl_' + o.status)}${o.unread_client ? ' 💬' : ''}`).join('\n')}`,
      { inline_keyboard: [...mine.map(o => [appBtn(`#${o.id} · ${tr(l, 'lbl_' + o.status).slice(3)}`, `order=${o.id}`)]), [appBtn(tr(l, 'orders_all'), 'orders')]] });
  }
  if ((cmd === '/stats' || t === '📊 Статистика') && staff) return send(id, await summary(s), { inline_keyboard: [[appBtn('Открыть заказы', 'orders')]] });
  if (cmd === '/help' || act === 'help') return send(id, staff ? HELP_STAFF : tr(l, 'help'), { inline_keyboard: [[appBtn(tr(l, 'b_open'))]] });
  if (!staff) return send(id, tr(l, 'fallback'), { inline_keyboard: [[appBtn(tr(l, 'b_orders'), 'orders'), appBtn(tr(l, 'b_new'), 'new', 'success')]] });
}

async function webhook(req) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
  const u = await req.json().catch(() => ({}));
  try {
    const s = store();
    if (u.update_id) { const seen = (await getJ(s, 'lastupd')) ?? 0; if (u.update_id <= seen) return json({ ok: true }); await putJ(s, 'lastupd', u.update_id); }
    if (u.message) await onMessage(s, u.message);
    const cb = u.callback_query;
    if (cb?.data?.startsWith('lang:')) {
      const l = cb.data.slice(5);
      if (LANGS.includes(l)) {
        const [usr] = await touchUser(s, cb.from, { lang: l }), role = roleOf(cb.from.id, await getTeam(s));
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: tr(l, 'lang_set') });
        await send(cb.message.chat.id, tr(l, 'lang_set'), role ? staffMenu : clientMenu(l));
      }
    }
    const c = cb?.data?.match(/^st:(\d+):(\w+)$/);
    if (c) {
      const role = roleOf(cb.from.id, await getTeam(s)), actor = { uid: cb.from.id, name: cb.from.first_name };
      if (!(role === 'owner' || role === 'manager') || !STATUSES.includes(c[2])) await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' });
      else if (c[2] === 'REJECTED') {
        const base = (cb.message?.text || '').split('\n\nСтатус:')[0];
        await putJ(s, `pend:${cb.from.id}`, { orderId: Number(c[1]), mid: cb.message?.message_id, base: base.slice(0, 3000), at: Date.now() });
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Напишите причину отклонения' });
        await send(cb.message.chat.id, `✍️ Напишите причину отклонения заказа <b>#${c[1]}</b> одним сообщением — она будет видна клиенту.\n/cancel — отмена`, { force_reply: true, input_field_placeholder: 'Причина отклонения', selective: true });
      } else {
        const o = await setStatus(s, c[1], c[2], '', actor);
        await tg('answerCallbackQuery', { callback_query_id: cb.id, text: o ? tr('ru', 'lbl_' + c[2]) : 'Заказ не найден' });
        if (o) await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, parse_mode: 'HTML',
          text: `${esc((cb.message?.text || '').split('\n\nСтатус:')[0])}\n\n<b>Статус: ${tr('ru', 'lbl_' + c[2])}</b>`, reply_markup: adminKb(o) });
      }
    }
  } catch (e) { console.error('webhook', e); }
  return json({ ok: true });
}

/* ---------- Аналитика ---------- */
async function computeStats(s) {
  const all = await listOrders(s), live = all.filter(o => o.status !== 'REJECTED'), done = all.filter(o => o.status === 'COMPLETED');
  const sum = (a, f) => a.reduce((x, o) => x + (Number(f(o)) || 0), 0);
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10));
  const st = await Promise.all(days.map(d => getJ(s, `stat:${d}`)));
  const funnel = { open: 0, form: 0, submit: 0 }; st.forEach(x => x && Object.keys(funnel).forEach(k => funnel[k] += (x[k] || []).length));
  const resp = all.filter(o => o.first_reply_at).map(o => o.first_reply_at - o.created_at), rated = all.filter(o => o.review?.rating), src = {};
  all.forEach(o => { const k = o.source || 'direct'; src[k] = (src[k] || 0) + 1; });
  return {
    total: all.length, by_status: Object.fromEntries(STATUSES.map(k => [k, all.filter(o => o.status === k).length])),
    budget_total: sum(live, o => o.budget), paid_total: sum(all, o => o.paid), outstanding: sum(live, o => Math.max((o.budget || 0) - (o.paid || 0), 0)), revenue_done: sum(done, o => o.budget),
    avg_response_min: resp.length ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length / 60000) : null,
    rating: { avg: rated.length ? Math.round(sum(rated, o => o.review.rating) / rated.length * 10) / 10 : null, count: rated.length },
    sources: src, funnel, days, orders_by_day: days.map(d => all.filter(o => new Date(o.created_at).toISOString().slice(0, 10) === d).length),
    referred: all.filter(o => o.ref_by).length, hours: Math.round(sum(all, o => o.time_total) / 6) / 10, promo_orders: all.filter(o => o.promo).length, urgent: live.filter(o => o.priority === 'urgent' && o.status !== 'COMPLETED').length,
  };
}

/* ---------- API ---------- */
const uidOf = new WeakMap();
const handle = async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';

  if (path === '/webhook' && req.method === 'POST') return webhook(req);

  if (path === '/setup') { // разово после деплоя: /api/setup?key=<WEBHOOK_SECRET>
    const plain = (o, st = 200) => new Response(JSON.stringify(o, null, 1), { status: st, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!WEBHOOK_SECRET || url.searchParams.get('key') !== WEBHOOK_SECRET) return plain({ error: 'forbidden', secret_set: !!WEBHOOK_SECRET, token_set: !!BOT_TOKEN, admin_set: !!ADMIN_ID, url_set: !!WEBAPP_URL }, 403);
    const r = {};
    r.webhook = (await tg('setWebhook', { url: `${WEBAPP_URL}/api/webhook`, secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'] })).ok;
    r.menu = (await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'MAISONAX', web_app: { url: WEBAPP_URL } } })).ok;
    const cm = l => ['start', 'new', 'orders', 'lang', 'help'].map(c => ({ command: c, description: { start: { ru: 'Открыть MAISONAX', en: 'Open MAISONAX', hy: 'Բացել MAISONAX' }, new: { ru: 'Новая заявка', en: 'New request', hy: 'Նոր հայտ' }, orders: { ru: 'Мои заказы', en: 'My orders', hy: 'Իմ պատվերները' }, lang: { ru: 'Язык', en: 'Language', hy: 'Լեզու' }, help: { ru: 'Помощь', en: 'Help', hy: 'Օգնություն' } }[c][l] }));
    r.commands = (await tg('setMyCommands', { commands: cm('ru') })).ok;
    r.commands_en = (await tg('setMyCommands', { language_code: 'en', commands: cm('en') })).ok;
    r.commands_hy = (await tg('setMyCommands', { language_code: 'hy', commands: cm('hy') })).ok;
    r.staff_commands = (await tg('setMyCommands', { scope: { type: 'chat', chat_id: ADMIN_ID }, commands: [{ command: 'start', description: 'Панель' }, { command: 'orders', description: 'Все заказы' }, { command: 'stats', description: 'Статистика' }, { command: 'help', description: 'Помощь' }] })).ok;
    r.description = (await tg('setMyDescription', { description: 'MAISONAX — сайты, чат-боты и автоматизация для бизнеса. Оставьте заявку и общайтесь с командой прямо в Telegram.' })).ok;
    r.description_en = (await tg('setMyDescription', { language_code: 'en', description: 'MAISONAX — websites, chatbots and business automation. Submit a request and chat with the team right in Telegram.' })).ok;
    r.description_hy = (await tg('setMyDescription', { language_code: 'hy', description: 'MAISONAX — կայքեր, չաթ-բոտեր և բիզնեսի ավտոմատացում։ Թողեք հայտ և շփվեք թիմի հետ անմիջապես Telegram-ում։' })).ok;
    r.short = (await tg('setMyShortDescription', { short_description: 'Заявки и чат с командой MAISONAX' })).ok;
    r.bot = await botName(store());
    return plain(r);
  }

  if (path === '/cron') { // ручной запуск автоматики для проверки: /api/cron?key=<WEBHOOK_SECRET>
    if (!WEBHOOK_SECRET || url.searchParams.get('key') !== WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
    return json(await runCron(Number(url.searchParams.get('now')) || Date.now()));
  }
  const tu = verifyInitData(req.headers.get('x-init-data'));
  if (!tu) return json({ error: 'unauthorized' }, 401);
  uidOf.set(req, tu.id);
  const s = store(), team = await getTeam(s), role = roleOf(tu.id, team);
  const staff = !!role, write = role === 'owner' || role === 'manager', owner = role === 'owner';
  const actor = { uid: tu.id, name: tu.first_name || 'user', staff };
  const isJson = (req.headers.get('content-type') || '').includes('json');
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) && isJson ? await req.json().catch(() => ({})) : {};
  const deny = () => json({ error: 'forbidden' }, 403);

  if (path === '/me') {
    if (req.method === 'PATCH') {
      const p = {}; if (LANGS.includes(body.lang)) p.lang = body.lang; if (typeof body.sub === 'boolean') p.sub = body.sub;
      await touchUser(s, tu, p);
    }
    const [u] = await touchUser(s, tu);
    const rs = (await getJ(s, `refstat:${tu.id}`)) || { invited: 0, completed: 0 }, bn = await botName(s);
    return json({ id: tu.id, name: tu.first_name, role, staff, write, owner, lang: u.lang, sub: !!u.sub, phone: u.phone || null, ref: { link: bn ? `https://t.me/${bn}?start=ref_${tu.id}` : null, ...rs } });
  }
  if (path === '/track' && req.method === 'POST') {
    const [u] = await touchUser(s, tu); if (body.param) await applyParam(s, u, body.param);
    if (['open', 'form'].includes(body.e) && !staff) await track(s, tu.id, body.e);
    if (body.e === 'form' && !staff) await touchUser(s, tu, { form_at: Date.now() }); // для напоминания о брошенной заявке
    return json({ ok: true });
  }
  if (path === '/notifications') {
    const k = `nt:${tu.id}`, a = (await getJ(s, k)) || [];
    if (req.method === 'POST') { a.forEach(x => { x.read = true; }); await putJ(s, k, a); return json({ ok: true }); }
    return json({ list: a, unread: a.filter(x => !x.read).length });
  }
  if (path === '/team') {
    if (!staff) return deny();
    if (req.method === 'POST') {
      if (!owner) return deny();
      const id = Number(body.id), r = body.role;
      if (!id || id === ADMIN_ID || !['manager', 'viewer'].includes(r)) return json({ error: 'invalid' }, 400);
      const known = await getUser(s, id);
      team[id] = { role: r, name: clip(body.name, 40) || known?.name || 'ID ' + id, added_at: Date.now() };
      await saveTeam(s, team); await audit(s, actor, 'team_add', null, `${id} ${r}`);
      return json({ ok: true });
    }
    const ow = (await getUser(s, ADMIN_ID))?.name || 'Владелец';
    return json([{ id: ADMIN_ID, name: ow, role: 'owner' }, ...Object.entries(team).map(([id, v]) => ({ id: Number(id), name: v.name, role: v.role }))]);
  }
  if (path === '/team/remove' && req.method === 'POST') {
    if (!owner) return deny();
    delete team[Number(body.id)]; await saveTeam(s, team); await audit(s, actor, 'team_remove', null, String(body.id));
    return json({ ok: true });
  }
  if (path === '/stats') return write ? json(await computeStats(s)) : deny();
  if (path === '/audit') {
    if (!owner) return deny();
    const { blobs } = await s.list({ prefix: 'audit:' });
    const keys = blobs.map(b => b.key).sort().reverse().slice(0, 80);
    return json((await Promise.all(keys.map(k => getJ(s, k)))).filter(Boolean));
  }

  if (path === '/broadcast') {
    if (!owner) return deny();
    const { blobs } = await s.list({ prefix: 'usr:' });
    const ids = (await Promise.all(blobs.map(b => getJ(s, b.key)))).filter(u => u?.sub).map(u => u.id);
    if (req.method === 'POST') {
      const text = clip(body.text, 3500);
      if (!text || !ids.length) return json({ error: 'empty' }, 400);
      await putJ(s, 'bcast', { text, ids, idx: 0, sent: 0, failed: 0, at: Date.now() });
      await audit(s, actor, 'broadcast', null, `${ids.length} получателей: ${text.slice(0, 60)}`);
    }
    const job = await getJ(s, 'bcast');
    return json({ subscribers: ids.length, job: job ? { total: job.ids.length, idx: job.idx, sent: job.sent, failed: job.failed, done: job.idx >= job.ids.length } : null });
  }
  if (path === '/broadcast/run' && req.method === 'POST') {
    if (!owner) return deny();
    const job = await getJ(s, 'bcast');
    if (!job || job.idx >= job.ids.length) return json({ done: true });
    const t0 = Date.now();
    while (job.idx < job.ids.length && Date.now() - t0 < 6500) {
      const chunk = job.ids.slice(job.idx, job.idx + 20);
      const res = await Promise.all(chunk.map(async uid => { const l = (await getUser(s, uid))?.lang; return (await send(uid, `${esc(job.text)}\n\n${tr(l, 'unsub_hint')}`)).ok; }));
      res.forEach(ok => ok ? job.sent++ : job.failed++); job.idx += chunk.length;
      await sleep(900);
    }
    await putJ(s, 'bcast', job);
    return json({ total: job.ids.length, idx: job.idx, sent: job.sent, failed: job.failed, done: job.idx >= job.ids.length });
  }

  if (path === '/templates') {
    if (!staff) return deny();
    if (req.method === 'PUT') {
      if (!write) return deny();
      const list = (Array.isArray(body.list) ? body.list : []).slice(0, 30).map(x => ({ id: clip(x.id, 12) || crypto.randomBytes(3).toString('hex'), title: clip(x.title, 30), text: clip(x.text, 1000) })).filter(x => x.title && x.text);
      await putJ(s, 'tpl', list); await audit(s, actor, 'templates', null, `${list.length} шт.`);
      return json(list);
    }
    return json((await getJ(s, 'tpl')) ?? DEFAULT_TPL);
  }
  if (path === '/cfg') {
    if (!owner) return deny();
    if (req.method === 'PUT') {
      const n = x => Math.min(90, Math.max(0, Math.round(Number(x) || 0)));
      const c = { sla_min: Math.min(1440, Math.max(0, Math.round(Number(body.sla_min) || 0))), auto_aband: !!body.auto_aband, auto_review: !!body.auto_review, auto_holiday: !!body.auto_holiday, ref_reward_pct: n(body.ref_reward_pct), ref_welcome_pct: n(body.ref_welcome_pct) };
      await putJ(s, 'cfg', c); await audit(s, actor, 'cfg', null, JSON.stringify(c));
      return json(c);
    }
    return json(await getCfg(s));
  }
  if (path === '/promo/check' && req.method === 'POST') {
    const rk = `pchk:${tu.id}`, rl = (await getJ(s, rk)) || { n: 0, t: 0 };
    if (Date.now() - rl.t > 600000) { rl.n = 0; rl.t = Date.now(); }
    if (rl.n >= 15) return json({ error: 'rate_limit' }, 429); // защита от подбора кодов
    const pr = await getJ(s, `promo:${clip(body.code, 24).toUpperCase()}`), st = promoState(pr, tu.id);
    if (st === 'ok') return json({ ok: true, code: pr.code, percent: pr.percent, title: pr.title });
    rl.n++; await putJ(s, rk, rl);
    return json({ ok: false, reason: st });
  }
  if (path === '/promo/banners') {
    const list = (await Promise.all(((await getJ(s, 'pubidx')) || []).map(c => getJ(s, `promo:${c}`)))).filter(p => p && p.banner && promoState(p, tu.id) === 'ok');
    return json(list.map(p => ({ code: p.code, percent: p.percent, title: p.title, expires_at: p.expires_at })));
  }
  if (path === '/promo/my') {
    const list = (await Promise.all(((await getJ(s, `pmy:${tu.id}`)) || []).map(c => getJ(s, `promo:${c}`)))).filter(Boolean);
    return json(list.map(p => { const st = promoState(p, tu.id); return { code: p.code, percent: p.percent, kind: p.kind, active: st === 'ok', state: st }; }).reverse());
  }
  if (path === '/promos') {
    if (!owner) return deny();
    if (req.method === 'POST') {
      const percent = Math.round(Number(body.percent));
      if (!(percent >= 1 && percent <= 90)) return json({ error: 'invalid' }, 400);
      const raw = String(body.code || '').trim().toUpperCase(), code = raw.replace(/[^A-Z0-9_-]/g, '');
      if (raw && (code !== raw || code.length < 3 || code.length > 20)) return json({ error: 'bad_code' }, 400);
      if (code && await getJ(s, `promo:${code}`)) return json({ error: 'exists' }, 409);
      let exp = null;
      if (body.expires) {
        const t0 = /^\d{4}-\d{2}-\d{2}$/.test(body.expires) ? Date.parse(body.expires + 'T23:59:59Z') : NaN;
        if (Number.isNaN(t0) || new Date(t0).toISOString().slice(0, 10) !== body.expires) return json({ error: 'bad_date' }, 400); // 31 февраля и т.п.
        exp = t0 - TZ * 3600000;
        if (exp < Date.now()) return json({ error: 'past_date' }, 400);
      }
      const mode = ['single', 'per_user', 'multi'].includes(body.mode) ? body.mode : 'multi'; // разовый / один раз на клиента / многоразовый
      const lim = Math.round(Number(body.max_uses)) > 0 ? Math.round(Number(body.max_uses)) : null;
      const c = await mkPromo(s, { code, percent, title: clip(body.title, 40), expires_at: exp, max_uses: mode === 'single' ? 1 : lim, mode, per_user: mode === 'per_user', banner: !!body.banner });
      await audit(s, actor, 'promo', null, `${c} −${percent}%`);
    }
    return json((await Promise.all(((await getJ(s, 'pubidx')) || []).map(c => getJ(s, `promo:${c}`)))).filter(Boolean).map(p => ({ ...p, state: promoState(p, -1) })).reverse());
  }
  if ((path === '/promos/toggle' || path === '/promos/delete') && req.method === 'POST') {
    if (!owner) return deny();
    const code = clip(body.code, 24).toUpperCase(), pr = await getJ(s, `promo:${code}`);
    if (!pr || pr.owner_uid) return json({ error: 'not_found' }, 404);
    if (path.endsWith('delete')) { await s.delete(`promo:${code}`); await putJ(s, 'pubidx', (((await getJ(s, 'pubidx')) || []).filter(c => c !== code))); }
    else { pr.active = !pr.active; await putJ(s, `promo:${code}`, pr); }
    await audit(s, actor, 'promo', null, `${code} ${path.endsWith('delete') ? 'удалён' : pr.active ? 'включён' : 'выключен'}`);
    return json({ ok: true });
  }
  if (path === '/ref/top') {
    const { blobs } = await s.list({ prefix: 'refstat:' });
    const rows = await Promise.all(blobs.map(async b => { const id = Number(b.key.split(':')[1]), r = await getJ(s, b.key), u = await getUser(s, id); return { id, name: String(u?.name || 'ID').split(' ')[0], invited: r?.invited || 0, completed: r?.completed || 0 }; }));
    rows.sort((a, b) => b.completed - a.completed || b.invited - a.invited);
    return json({ top: rows.slice(0, 10).map(({ id, ...r }) => ({ ...r, me: id === tu.id })), my: rows.findIndex(r => r.id === tu.id) + 1 || null });
  }
  if (path === '/teamchat') {
    if (!staff) return deny();
    if (req.method === 'POST') {
      if (!write) return deny();
      const text = clip(body.text, 1000); if (!text) return json({ error: 'empty' }, 400);
      const cid = clip(body.cid, 40);
      if (cid) { const ex = await getJ(s, `cid:team:${cid}`); if (ex) { const old = await getJ(s, ex.key); if (old) return json(old); } }
      const id = Date.now() * 10 + crypto.randomInt(10), key = `tm:${String(id).padStart(16, '0')}`, msg = { id, uid: tu.id, name: actor.name, text, at: Date.now() };
      await putJ(s, key, msg); if (cid) await putJ(s, `cid:team:${cid}`, { key });
      await bump(s, 'ver:team');
      await notifyMentions(s, actor, text, { inline_keyboard: [[appBtn('💬 Чат команды', 'tchat')]] }, 'в чате команды');
      return json(msg);
    }
    const after = Number(url.searchParams.get('after')) || 0, v = await waitVer(s, 'ver:team', url.searchParams.get('v'), Number(url.searchParams.get('wait')) || 0);
    const { blobs } = await s.list({ prefix: 'tm:' });
    let keys = blobs.map(b => b.key).filter(k => Number(k.slice(3)) > after).sort(); if (!after) keys = keys.slice(-60);
    return json({ m: (await Promise.all(keys.map(k => getJ(s, k)))).filter(Boolean), v });
  }

  if (path === '/search') {
    const q = clip(url.searchParams.get('q'), 60).toLowerCase();
    if (q.length < 2) return json([]);
    const allowed = staff ? null : new Set((await listOrders(s)).filter(o => o.user_id === tu.id).map(o => o.id));
    const { blobs } = await s.list({ prefix: 'msg:' });
    const keys = blobs.map(b => b.key).filter(k => !allowed || allowed.has(Number(k.split(':')[1]))).sort((a, b) => Number(b.split(':')[2]) - Number(a.split(':')[2])).slice(0, 400);
    const hits = [];
    for (const m of await Promise.all(keys.map(k => getJ(s, k)))) if (m && (staff || !m.internal) && (m.text || '').toLowerCase().includes(q)) hits.push({ order_id: m.order_id, id: m.id, text: m.text.slice(0, 90), at: m.created_at });
    return json(hits.slice(0, 30));
  }

  if (path === '/orders' && req.method === 'POST') {
    const name = clip(body.name, 80), phone = clip(body.phone, 30), service_type = clip(body.service_type, 80), description = clip(body.description, 2000);
    const via = VIA.includes(body.contact_via) ? body.contact_via : 'telegram', time = TIMES.includes(body.contact_time) ? body.contact_time : 'any';
    if (!name || !/^\+?[\d\s()\-]{6,20}$/.test(phone) || !service_type || !description) return json({ error: 'invalid_fields' }, 400);
    const mine = (await listOrders(s)).filter(o => o.user_id === tu.id);
    if (!staff && mine.filter(o => Date.now() - o.created_at < 600000).length >= 3) return json({ error: 'rate_limit' }, 429);
    const [u] = await touchUser(s, tu, typeof body.sub === 'boolean' ? { sub: body.sub } : {});
    let promo = null; const pcode = clip(body.promo, 24).toUpperCase();
    if (pcode) { // код занимается атомарно ДО создания заказа
      const c = await claimPromo(s, pcode, tu.id);
      if (!c.ok) return c.reason === 'busy' ? json({ error: 'busy' }, 503) : json({ error: 'bad_promo', reason: c.reason }, 400);
      promo = { code: c.pr.code, percent: c.pr.percent };
    }
    let o;
    try {
      o = await createOrder(s, { user_id: tu.id, username: tu.username || null, name, phone, service_type, description, contact: { via, time }, source: u.src || null, ref_by: u.ref || null,
        status: 'NEW', priority: 'normal', tags: [], assignee: null, promo, created_at: Date.now() });
    } catch (e) { if (promo) await adjustPromo(s, promo.code, tu.id, -1).catch(() => {}); throw e; }
    await track(s, tu.id, 'submit');
    const txt = `🔔 <b>Новый заказ #${o.id}</b>\n\n👤 ${esc(name)}\n📞 ${esc(phone)}\n✈️ ${o.username ? '@' + esc(o.username) : 'без username'}\n💼 ${esc(service_type)}\n📲 Связь: ${VIA_RU[via]}, ${TIME_RU[time]}${o.source ? `\n🏷 Источник: ${esc(o.source)}` : ''}${o.ref_by ? '\n🎁 По приглашению клиента' : ''}${promo ? `\n🏷 Промокод ${promo.code} (−${promo.percent}%)` : ''}\n\n📝 ${esc(description)}`;
    for (const uid of writers(team)) { await send(uid, txt, adminKb(o)); await pushNt(s, uid, { type: 'order', order: o.id, text: `Новый заказ #${o.id} · ${name}` }); }
    await send(tu.id, tr(u.lang, 'order_ok', { id: o.id }), chatKb(o.id, u.lang));
    return json(pub(o, staff));
  }
  if (path === '/orders/my') return json((await listOrders(s)).filter(o => o.user_id === tu.id).map(o => pub(o, false)));
  if (path === '/orders/admin') return staff ? json(await listOrders(s)) : deny();

  if (path === '/orders/bulk' && req.method === 'POST') {
    if (!write) return deny();
    const ids = [...new Set((body.ids || []).map(Number))].filter(Boolean).slice(0, 50), v = body.value;
    let n = 0;
    for (const id of ids) {
      if (body.action === 'status' && STATUSES.includes(v)) { const reason = clip(body.reason, 500); if (v === 'REJECTED' && !reason) return json({ error: 'reason_required' }, 400); if (await setStatus(s, id, v, reason, actor)) n++; }
      else if (body.action === 'priority' && PRIOR.includes(v)) { if (await patchOrder(s, id, x => { x.priority = v; })) n++; }
      else if (body.action === 'assign') {
        const a = v ? { id: Number(v), name: v == ADMIN_ID ? ((await getUser(s, ADMIN_ID))?.name || 'Владелец') : team[v]?.name } : null;
        if (a && (!a.name || team[a.id]?.role === 'viewer')) continue;
        if (await patchOrder(s, id, x => { x.assignee = a; })) n++;
      }
    }
    await audit(s, actor, 'bulk_' + body.action, null, `${n} заказов → ${v ?? ''}`);
    return json({ ok: n });
  }

  const fm = path.match(/^\/files\/([0-9a-f]{24})$/);
  if (fm) {
    const f = await s.getWithMetadata(`file:${fm[1]}`, { type: 'arrayBuffer' });
    if (!f) return json({ error: 'not_found' }, 404);
    const fo = await getOrder(s, f.metadata.order_id);
    if (!fo || (!staff && fo.user_id !== tu.id)) return deny();
    return new Response(f.data, { headers: { 'Content-Type': f.metadata.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' } });
  }

  const rx = path.match(/^\/orders\/(\d+)\/messages\/(\d+)\/react$/);
  const m = rx ? [null, rx[1], 'react'] : path.match(/^\/orders\/(\d+)(?:\/(status|messages|upload|note|meta|assign|pin|typing|review|tasks|time))?$/);
  if (!m) return json({ error: 'not_found' }, 404);
  const o = await getOrder(s, m[1]);
  if (!o) return json({ error: 'not_found' }, 404);
  if (!staff && o.user_id !== tu.id) return deny();
  const side = staff ? 'admin' : 'client';

  if (!m[2]) return json(pub(o, staff));

  if (m[2] === 'status' && req.method === 'PATCH') {
    if (!write) return deny();
    if (!STATUSES.includes(body.status)) return json({ error: 'bad_status' }, 400);
    const reason = clip(body.reason, 500);
    if (body.status === 'REJECTED' && !reason) return json({ error: 'reason_required' }, 400);
    return json(pub(await setStatus(s, o.id, body.status, reason, actor), staff));
  }
  if (m[2] === 'note' && req.method === 'PATCH') {
    if (!write) return deny();
    const note = clip(body.note, 1000);
    await patchOrder(s, o.id, x => { if (note) x.note = note; else delete x.note; });
    await audit(s, actor, 'note', o.id);
    return json({ ok: true });
  }
  if (m[2] === 'meta' && req.method === 'PATCH') {
    if (!write) return deny();
    const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map(x => clip(x, 20)).filter(Boolean))].slice(0, 5) : [];
    const upd = { priority: PRIOR.includes(body.priority) ? body.priority : 'normal', tags, budget: num(body.budget), paid: num(body.paid), deadline: /^\d{4}-\d{2}-\d{2}$/.test(body.deadline || '') ? body.deadline : null };
    const r = await patchOrder(s, o.id, x => Object.assign(x, upd));
    await audit(s, actor, 'meta', o.id, `приоритет ${upd.priority}, бюджет ${upd.budget ?? '—'}, оплачено ${upd.paid ?? '—'}`);
    return json(r);
  }
  if (m[2] === 'assign' && req.method === 'PATCH') {
    if (!write) return deny();
    const aid = body.id ? Number(body.id) : null;
    const arole = aid ? roleOf(aid, team) : null;
    if (aid && !(arole === 'owner' || arole === 'manager')) return json({ error: 'invalid' }, 400);
    const a = aid ? { id: aid, name: aid === ADMIN_ID ? ((await getUser(s, ADMIN_ID))?.name || 'Владелец') : team[aid].name } : null;
    const r = await patchOrder(s, o.id, x => { x.assignee = a; });
    await audit(s, actor, 'assign', o.id, a ? a.name : 'снято');
    if (a && a.id !== tu.id) { await send(a.id, `📌 Вам назначен заказ <b>#${o.id}</b> · ${esc(o.name)}`, chatKb(o.id)); await pushNt(s, a.id, { type: 'assign', order: o.id, text: `Вам назначен заказ #${o.id}` }); }
    return json(r);
  }
  if (m[2] === 'pin' && req.method === 'PATCH') {
    if (!write) return deny();
    let pinned = null;
    if (body.id) {
      const pm = await getJ(s, mkey(o.id, Number(body.id)));
      if (!pm) return json({ error: 'not_found' }, 404);
      pinned = { id: pm.id, text: (pm.text || pm.file?.name || '').slice(0, 100), internal: !!pm.internal };
    }
    await patchOrder(s, o.id, x => { if (pinned) x.pinned = pinned; else delete x.pinned; });
    await audit(s, actor, pinned ? 'pin' : 'unpin', o.id); await bump(s, `ver:${o.id}`);
    return json({ ok: true, pinned });
  }
  if (m[2] === 'review' && req.method === 'POST') {
    if (staff || o.status !== 'COMPLETED') return deny();
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) return json({ error: 'invalid' }, 400);
    const review = { rating, text: clip(body.text, 500), at: Date.now() };
    await patchOrder(s, o.id, x => { x.review = review; }); await bump(s, `ver:${o.id}`);
    for (const uid of await staffTargets(s, o)) { await send(uid, `⭐ Отзыв по заказу <b>#${o.id}</b>: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}${review.text ? '\n' + esc(review.text) : ''}`, chatKb(o.id)); await pushNt(s, uid, { type: 'review', order: o.id, text: `Отзыв ${rating}/5 · заказ #${o.id}` }); }
    return json({ ok: true, review });
  }
  if (m[2] === 'typing' && req.method === 'POST') {
    if (staff && !write) return json({ ok: true });
    await putJ(s, `typ:${o.id}:${side}`, Date.now()); await bump(s, `ver:${o.id}`);
    return json({ ok: true });
  }
  if (m[2] === 'react' && req.method === 'PATCH') {
    if (staff && !write) return deny();
    const key = mkey(o.id, Number(rx[2])), msg = await getJ(s, key);
    if (!msg || (msg.internal && !staff)) return json({ error: 'not_found' }, 404);
    msg.reactions ||= {};
    if (EMOJI.includes(body.emoji) && msg.reactions[tu.id] !== body.emoji) msg.reactions[tu.id] = body.emoji; else delete msg.reactions[tu.id];
    await putJ(s, key, msg);
    const mk = `mod:${o.id}`, mods = (await getJ(s, mk)) || [];
    mods.push({ id: msg.id, at: Date.now(), reactions: msg.reactions }); await putJ(s, mk, mods.slice(-40)); await bump(s, `ver:${o.id}`);
    return json({ ok: true, reactions: msg.reactions });
  }

  if (m[2] === 'tasks' && req.method === 'PATCH') {
    if (!write) return deny();
    const tasks = (Array.isArray(body.tasks) ? body.tasks : []).slice(0, 30).map(x => ({ id: clip(x.id, 12) || crypto.randomBytes(4).toString('hex'), text: clip(x.text, 120), done: !!x.done })).filter(x => x.text);
    await patchOrder(s, o.id, x => { x.tasks = tasks; });
    return json({ ok: true, tasks });
  }
  if (m[2] === 'time' && req.method === 'POST') {
    if (!write) return deny();
    let entry = null;
    const r = await patchOrder(s, o.id, x => {
      x.time_log ||= [];
      if (body.remove) x.time_log = x.time_log.filter(e => e.id !== body.remove);
      else { const min = Math.round(Number(body.minutes)); if (min >= 1 && min <= 1440) { entry = { id: crypto.randomBytes(4).toString('hex'), uid: tu.id, name: actor.name, min, note: clip(body.note, 80), at: Date.now() }; x.time_log = [...x.time_log, entry].slice(-200); } }
      x.time_total = x.time_log.reduce((a, e) => a + e.min, 0);
    });
    if (!body.remove && !entry) return json({ error: 'invalid' }, 400);
    await audit(s, actor, 'time', o.id, body.remove ? 'удалена запись' : `+${entry.min} мин`);
    return json({ time_log: r.time_log, time_total: r.time_total });
  }

  if (m[2] === 'upload' && req.method === 'POST') {
    if (staff && !write) return deny();
    if (Number(req.headers.get('content-length')) > MAX_FILE + 2048) return json({ error: 'size' }, 413);
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_FILE) return json({ error: 'size' }, 413);
    const dec = h => { try { return decodeURIComponent(req.headers.get(h) || ''); } catch { return ''; } };
    const name = clip(dec('x-file-name') || 'file', 100).replace(/[\r\n"]/g, '');
    const origType = clip(req.headers.get('x-file-type'), 100).toLowerCase() || 'application/octet-stream';
    const silent = !staff && req.headers.get('x-silent') === '1' && Date.now() - o.created_at < 600000; // файлы к только что созданной заявке
    return json(await attach(s, o, actor, buf, origType, name, clip(dec('x-caption'), 1000), { silent }));
  }

  if (m[2] === 'messages') {
    if (req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0, since = Number(url.searchParams.get('since')) || 0;
      let ver = await waitVer(s, `ver:${o.id}`, url.searchParams.get('v'), Number(url.searchParams.get('wait')) || 0);
      const fo = (await getOrder(s, o.id)) || o;
      const { blobs } = await s.list({ prefix: `msg:${o.id}:` });
      const keys = blobs.map(b => b.key).filter(k => Number(k.split(':')[2]) > after).sort();
      const msgs = (await Promise.all(keys.map(k => getJ(s, k)))).filter(x => x && (staff || !x.internal));
      const flag = 'unread_' + side;
      if (role !== 'viewer' && (fo[flag] || msgs.some(x => x.sender_type !== (staff ? 'ADMIN' : 'CLIENT')))) {
        await patchOrder(s, o.id, x => { x[flag] = false; x['read_' + side + '_at'] = Date.now(); });
        ver = await bump(s, `ver:${o.id}`);
      }
      const tt = await getJ(s, `typ:${o.id}:${staff ? 'client' : 'admin'}`);
      const mods = ((await getJ(s, `mod:${o.id}`)) || []).filter(x => x.at > since);
      const fo2 = (await getOrder(s, o.id)) || fo;
      return json({ m: msgs, typing: !!tt && Date.now() - tt < 7000, mods, now: Date.now(), v: ver, st: `${fo2.status}|${fo2.reject_reason || ''}|${fo2.review ? 1 : 0}|${fo2.assignee?.id || 0}`, read: staff ? fo2.read_client_at || 0 : fo2.read_admin_at || 0, pinned: pub(fo2, staff).pinned || null });
    }
    if (req.method === 'POST') {
      if (staff && !write) return deny();
      const text = clip(body.text, 2000);
      if (!text) return json({ error: 'empty' }, 400);
      const internal = !!body.internal && write;
      let reply = null;
      if (body.reply_to) { const rm = await getJ(s, mkey(o.id, Number(body.reply_to))); if (rm && (staff || !rm.internal)) reply = { id: rm.id, from: rm.sender_type, name: rm.sender_name || '', text: (rm.text || rm.file?.name || '').slice(0, 80) }; }
      const cid = clip(body.cid, 40);
      if (cid) { const ex = await getJ(s, `cid:${o.id}:${cid}`); if (ex) { const old = await getJ(s, ex.key); if (old) return json(old); } } // повторная отправка из офлайн-очереди не создаёт дубль
      const msg = await addMsg(s, o, actor, text, { internal, reply });
      if (cid) await putJ(s, `cid:${o.id}:${cid}`, { key: mkey(o.id, msg.id) });
      return json(msg);
    }
  }
  return json({ error: 'not_found' }, 404);
};

/* ---------- Автоматика по расписанию (раз в 10 минут, см. cron.mjs) ---------- */
const HOL = [{ md: '01-01', k: 'hol_ny' }, { md: '03-08', k: 'hol_w' }, { md: '01-06', k: 'hol_xm', langs: ['hy'] }];
export async function runCron(now = Date.now()) {
  const s = store(), cfg = await getCfg(s), out = { sla: 0, aband: 0, review: 0, holiday: 0 };
  const orders = await listOrders(s);
  const users = (await Promise.all((await s.list({ prefix: 'usr:' })).blobs.map(b => getJ(s, b.key)))).filter(Boolean);
  if (cfg.sla_min > 0) { // контроль скорости ответа
    const lim = cfg.sla_min * 60000; let n = 0;
    for (const o of orders) {
      if (n >= 15 || ['COMPLETED', 'REJECTED'].includes(o.status)) continue;
      let why = '';
      if (!o.first_reply_at && !o.sla_alert && now - o.created_at > lim) { why = `заявка без ответа ${Math.round((now - o.created_at) / 60000)} мин`; await patchOrder(s, o.id, x => { x.sla_alert = now; }); }
      else if (o.unread_admin && o.last?.from === 'CLIENT' && now - o.last.at > lim && (!o.sla_msg || now - o.sla_msg > 2 * 3600000)) { why = `клиент ждёт ответа ${Math.round((now - o.last.at) / 60000)} мин`; await patchOrder(s, o.id, x => { x.sla_msg = now; }); }
      if (!why) continue;
      n++; out.sla++;
      for (const uid of new Set([ADMIN_ID, ...(o.assignee?.id ? [o.assignee.id] : [])])) { await send(uid, `⏰ <b>Заказ #${o.id}</b> · ${esc(o.name)}: ${why}`, chatKb(o.id)); await pushNt(s, uid, { type: 'sla', order: o.id, text: `⏰ Заказ #${o.id}: ${why}` }); }
    }
  }
  if (cfg.auto_aband) { // напоминание о брошенной заявке
    let n = 0;
    for (const u of users) {
      if (n >= 20 || !u.form_at || u.aband_for === u.form_at) continue;
      const age = now - u.form_at; if (age < 3 * 3600000 || age > 3 * 86400000) continue;
      if (orders.some(o => o.user_id === u.id && o.created_at > u.form_at)) continue;
      n++; out.aband++;
      await send(u.id, tr(u.lang, 'aband'), { inline_keyboard: [[appBtn(tr(u.lang, 'new_btn'), 'new', 'success')]] });
      await putJ(s, `usr:${u.id}`, { ...u, aband_for: u.form_at });
    }
  }
  if (cfg.auto_review) { // просьба об отзыве через неделю после выполнения
    let n = 0;
    for (const o of orders) {
      if (n >= 15 || o.status !== 'COMPLETED' || o.review || o.review_asked) continue;
      const at = [...(o.history || [])].reverse().find(h => h.s === 'COMPLETED')?.at;
      if (!at || now - at < 7 * 86400000) continue;
      n++; out.review++;
      const l = users.find(u => u.id === o.user_id)?.lang || 'ru';
      await patchOrder(s, o.id, x => { x.review_asked = now; });
      await send(o.user_id, tr(l, 'review_ask', { id: o.id }), chatKb(o.id, l));
    }
  }
  if (cfg.auto_holiday) { // поздравления подписчикам в 10:00–11:00 по времени команды
    const lt = new Date(now + TZ * 3600000), md = `${String(lt.getUTCMonth() + 1).padStart(2, '0')}-${String(lt.getUTCDate()).padStart(2, '0')}`, yr = lt.getUTCFullYear(), h = HOL.find(x => x.md === md);
    if (h && lt.getUTCHours() === 10) {
      let n = 0;
      for (const u of users) {
        if (n >= 30 || !u.sub || (h.langs && !h.langs.includes(u.lang)) || u.hol?.[`${yr}-${h.md}`]) continue;
        n++; out.holiday++;
        await send(u.id, `${tr(u.lang, h.k)}\n\n${tr(u.lang, 'unsub_hint')}`);
        await putJ(s, `usr:${u.id}`, { ...u, hol: { ...(u.hol || {}), [`${yr}-${h.md}`]: 1 } });
      }
    }
  }
  return out;
}

export default async (req) => {
  try {
    let r = await handle(req);
    const uid = uidOf.get(req);
    if (uid && r.status === 200 && (r.headers.get('content-type') || '').includes('json')) { // число непрочитанных уведомлений — в заголовке ответа
      const n = ((await getJ(store(), `nt:${uid}`)) || []).filter(x => !x.read).length;
      r = new Response(r.body, { status: 200, headers: { ...Object.fromEntries(r.headers), 'X-NT': String(n) } });
    }
    return r;
  } catch (e) { console.error(e); await send(ADMIN_ID, '⚠️ Ошибка сервера: ' + esc(e.message)); return json({ error: 'server' }, 500); }
};

export const config = { path: '/api/*' };
