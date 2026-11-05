import { randomUUID } from 'node:crypto';
import { сохранить } from './sheets.js';
import { требовать, доступ } from './config.js';
import { запрос, сон, вТаблицу, число, период, текстом, строгоТекстом } from './http.js';

/* ══════════════════ ЛАМОДА (Seller Partner API v2) ══════════════════
 * https://public-api-seller.lamoda.ru/api, справочник — academy.lamoda.ru/articles/api/spec/
 *
 * Доступ — OAuth 2.0: client_id и client_secret из кабинета («Настройки
 * аккаунта» → «API ключи») меняются на токен методом POST /v2/auth-token,
 * а если он не ответит — JSON-RPC `v1.tokens.create` того же шлюза (метод
 * и поля — из открытой спецификации public-api-seller.lamoda.ru/swagger.json).
 * Токен живёт `expires_in` секунд; обновляем его за минуту до конца и сразу
 * же — по 401. Каждый метод требует ещё и `sellerId` (Seller Shop ID из
 * «Настройки аккаунта» → «Общая информация»): LAMODA_SELLER_ID, иначе из
 * токена, иначе первый партнёр из JSON-RPC `v1.partner.list`.
 *
 * Суммы — в копейках. Списки листаются `page`/`limit`, сколько всего страниц —
 * в `meta.totalPages`. Предел страницы у заказов и остатков — 1000,
 * у номенклатур — 25.
 *
 * Заказы у FBO и FBS идут одним методом, и признака схемы в заказе нет.
 * Схему позиции определяем по остаткам: SKU, заведённый только на складе
 * продавца, — FBS, всё остальное — FBO. Сколько позиций куда ушло, видно
 * в «Результате».
 */
const LM = process.env.LAMODA_API_URL || 'https://public-api-seller.lamoda.ru/api';
// тот же шлюз на JSON-RPC (v1): запасной путь за токеном и за номером продавца
const LM_RPC = process.env.LAMODA_RPC_URL || LM.replace(/\/api\/?$/, '/jsonrpc');
const СКЛАДЫ = { BYKOVO: 'Быково', SOFINO: 'Софьино' };

let токенЛм = { значение: '', до: 0 };

/** Вызов JSON-RPC v1. Ошибка метода приходит с HTTP 200 — внутри конверта. */
async function rpc(метод, параметры, т = '') {
  const путь = `/${метод.replace(/^v1\./, 'v1/')}`;
  const заголовки = { 'Content-Type': 'application/json' };
  if (т) заголовки.Authorization = `Bearer ${т}`;
  const ответ = await запрос(LM_RPC + путь, {
    method: 'POST',
    headers: заголовки,
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: метод, params: параметры }),
  }, { имя: `Lamoda ${метод}`, попыток: 3 });
  if (ответ?.error) {
    throw new Error(`Lamoda ${метод}: ${JSON.stringify(ответ.error).slice(0, 200)}`);
  }
  return ответ?.result ?? {};
}

/**
 * Токен v2 (`/v2/auth-token`), а если метод не отвечает — тот же обмен через
 * JSON-RPC `v1.tokens.create`: ключи у обоих одни, токен одного шлюза.
 */
async function выпуститьТокен() {
  const [id, secret] = требовать('LAMODA_CLIENT_ID', 'LAMODA_CLIENT_SECRET');
  let первая;
  try {
    const ответ = await запрос(`${LM}/v2/auth-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
    }, { имя: 'Lamoda токен', попыток: 3 });
    const значение = ответ.access_token || ответ.accessToken;
    if (значение) return { значение, живёт: ответ.expires_in ?? ответ.expiresIn };
    первая = new Error('Lamoda токен: в ответе нет access_token');
  } catch (е) {
    // сеть и пятисотки повторяет запрос; сюда доходят отказы метода
    первая = е;
  }
  try {
    const р = await rpc('v1.tokens.create',
      { clientId: id, clientSecret: secret, grantType: 'client_credentials' });
    if (р.accessToken) return { значение: р.accessToken, живёт: р.expiresIn };
    throw new Error('Lamoda v1.tokens.create: в ответе нет accessToken');
  } catch (е) {
    throw new Error(`Lamoda: токен не выдан — ${первая.message}; JSON-RPC: ${е.message}`);
  }
}

async function токен(заново = false) {
  if (!заново && токенЛм.значение && Date.now() < токенЛм.до) return токенЛм.значение;
  const { значение, живёт } = await выпуститьТокен();
  // документация обещает 15 минут; если срок не пришёл — берём их же
  const сек = Math.max(120, число(живёт) || 900);
  токенЛм = { значение, до: Date.now() + (сек - 60) * 1000 };
  return токенЛм.значение;
}

/**
 * Seller Shop ID. Берём из LAMODA_SELLER_ID, а если его нет — пробуем
 * прочитать из самого токена: он выдаётся под конкретного продавца.
 */
export function продавецИзТокена(т) {
  try {
    const тело = JSON.parse(Buffer.from(String(т).split('.')[1] || '', 'base64url').toString('utf8'));
    const ид = тело.sellerId ?? тело.seller_id ?? тело.sellerShopId ?? тело.shopId ?? тело.partnerId;
    return ид === undefined || ид === null ? '' : String(ид);
  } catch {
    return '';
  }
}

let продавецЛм = '';

async function продавец() {
  const задан = доступ('LAMODA_SELLER_ID');
  if (задан) return задан;
  if (продавецЛм) return продавецЛм;
  const т = await токен();
  продавецЛм = продавецИзТокена(т);
  if (продавецЛм) return продавецЛм;
  // последний шанс: список партнёров, доступных ключу, — у продавца он из одного
  try {
    const р = await rpc('v1.partner.list', { page: 1, limit: 10 }, т);
    const ид = (р.partners || []).map((п) => п.partner_id).find((х) => х !== undefined && х !== null);
    if (ид !== undefined) продавецЛм = String(ид);
  } catch (е) {
    console.warn(`Lamoda: номер продавца не прочитан из v1.partner.list: ${е.message}`);
  }
  if (продавецЛм) return продавецЛм;
  throw new Error('не заполнено: LAMODA_SELLER_ID (Seller Shop ID из «Настройки аккаунта» → «Общая информация»)');
}

async function лм(путь, параметры = {}) {
  const п = new URLSearchParams({ sellerId: await продавец() });
  for (const [к, в] of Object.entries(параметры)) {
    if (в !== undefined && в !== null && в !== '') п.set(к, String(в));
  }
  const адрес = `${LM}${путь}?${п}`;
  const опции = (т) => ({ headers: { Authorization: `Bearer ${т}` } });
  try {
    return await запрос(адрес, опции(await токен()), { имя: `Lamoda ${путь}` });
  } catch (е) {
    // токен мог истечь раньше обещанного: выпускаем новый и повторяем один раз
    if (!/HTTP 401/.test(е.message)) throw е;
    return запрос(адрес, опции(await токен(true)), { имя: `Lamoda ${путь}` });
  }
}

/** Постраничный обход: до `meta.totalPages`, с проверкой, что список вообще пришёл. */
export async function лмСтраницы(путь, поле, параметры = {}, limit = 1000) {
  const итог = [];
  for (let page = 1; ; page += 1) {
    if (page > 2000) throw new Error(`Lamoda ${путь}: упёрлись в предел страниц`);
    const ответ = await лм(путь, { ...параметры, page, limit });
    const пачка = ответ?.[поле];
    if (!Array.isArray(пачка)) throw new Error(`Lamoda ${путь}: ответ без списка «${поле}» на странице ${page}`);
    итог.push(...пачка);
    const всего = число(ответ.meta?.totalPages);
    if (!пачка.length || (всего && page >= всего) || (!всего && пачка.length < limit)) return итог;
    await сон(200);
  }
}

/**
 * Номенклатуры: размерный SKU Lamoda ↔ артикул продавца, штрихкод, размер.
 * Нужны и каталогу, и остаткам FBS (там приходит только SKU Lamoda), а
 * страница у метода всего на 25 позиций — поэтому короткий кэш на проход.
 */
const КЭШ = 5 * 60 * 1000;
let номенклатуры = { время: 0, список: null };

export async function лмТовары() {
  if (номенклатуры.список && Date.now() - номенклатуры.время < КЭШ) return номенклатуры.список;
  const список = (await лмСтраницы('/v2/nomenclatures', 'nomenclatures', { country: 'RU' }, 25))
    .map((н) => ({
      артикул: String(н.externalSku ?? '').trim(),
      ид: String(н.sku ?? '').trim(),
      баркоды: н.barcode ? [String(н.barcode)] : [],
      название: н.name || '',
      бренд: н.brand || '',
      категория: (н.categoryLevels || []).filter((к) => к.language !== 'EN').map((к) => к.name).pop() || '',
      родитель: String(н.externalParentSku ?? '').trim(),
      размер: String(н.externalSize ?? '').trim(),
    }));
  номенклатуры = { время: Date.now(), список };
  return список;
}

const остатокFbo = () => лмСтраницы('/v2/fbo/stocks', 'stocks', { withZeroQuantity: 'false' });
const остатокFbs = () => лмСтраницы('/v2/fbs/stocks', 'data', { withZeroQuantity: 'false' });

export async function лмОстаткиFbo() {
  const отметка = вТаблицу(new Date());
  const строки = (await остатокFbo())
    .filter((с) => число(с.quantity))
    .map((с) => [текстом(с.externalSku) || '-', текстом(с.sku) || '-',
      СКЛАДЫ[с.warehouseCode] || с.warehouseCode || 'Склад Lamoda', число(с.quantity),
      // резерва метод v2 не отдаёт
      '-', отметка]);
  await сохранить('FBO остатки Ламода', строки);
  return `строк ${строки.length}`;
}

export async function лмОстаткиFbs() {
  const поSku = new Map((await лмТовары()).map((т) => [т.ид, т.артикул]));
  const отметка = вТаблицу(new Date());
  let безАртикула = 0;
  const строки = (await остатокFbs())
    .filter((с) => число(с.quantity))
    .map((с) => {
      const артикул = поSku.get(String(с.sku));
      if (!артикул) безАртикула += 1;
      return [текстом(артикул) || '-', текстом(с.sku) || '-', 'Склад продавца',
        число(с.quantity), отметка];
    });
  await сохранить('FBS остатки Ламода', строки);
  return `строк ${строки.length}` + (безАртикула ? `, без артикула ${безАртикула}` : '');
}

/**
 * Позиции заказов. Список заказов отдаёт только шапку — позиции берём из
 * карточки каждого заказа. Позиция заказа — одна штука; одинаковые артикулы
 * в одном заказе складываем в одну строку, иначе ключ «заказ + артикул»
 * затёр бы вторую штуку первой.
 */
export function лмСтрокиЗаказа(з, схемаПо, отметка) {
  const группы = new Map();
  for (const т of з.items || []) {
    const артикул = String(т.externalSku ?? '').trim();
    const ключ = `${артикул}|${т.sku}`;
    if (!группы.has(ключ)) группы.set(ключ, { т, штук: 0, статусы: new Set() });
    const г = группы.get(ключ);
    г.штук += 1;
    г.статусы.add(т.status || з.status || '-');
  }
  const ид = з.orderId || з.id;
  return [...группы.values()].map(({ т, штук, статусы }) => ({
    схема: схемаПо(String(т.sku)),
    строка: [строгоТекстом(ид), вТаблицу(з.createdAt), текстом(т.externalSku) || '-',
      текстом(т.sku) || '-', штук,
      число((т.salePrice || т.paidPrice || т.basePrice)?.amount) / 100,
      // у штук одного артикула статусы бывают разные (одну выкупили, другую
      // вернули) — тогда пишем статус заказа целиком
      статусы.size === 1 ? [...статусы][0] : (з.status || '-'),
      '-', отметка],
  }));
}

/** Схема по остаткам: только на складе продавца — FBS, иначе FBO. */
export function схемаПоОстаткам(fbo, fbs) {
  const наFbo = new Set(fbo.map((с) => String(с.sku)));
  const наFbs = new Set(fbs.map((с) => String(с.sku)));
  return (sku) => (наFbs.has(sku) && !наFbo.has(sku) ? 'fbs' : 'fbo');
}

/**
 * Обе задачи заказов идут в одном проходе подряд, а карточку каждого заказа
 * приходится запрашивать отдельно — поэтому выборку кэшируем на проход.
 */
let заказыКэш = { ключ: '', время: 0, данные: null };

async function заказыЗаПериод(задача) {
  const { с, по } = период(задача);
  const ключ = `${с.getTime()}`;
  if (заказыКэш.данные && заказыКэш.ключ === ключ && Date.now() - заказыКэш.время < КЭШ) {
    return заказыКэш.данные;
  }
  const шапки = await лмСтраницы('/v2/orders', 'orders',
    { updatedAtFrom: с.toISOString(), updatedAtTo: по.toISOString() });
  const { полные, ненайдены } = await карточкиЗаказов(шапки);
  // остатки с нулями: SKU без остатка тоже говорит, на какой схеме он заведён
  const схемаПо = схемаПоОстаткам(
    await лмСтраницы('/v2/fbo/stocks', 'stocks', { withZeroQuantity: 'true' }),
    await лмСтраницы('/v2/fbs/stocks', 'data', { withZeroQuantity: 'true' }),
  );
  const отметка = вТаблицу(new Date());
  const позиции = полные.flatMap((з) => лмСтрокиЗаказа(з, схемаПо, отметка));
  заказыКэш = { ключ, время: Date.now(), данные: { заказов: полные.length, позиции, ненайдены } };
  return заказыКэш.данные;
}

/** Номера заказа из шапки списка, которыми можно спросить карточку, — без повторов. */
const номераЗаказа = (ш) => [...new Set([ш.orderId, ш.id]
  .filter((н) => н !== undefined && н !== null && String(н).trim() !== '').map(String))];

/**
 * Карточки заказов из списка.
 *
 * Раньше 404 на карточке ОДНОГО заказа ронял выгрузку целиком — для FBO и FBS
 * сразу, и так до тех пор, пока этот заказ оставался в окне. Чаще всего это
 * заказ, созданный только что: в списке он уже есть, а карточки ещё нет.
 *
 * Теперь на 404 пробуется второй номер из шапки, если он другой; не нашлось и
 * так — заказ пропускается и называется в «Результате». Он не теряется: окно
 * «Глубина дней» перечитывается каждый прогон, и следующий его заберёт.
 *
 * Если же не нашлась НИ ОДНА карточка — это не свежие заказы, а системная
 * ошибка: метод ждёт другой номер. Тогда падаем и называем поля шапки, чтобы
 * было видно, из чего выбирать.
 */
export async function карточкиЗаказов(шапки, получить = (путь) => лм(путь), пауза = 150) {
  const полные = [];
  const ненайдены = [];
  for (const ш of шапки) {
    let карточка = null;
    for (const н of номераЗаказа(ш)) {
      try {
        карточка = await получить(`/v2/orders/${encodeURIComponent(н)}`);
        break;
      } catch (е) {
        if (!/HTTP 404/.test(String(е?.message || ''))) throw е;
      }
    }
    if (карточка) полные.push(карточка);
    else ненайдены.push(номераЗаказа(ш)[0] || '(без номера)');
    if (пауза) await сон(пауза);
  }
  if (шапки.length && !полные.length) {
    throw new Error(`Lamoda: карточка не найдена ни у одного из ${шапки.length} заказов (HTTP 404) — `
      + 'похоже, метод /v2/orders/{…} ждёт другой номер заказа. '
      + `Поля заказа в списке: ${Object.keys(шапки[0] || {}).join(', ')}`);
  }
  return { полные, ненайдены };
}

async function лмЗаказы(лист, схема, задача) {
  const { заказов, позиции, ненайдены } = await заказыЗаПериод(задача);
  const строки = позиции.filter((п) => п.схема === схема).map((п) => п.строка);
  const итог = await сохранить(лист, строки);
  return `заказов ${заказов}, позиций ${схема.toUpperCase()} ${строки.length} из ${позиции.length}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`
       + (ненайдены.length
         ? `, карточка не найдена у ${ненайдены.length} (заберём следующим прогоном): `
           + `${ненайдены.slice(0, 3).join(', ')}${ненайдены.length > 3 ? ', …' : ''}`
         : '');
}

export const лмЗаказыFbo = (з) => лмЗаказы('Заказы Ламода FBO', 'fbo', з);
export const лмЗаказыFbs = (з) => лмЗаказы('Заказы Ламода FBS', 'fbs', з);
