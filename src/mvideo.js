import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, число, период, текстом, строгоТекстом,
  сСмещением } from './http.js';

/* ══════════════════ М.ВИДЕО (omninet) ══════════════════
 * Открытый API продавца М.Видео по стандарту omninet (спецификация —
 * omni-net.dev/spec, эталонный клиент — github.com/open-commerce-foundation/sdk-go).
 * Все методы — POST с JSON, листаются курсором: в первом запросе курсор null,
 * дальше — `next_cursor` из ответа.
 *
 * Ключ М.Видео уходит только заголовком `api-key` (так требует спецификация
 * omni-net.sellers.mvideo.ru/api-docs). `Authorization: Bearer` — только для
 * запасного адреса api.omniom.ru: на боевом шлюзе М.Видео лишний заголовок
 * авторизации ломал запрос. Адресов два: первый, который ответил не 404/401
 * и не сетевой ошибкой, запоминается до конца работы. MVIDEO_API_URL, если
 * задан, — единственный адрес.
 *
 * Первая страница списка. В спецификации у курсора и лимита нет ни границ,
 * ни обязательности, а шлюз на неподходящее тело отвечает голым «HTTP 400
 * Некорректный запрос». Поэтому первая страница пробуется в трёх видах — с
 * пустым курсором, без курсора, без курсора и лимита; вид, который прошёл,
 * запоминается для метода и дальше листается им же.
 *
 * Схем со своего склада две: FBS и DBS. Схемы FBO в API М.Видео нет вовсе
 * (в спецификации omni-net.sellers.mvideo.ru 32 метода, все — FBS, DBS и общие),
 * поэтому листы «FBO остатки Мвидео» и «Заказы Мвидео FBO» по-прежнему
 * заливаются выгрузкой из кабинета.
 *
 * Строка заказа — это одна позиция: `offer_id` и `product_id` у заказа свои,
 * количества в ответе нет. Если продавец уже передал экземпляры, их число и
 * есть количество; до этого — одна штука.
 *
 * Цены приходят целым числом, умноженным на 100.
 */
const АДРЕСА = process.env.MVIDEO_API_URL
  ? [process.env.MVIDEO_API_URL]
  : ['https://omni-net.sellers.mvideo.ru', 'https://api.omniom.ru'];
const ПАЧКА = 100;
const СТРАНИЦ = 2000;

let адрес = 0;
let адресПроверен = АДРЕСА.length === 1;

/** Ответ, после которого стоит попробовать другой адрес: не тот хост или не та авторизация. */
const другойАдрес = (е) => /HTTP 40[14]|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/
  .test(String(е?.message || ''));

/** Заголовки под адрес: М.Видео — только `api-key`, omniom — ещё и Bearer. */
export function заголовки(хост, ключ) {
  const з = {
    'Content-Type': 'application/json',
    'api-key': ключ,
    // площадка требует User-Agent у всех запросов
    'User-Agent': 'pereschet-po-razmeram/1.0',
  };
  if (/omniom\./i.test(хост)) з.Authorization = `Bearer ${ключ}`;
  return з;
}

async function мв(путь, тело) {
  const [ключ] = требовать('MVIDEO_API_KEY');
  const опции = {
    method: 'POST',
    body: JSON.stringify(тело),
  };
  const ошибки = [];
  for (;;) {
    опции.headers = заголовки(АДРЕСА[адрес], ключ);
    try {
      const ответ = await запрос(АДРЕСА[адрес] + путь, опции,
        { имя: `М.Видео ${путь}`, пауза: 2000, попыток: адресПроверен ? 5 : 2 });
      адресПроверен = true;
      return ответ;
    } catch (е) {
      if (адресПроверен || !другойАдрес(е) || адрес >= АДРЕСА.length - 1) {
        if (ошибки.length) throw new Error(`${е.message}; до этого: ${ошибки.join('; ')}`);
        throw е;
      }
      ошибки.push(`${АДРЕСА[адрес]}: ${String(е.message).slice(0, 120)}`);
      адрес += 1;
    }
  }
}

/** Виды тела первой страницы — от полного к пустому (см. шапку файла). */
export const ВИДЫ = [
  (фильтр) => ({ filter: фильтр, cursor: '', limit: ПАЧКА }),
  (фильтр) => ({ filter: фильтр, limit: ПАЧКА }),
  (фильтр) => ({ filter: фильтр }),
];
/** Какой вид тела прошёл у метода: путь → номер в ВИДЫ. */
const видМетода = new Map();

/** Тело запроса страницы: вид метода, а со второй страницы — ещё и курсор. */
export function телоСтраницы(вид, фильтр, курсор) {
  const тело = ВИДЫ[вид](фильтр);
  if (курсор) тело.cursor = курсор;
  return тело;
}

/** Первая страница: перебор видов тела по «HTTP 400», пока какой-то не пройдёт. */
async function перваяСтраница(путь, фильтр, вызов = мв) {
  const отказы = [];
  for (let вид = видМетода.get(путь) ?? 0; вид < ВИДЫ.length; вид += 1) {
    try {
      const ответ = await вызов(путь, телоСтраницы(вид, фильтр, ''));
      видМетода.set(путь, вид);
      return { ответ, вид };
    } catch (е) {
      if (!/HTTP 400/.test(String(е?.message || '')) || вид === ВИДЫ.length - 1) {
        if (отказы.length) е.message = `${е.message}; до этого вид тела ${отказы.join(', ')} — тоже 400`;
        throw е;
      }
      отказы.push(вид + 1);
    }
  }
  throw new Error(`М.Видео ${путь}: ни один вид тела не прошёл`);
}

/** Обход по курсору. Курсор, который не двигает выборку, — ошибка, а не круг. */
export async function мвОбход(путь, поле, фильтр = {}, вызов = мв) {
  const итог = [];
  let курсор = '';
  let вид = 0;
  for (let n = 0; n < СТРАНИЦ; n += 1) {
    let ответ;
    if (n === 0) ({ ответ, вид } = await перваяСтраница(путь, фильтр, вызов));
    else ответ = await вызов(путь, телоСтраницы(вид, фильтр, курсор));
    const пачка = ответ?.[поле];
    if (!Array.isArray(пачка)) {
      throw new Error(`М.Видео ${путь}: ответ без списка «${поле}» на странице ${n + 1}`);
    }
    итог.push(...пачка);
    const след = ответ.next_cursor || '';
    if (!след || !пачка.length) return итог;
    if (след === курсор) {
      throw new Error(`М.Видео ${путь}: курсор не двигает выборку на странице ${n + 1}`);
    }
    курсор = след;
    await сон(200);
  }
  throw new Error(`М.Видео ${путь}: прочитано ${итог.length} и упёрлись в предел страниц`);
}

/** Склады продавца: FBS-склады и DBS-локации. Нужны ради имени в колонке «Склад». */
async function склады() {
  const имена = new Map();
  const добавить = (список) => {
    for (const с of список) {
      const ид = String(с.location_id ?? '');
      if (ид) имена.set(ид, с.name || с.merchant_location_id || ид);
    }
  };
  добавить(await мвОбход('/v1/merchant/location/list', 'locations'));
  try {
    добавить(await мвОбход('/v1/location/list', 'locations'));
  } catch (е) {
    // DBS подключён не у всех: без него остаются только FBS-склады
    if (!/HTTP 40[34]/.test(е.message)) throw е;
  }
  return имена;
}

export function мвСтрокаОстатка(о, имена, отметка) {
  const ид = String(о.location_id ?? о.market_location_id ?? '');
  return [текстом(о.offer_id) || '-', имена.get(ид) || ид || '-',
    число(о.available_count ?? о.count), отметка];
}

/** Строка без своего склада, но со складом площадки, — не FBS-остаток. */
const наСкладеМП = (о) => !о.location_id && !!о.market_location_id;

export async function мвОстаткиFbs() {
  const имена = await склады();
  const отметка = вТаблицу(new Date());
  const строки = (await мвОбход('/v1/product/stock/info', 'stocks'))
    .filter((о) => !наСкладеМП(о))
    .filter((о) => число(о.available_count) || число(о.count))
    .map((о) => мвСтрокаОстатка(о, имена, отметка));
  await сохранить('FBS остатки Мвидео', строки);
  return `складов ${имена.size}, строк ${строки.length}`;
}

const ЦЕНЫ = ['CUSTOMER_FINAL_PRICE', 'CUSTOMER_PRICE', 'MERCHANT_FINAL_PRICE', 'MERCHANT_PRICE'];

/** Цена покупателя со скидками, если есть; иначе первая, какая пришла. В рублях. */
export function мвЦена(цены = []) {
  for (const тип of ЦЕНЫ) {
    const ц = цены.find((x) => x.price_type === тип);
    if (ц) return число(ц.value) / 100;
  }
  return цены.length ? число(цены[0].value) / 100 : 0;
}

export function мвСтрокаЗаказа(з, схема, отметка) {
  const штук = Array.isArray(з.exemplars) && з.exemplars.length ? з.exemplars.length : 1;
  return [строгоТекстом(з.merchant_order_id || з.client_order_id), вТаблицу(з.created_at),
    текстом(з.offer_id) || '-', штук, мвЦена(з.prices), з.status || '-', схема, отметка];
}

/**
 * Заказы со своего склада: FBS и DBS в один лист.
 *
 * FBS фильтруется по дате ИЗМЕНЕНИЯ — смена статуса у старого заказа сама
 * попадает в окно. DBS метод фильтрует только по дате создания, поэтому его
 * окно должно покрывать цикл доставки, как у Ozon и Яндекса.
 */
export async function мвЗаказыFbs(задача) {
  const { с, по } = период(задача);
  const fbs = await мвОбход('/v1/order/fbs/list', 'orders',
    { updated_since: сСмещением(с), updated_to: сСмещением(по) });
  let dbs = [];
  let заметка = '';
  try {
    dbs = await мвОбход('/v1/order/dbs/list', 'orders',
      { since: сСмещением(с), to: сСмещением(по) });
  } catch (е) {
    // DBS не подключён — это не ошибка FBS-выгрузки, но сказать об этом надо
    if (!/HTTP 40[34]/.test(е.message)) throw е;
    заметка = ', DBS недоступен';
  }
  const отметка = вТаблицу(new Date());
  const строки = [
    ...fbs.map((з) => мвСтрокаЗаказа(з, 'FBS', отметка)),
    ...dbs.map((з) => мвСтрокаЗаказа(з, 'DBS', отметка)),
  ];
  const итог = await сохранить('Заказы Мвидео FBS', строки);
  return `заказов FBS ${fbs.length}, DBS ${dbs.length}${заметка}, `
       + `новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

/** Соответствия «артикул продавца ↔ ID товара» для каталога. */
export async function мвТовары() {
  return (await мвОбход('/v1/product/mapping/list', 'mappings'))
    .map((м) => ({ артикул: String(м.offer_id ?? '').trim(), ид: String(м.product_id ?? '').trim(),
      архив: м.is_archived === true }))
    .filter((м) => м.артикул);
}
