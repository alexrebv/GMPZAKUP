import { сохранить } from './sheets.js';
import { требовать } from './config.js';
import { запрос, сон, вТаблицу, число, началоПериода, iso } from './http.js';

/* ══════════════════ WILDBERRIES ══════════════════
 * Два разных хоста и два разных токена.
 * Статистика: остатки и заказы FBO, лимит один запрос в минуту.
 * Маркетплейс: остатки и задания FBS.
 */
const WB_СТАТ = 'https://statistics-api.wildberries.ru';
const WB_МАРКЕТ = 'https://marketplace-api.wildberries.ru';
const WB_КОНТЕНТ = 'https://content-api.wildberries.ru';

const стат = (путь) => {
  const [ключ] = требовать('WB_STATS_KEY');
  return запрос(WB_СТАТ + путь, { headers: { Authorization: ключ } },
    { имя: `WB стат ${путь}`, пауза: 20000, попыток: 4 });
};

const маркет = (путь, опции = {}) => {
  const [ключ] = требовать('WB_MARKET_KEY');
  return запрос(WB_МАРКЕТ + путь, {
    ...опции,
    headers: { Authorization: ключ, 'Content-Type': 'application/json', ...(опции.headers || {}) },
  }, { имя: `WB маркет ${путь}` });
};

export async function wbОстаткиFbo() {
  const дата = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19);
  const данные = await стат(`/api/v1/supplier/stocks?dateFrom=${дата}`);
  const отметка = вТаблицу(new Date());
  const строки = (данные || [])
    .filter((с) => число(с.quantity) > 0 || число(с.inWayToClient) > 0)
    .map((с) => [
      String(с.barcode || ''), с.supplierArticle || '-', с.nmId || '-',
      с.warehouseName || '-', число(с.quantity),
      число(с.inWayToClient), число(с.inWayFromClient), отметка,
    ]);
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
  const с = началоПериода(задача);
  const заказы = await стат(`/api/v1/supplier/orders?dateFrom=${с.toISOString().slice(0, 19)}&flag=0`);
  // выкуп берём из отдельного отчёта: в заказах такого признака нет
  const продажи = await стат(`/api/v1/supplier/sales?dateFrom=${с.toISOString().slice(0, 19)}&flag=0`);
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
  return `заказов ${строки.length}, новых ${итог.новых}`;
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
    if (пачка.length < 1000) break;
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
  return `заданий ${строки.length}, новых ${итог.новых}`;
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

async function ozonОтправления(метод, задача, кластер) {
  const с = началоПериода(задача);
  const по = new Date();
  const собрано = [];
  let offset = 0;
  for (let n = 0; n < 300; n += 1) {
    const ответ = await ozon(метод, {
      dir: 'ASC', limit: 1000, offset,
      filter: { since: iso(с), to: iso(по) },
      with: { analytics_data: true },
    });
    const тело = ответ.result || ответ;
    const пачка = Array.isArray(тело) ? тело : (тело.postings || []);
    собрано.push(...пачка);
    if (пачка.length < 1000) break;
    offset += 1000;
    await сон(300);
  }
  const отметка = вТаблицу(new Date());
  return собрано.flatMap((о) => {
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
}

export async function ozonЗаказыFbo(задача) {
  const строки = await ozonОтправления('/v3/posting/fbo/list', задача, true);
  const итог = await сохранить('Заказы ОЗОН FBO', строки);
  return `строк ${строки.length}, новых ${итог.новых}`;
}

export async function ozonЗаказыFbs(задача) {
  const строки = await ozonОтправления('/v4/posting/fbs/list', задача, false);
  const итог = await сохранить('Заказы ОЗОН FBS', строки);
  return `строк ${строки.length}, новых ${итог.новых}`;
}
