import { сохранить } from './sheets.js';
import { требовать, доступ } from './config.js';
import { запрос, сон, вТаблицу, число, началоПериода, iso, локальныйISO } from './http.js';

/* ══════════════════ WILDBERRIES ══════════════════
 * Три разных хоста и до трёх разных токенов.
 * Статистика: заказы и продажи FBO, лимит один запрос в минуту.
 * Аналитика: остатки FBO — отчёт заказывают, ждут и скачивают.
 * Маркетплейс: остатки и задания FBS.
 */
const WB_СТАТ = 'https://statistics-api.wildberries.ru';
const WB_АНАЛИТИКА = 'https://seller-analytics-api.wildberries.ru';
const WB_МАРКЕТ = 'https://marketplace-api.wildberries.ru';
const WB_КОНТЕНТ = 'https://content-api.wildberries.ru';

/**
 * Лимит «не чаще раза в минуту» общий на весь аккаунт, а не на метод,
 * поэтому выдерживаем паузу сами: иначе второй запрос подряд гарантированно 429.
 */
const последние = new Map();
async function неЧаще(ключ, мс) {
  const было = последние.get(ключ) || 0;
  const ждать = было + мс - Date.now();
  if (ждать > 0) await сон(ждать);
  последние.set(ключ, Date.now());
}

const стат = async (путь) => {
  const [ключ] = требовать('WB_STATS_KEY');
  await неЧаще('wb-стат', 61000);
  return запрос(WB_СТАТ + путь, { headers: { Authorization: ключ } },
    { имя: `WB стат ${путь}`, пауза: 20000, попыток: 4 });
};

/** Аналитике нужен токен с категорией «Аналитика»; чаще всего это отдельный ключ. */
const аналитика = (путь) => {
  const ключ = доступ('WB_ANALYTICS_KEY') || требовать('WB_STATS_KEY')[0];
  return запрос(WB_АНАЛИТИКА + путь, { headers: { Authorization: ключ } },
    { имя: `WB аналитика ${путь.split('?')[0]}`, пауза: 20000, попыток: 4 });
};

const маркет = (путь, опции = {}) => {
  const [ключ] = требовать('WB_MARKET_KEY');
  return запрос(WB_МАРКЕТ + путь, {
    ...опции,
    headers: { Authorization: ключ, 'Content-Type': 'application/json', ...(опции.headers || {}) },
  }, { имя: `WB маркет ${путь}` });
};

/** В отчёте об остатках рядом с настоящими складами лежат итоговые псевдострочки. */
const ПСЕВДОСКЛАДЫ = new Set([
  'Всего находится на складах',
  'В пути до получателей',
  'В пути возвраты на склад WB',
]);

/**
 * Остатки FBO. Метод статистики /api/v1/supplier/stocks отключён (404 «deprecated»),
 * вместо него отчёт аналитики: заказать — дождаться — скачать.
 */
export async function wbОстаткиFbo() {
  const п = new URLSearchParams({
    locale: 'ru',
    groupByBrand: 'false',
    groupBySubject: 'false',
    groupBySa: 'true',
    groupByNm: 'true',
    groupByBarcode: 'true',
    groupBySize: 'true',
  });
  await неЧаще('wb-аналитика', 61000);
  const создан = await аналитика(`/api/v1/warehouse_remains?${п}`);
  const задание = создан?.data?.taskId || создан?.taskId;
  if (!задание) {
    throw new Error(`WB аналитика: отчёт не создан ${JSON.stringify(создан).slice(0, 200)}`);
  }

  let готов = false;
  for (let n = 0; n < 30 && !готов; n += 1) {
    await сон(10000);
    const ответ = await аналитика(`/api/v1/warehouse_remains/tasks/${задание}/status`);
    const статус = ответ?.data?.status || ответ?.status || '';
    if (статус === 'done') готов = true;
    else if (статус === 'canceled' || статус === 'purged') {
      throw new Error(`WB аналитика: отчёт ${статус}`);
    }
  }
  if (!готов) throw new Error('WB аналитика: отчёт не готов за 5 минут');

  const отчёт = await аналитика(`/api/v1/warehouse_remains/tasks/${задание}/download`);
  const записи = Array.isArray(отчёт) ? отчёт : (отчёт?.data || []);
  const отметка = вТаблицу(new Date());
  const строки = [];
  for (const з of записи) {
    const баркод = String(з.barcode || '');
    const артикул = з.vendorCode || '-';
    const nm = з.nmId || '-';
    for (const с of з.warehouses || []) {
      const имя = String(с.warehouseName || '');
      const кол = число(с.quantity);
      // отчёт даёт «в пути» только суммой по товару, поэтому по складам ставим нули,
      // а суммы выносим отдельной строкой — иначе итоги по колонкам задвоятся
      if (ПСЕВДОСКЛАДЫ.has(имя) || !кол) continue;
      строки.push([баркод, артикул, nm, имя || '-', кол, 0, 0, отметка]);
    }
    const кКлиенту = число(з.inWayToClient);
    const отКлиента = число(з.inWayFromClient);
    if (кКлиенту || отКлиента) {
      строки.push([баркод, артикул, nm, 'В пути', 0, кКлиенту, отКлиента, отметка]);
    }
  }
  await сохранить('FBO остатки ВБ', строки);
  return `строк ${строки.length}`;
}

export async function wbОстаткиFbs() {
  const склады = await маркет('/api/v3/warehouses');
  const баркоды = await баркодыИзКарточек();
  const отметка = вТаблицу(new Date());
  const строки = [];
  for (const склад of склады || []) {
    for (let i = 0; i < баркоды.length; i += 1000) {
      const пачка = баркоды.slice(i, i + 1000);
      const ответ = await маркет(`/api/v3/stocks/${склад.id}`, {
        method: 'POST',
        body: JSON.stringify({ skus: пачка.map((б) => б.баркод) }),
      });
      for (const с of ответ.stocks || []) {
        if (!число(с.amount)) continue;
        const найден = пачка.find((б) => б.баркод === String(с.sku));
        строки.push([String(с.sku), найден?.артикул || '-',
          склад.name || String(склад.id), число(с.amount), отметка]);
      }
      await сон(300);
    }
  }
  await сохранить('FBS остатки ВБ', строки);
  return `складов ${(склады || []).length}, строк ${строки.length}`;
}

/** Баркоды нужны для запроса остатков FBS: метод принимает только явный список. */
async function баркодыИзКарточек() {
  const [ключ] = требовать('WB_MARKET_KEY');
  const итог = [];
  let курсор = { limit: 100 };
  for (let n = 0; n < 200; n += 1) {
    const ответ = await запрос(`${WB_КОНТЕНТ}/content/v2/get/cards/list`, {
      method: 'POST',
      headers: { Authorization: ключ, 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { cursor: курсор, filter: { withPhoto: -1 } } }),
    }, { имя: 'WB карточки' });
    const карточки = ответ.cards || [];
    for (const к of карточки) {
      for (const размер of к.sizes || []) {
        for (const б of размер.skus || []) {
          итог.push({ баркод: String(б), артикул: к.vendorCode || '-' });
        }
      }
    }
    const к = ответ.cursor || {};
    if (карточки.length < 100 || !к.updatedAt) break;
    курсор = { limit: 100, updatedAt: к.updatedAt, nmID: к.nmID };
    await сон(300);
  }
  return итог;
}

export async function wbЗаказыFbo(задача) {
  const с = локальныйISO(началоПериода(задача));
  const заказы = await стат(`/api/v1/supplier/orders?dateFrom=${с}&flag=0`);
  // выкуп берём из отдельного отчёта: в заказах такого признака нет
  const продажи = await стат(`/api/v1/supplier/sales?dateFrom=${с}&flag=0`);
  const выкуплены = new Set((продажи || [])
    .filter((п) => String(п.saleID || '').startsWith('S'))
    .map((п) => String(п.srid || п.odid || '')));
  const отметка = вТаблицу(new Date());
  const строки = (заказы || []).map((з) => [
    String(з.srid || з.odid || ''), вТаблицу(з.date), з.supplierArticle || '-',
    з.nmId || '-', String(з.barcode || ''), 1,
    число(з.finishedPrice ?? з.totalPrice), з.warehouseName || '-',
    з.oblastOkrugName || з.regionName || '-',
    з.isCancel ? 'да' : '-',
    выкуплены.has(String(з.srid || з.odid || '')) ? 'да' : '-',
    отметка,
  ]);
  const итог = await сохранить('Заказы ВБ FBO', строки);
  return `заказов ${строки.length}, новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

export async function wbЗаказыFbs(задача) {
  const с = началоПериода(задача);
  const задания = [];
  let next = 0;
  for (let n = 0; n < 200; n += 1) {
    const ответ = await маркет(
      `/api/v3/orders?limit=1000&next=${next}&dateFrom=${Math.floor(с.getTime() / 1000)}`);
    const пачка = ответ.orders || [];
    задания.push(...пачка);
    if (пачка.length < 1000 || !ответ.next) break;
    next = ответ.next;
    await сон(300);
  }
  const статусы = new Map();
  for (let i = 0; i < задания.length; i += 1000) {
    const ид = задания.slice(i, i + 1000).map((з) => з.id);
    if (!ид.length) break;
    const ответ = await маркет('/api/v3/orders/status', {
      method: 'POST', body: JSON.stringify({ orders: ид }),
    });
    for (const с_ of ответ.orders || []) статусы.set(с_.id, с_);
    await сон(300);
  }
  const отметка = вТаблицу(new Date());
  const строки = задания.map((з) => {
    const ст = статусы.get(з.id) || {};
    return [String(з.id), вТаблицу(з.createdAt), з.article || '-',
      String(з.skus?.[0] || ''), 1, число(з.convertedPrice) / 100,
      ст.wbStatus || '-', ст.supplierStatus || '-',
      з.warehouseId || '-', отметка];
  });
  const итог = await сохранить('Заказы ВБ FBS', строки);
  return `заданий ${строки.length}, новых ${итог.новых}, изменено ${итог.изменено}${итог.заметка}`;
}

/* ══════════════════ OZON ══════════════════ */
const OZ = 'https://api-seller.ozon.ru';

function ozon(метод, тело) {
  const [clientId, apiKey] = требовать('OZON_CLIENT_ID', 'OZON_API_KEY');
  return запрос(OZ + метод, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Id': clientId, 'Api-Key': apiKey },
    body: JSON.stringify(тело),
  }, { имя: `Ozon ${метод}` });
}

export async function ozonОстаткиFbo() {
  const строки = [];
  const отметка = вТаблицу(new Date());
  let offset = 0;
  for (let n = 0; n < 200; n += 1) {
    const ответ = await ozon('/v2/analytics/stock_on_warehouses',
      { limit: 1000, offset, warehouse_type: 'FBO' });
    const пачка = (ответ.result || ответ).rows || [];
    for (const с of пачка) {
      строки.push([с.item_code || '-', String(с.sku ?? ''), с.warehouse_name || '-',
        с.cluster_name || с.warehouse_name || '-', число(с.free_to_sell_amount),
        число(с.promised_amount), число(с.reserved_amount), отметка]);
    }
    if (пачка.length < 1000) break;
    offset += 1000;
    await сон(300);
  }
  await сохранить('FBO остатки ОЗОН', строки);
  return `строк ${строки.length}`;
}

export async function ozonОстаткиFbs() {
  const строки = [];
  const отметка = вТаблицу(new Date());
  let cursor = '';
  for (let n = 0; n < 300; n += 1) {
    const ответ = await ozon('/v4/product/info/stocks',
      { cursor, limit: 1000, filter: { visibility: 'ALL' } });
    const тело = ответ.result || ответ;
    const товары = тело.items || [];
    for (const т of товары) {
      for (const с of т.stocks || []) {
        if (с.type && с.type !== 'fbs') continue;
        строки.push([т.offer_id || '-', String(т.product_id ?? ''), 'Склад продавца',
          число(с.present), число(с.reserved), отметка]);
      }
    }
    cursor = тело.cursor || '';
    if (!cursor || товары.length < 1000) break;
    await сон(300);
  }
  await сохранить('FBS остатки ОЗОН', строки);
  return `строк ${строки.length}`;
}

/**
 * Списки отправлений отдают не больше сотни за раз — на 1000 метод отвечает
 * 400 «value must be inside range (0, 100]». У остальных методов Ozon предел
 * другой, поэтому размер пачки здесь свой.
 */
const ПАЧКА_ОТПРАВЛЕНИЙ = 100;
const СТРАНИЦ_ОТПРАВЛЕНИЙ = 500;

async function ozonОтправления(метод, задача, кластер) {
  const с = началоПериода(задача);
  const по = new Date();
  const собрано = [];
  const виденные = new Set();
  let offset = 0;
  let причина = 'предел страниц';

  for (let n = 0; n < СТРАНИЦ_ОТПРАВЛЕНИЙ; n += 1) {
    const ответ = await ozon(метод, {
      dir: 'ASC', limit: ПАЧКА_ОТПРАВЛЕНИЙ, offset,
      filter: { since: iso(с), to: iso(по) },
      with: { analytics_data: true },
    });
    const тело = ответ.result || ответ;
    const пачка = Array.isArray(тело) ? тело : (тело.postings || []);

    let свежих = 0;
    for (const о of пачка) {
      const ключ = String(о.posting_number || '');
      if (ключ && виденные.has(ключ)) continue;
      if (ключ) виденные.add(ключ);
      собрано.push(о);
      свежих += 1;
    }

    if (пачка.length < ПАЧКА_ОТПРАВЛЕНИЙ) { причина = 'дочитано'; break; }
    // FBS-метод отдаёт has_next, FBO — голый массив; если признак есть, верим ему
    if (!Array.isArray(тело) && тело.has_next === false) { причина = 'дочитано'; break; }
    // страница целиком повторила уже прочитанное: offset не двигает выборку.
    // Листать дальше бессмысленно — так уходило 500 запросов за одними и теми же
    // ста заказами, а в лист попадало 50000 строк со ста уникальными ключами
    if (!свежих) { причина = 'повтор страницы'; break; }

    offset += ПАЧКА_ОТПРАВЛЕНИЙ;
    await сон(300);
  }

  let заметка = '';
  if (причина === 'повтор страницы') {
    заметка = `, ПАГИНАЦИЯ НЕ ЛИСТАЕТ: метод повторяет первые ${собрано.length} отправлений`;
    console.warn(`[${метод}] ${заметка.slice(2)}`);
  } else if (причина === 'предел страниц') {
    заметка = `, прочитано ${собрано.length} и упёрлись в предел страниц — сузьте период`;
    console.warn(`[${метод}] ${заметка.slice(2)}`);
  }

  const отметка = вТаблицу(new Date());
  const строки = собрано.flatMap((о) => {
    const а = о.analytics_data || {};
    return (о.products || []).map((т) => [
      о.posting_number, о.order_number || '-',
      вТаблицу(о.created_at || о.in_process_at),
      т.offer_id || '-', String(т.sku), число(т.quantity), число(т.price),
      о.status || '-',
      кластер ? (а.cluster_to || а.warehouse_name || '-') : (а.warehouse_name || '-'),
      а.region || '-', отметка,
    ]);
  });
  return { строки, заметка };
}

export async function ozonЗаказыFbo(задача) {
  const { строки, заметка } = await ozonОтправления('/v3/posting/fbo/list', задача, true);
  const итог = await сохранить('Заказы ОЗОН FBO', строки);
  return `строк ${строки.length}, новых ${итог.новых}, изменено ${итог.изменено}`
       + `${итог.заметка}${заметка}`;
}

export async function ozonЗаказыFbs(задача) {
  const { строки, заметка } = await ozonОтправления('/v4/posting/fbs/list', задача, false);
  const итог = await сохранить('Заказы ОЗОН FBS', строки);
  return `строк ${строки.length}, новых ${итог.новых}, изменено ${итог.изменено}`
       + `${итог.заметка}${заметка}`;
}
