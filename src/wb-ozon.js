import { сохранить } from './sheets.js';
import { требовать, доступ } from './config.js';
import { запрос, сон, вТаблицу, число, началоПериода, период, iso, локальныйISO } from './http.js';

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
    { имя: `WB стат ${путь}`, пауза: 61000, попыток: 3 });
};

/** Аналитике нужен токен с категорией «Аналитика»; чаще всего это отдельный ключ. */
const аналитика = (путь, тело = null) => {
  const ключ = доступ('WB_ANALYTICS_KEY') || требовать('WB_STATS_KEY')[0];
  const опции = { headers: { Authorization: ключ } };
  if (тело) {
    опции.method = 'POST';
    опции.headers['Content-Type'] = 'application/json';
    опции.body = JSON.stringify(тело);
  }
  return запрос(WB_АНАЛИТИКА + путь, опции,
    { имя: `WB аналитика ${путь.split('?')[0]}`, пауза: 21000, попыток: 4 });
};

const маркет = (путь, опции = {}) => {
  const [ключ] = требовать('WB_MARKET_KEY');
  return запрос(WB_МАРКЕТ + путь, {
    ...опции,
    headers: { Authorization: ключ, 'Content-Type': 'application/json', ...(опции.headers || {}) },
  }, { имя: `WB маркет ${путь}` });
};

/** В отчёте об остатках рядом с настоящими складами лежат итоговые псевдострочки. */
/**
 * Остатки FBO. Метод возвращает текущие остатки построчно: строка на размер.
 * Разбивки по складам у него нет — WB отдаёт единственный псевдосклад «Склад WB»
 * (warehouseId всегда -999999), поэтому колонка «Склад» одинаковая у всех строк.
 * Если WB когда-нибудь вернёт разбивку, имя приедет из ответа само.
 *
 * Данные на стороне WB обновляются раз в 30 минут, чаще спрашивать смысла нет.
 * Лимит метода — 3 запроса в минуту с интервалом 20 секунд.
 */
const ОСТАТКИ_FBO = '/api/analytics/v1/stocks-report/wb-warehouses';
const ПАЧКА_ОСТАТКОВ = 250000;
const СТРАНИЦ_ОСТАТКОВ = 10;

export async function wbОстаткиFbo() {
  // в ответе нет ни штрихкода, ни артикула продавца — только nmId и ID размера,
  // поэтому первые две колонки листа собираем из справочника карточек
  const поРазмерам = await карточкиПоРазмерам();
  const отметка = вТаблицу(new Date());
  const строки = [];
  let offset = 0;
  let дочитано = false;

  for (let n = 0; n < СТРАНИЦ_ОСТАТКОВ && !дочитано; n += 1) {
    await неЧаще('wb-аналитика', 21000);
    const ответ = await аналитика(ОСТАТКИ_FBO, { limit: ПАЧКА_ОСТАТКОВ, offset });
    // 204 «нет данных» приходит пустым телом, запрос отдаёт его как {}
    const пачка = ответ?.data?.items || [];
    for (const о of пачка) {
      const доступно = число(о.quantity);
      const кКлиенту = число(о.inWayToClient);
      const отКлиента = число(о.inWayFromClient);
      if (!доступно && !кКлиенту && !отКлиента) continue;
      const к = поРазмерам.get(String(о.chrtId)) || {};
      строки.push([
        к.баркод || '', к.артикул || '-', о.nmId || '-',
        о.warehouseName || 'Склад WB',
        доступно, кКлиенту, отКлиента, отметка,
      ]);
    }
    if (пачка.length < ПАЧКА_ОСТАТКОВ) дочитано = true;
    else offset += ПАЧКА_ОСТАТКОВ;
  }
  if (!дочитано) {
    throw new Error(`WB остатки FBO: прочитано ${строки.length} строк и упёрлись в предел страниц`);
  }

  await сохранить('FBO остатки ВБ', строки);
  const безКарточки = строки.filter((р) => !р[0]).length;
  return `строк ${строки.length}`
       + (безКарточки ? `, без штрихкода ${безКарточки} (нет в карточках)` : '');
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

/**
 * Обход карточек нужен и остаткам FBS (метод принимает только явный список
 * баркодов), и остаткам FBO (в ответе нет ни штрихкода, ни артикула продавца).
 * Обе задачи идут в одном проходе подряд, поэтому короткий кэш убирает второй
 * обход целиком; жить ему дольше прохода незачем — карточки меняются.
 */
const КЭШ_КАРТОЧЕК = 5 * 60 * 1000;
let карточки = { время: 0, список: null };

async function баркодыИзКарточек() {
  if (карточки.список && Date.now() - карточки.время < КЭШ_КАРТОЧЕК) return карточки.список;
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
          итог.push({
            баркод: String(б),
            артикул: к.vendorCode || '-',
            nmID: к.nmID,
            chrtID: размер.chrtID,
          });
        }
      }
    }
    const к = ответ.cursor || {};
    if (карточки.length < 100 || !к.updatedAt) break;
    курсор = { limit: 100, updatedAt: к.updatedAt, nmID: к.nmID };
    await сон(300);
  }
  карточки = { время: Date.now(), список: итог };
  return итог;
}

/** ID размера → штрихкод и артикул продавца. */
async function карточкиПоРазмерам() {
  const по = new Map();
  for (const б of await баркодыИзКарточек()) {
    const ключ = String(б.chrtID ?? '');
    // у размера обычно один баркод; если их несколько, берём первый и не спорим
    if (ключ && !по.has(ключ)) по.set(ключ, б);
  }
  return по;
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
    if (пачка.length < 1000 || !ответ.next || ответ.next === next) break;
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
// адрес вынесен в окружение только ради пробы: повадки пагинации на живом API
// не проверить, а меняются они, как выяснилось, вместе с поколением метода
const OZ = process.env.OZON_API_URL || 'https://api-seller.ozon.ru';

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
 * Списки отправлений отдают не больше сотни за раз: на 1000 метод отвечает
 * 400 «value must be inside range (0, 100]».
 *
 * Листать их `offset`-ом нельзя. У методов нового поколения такого поля нет,
 * а неизвестные поля метод молча выбрасывает — поэтому запрос выглядел рабочим,
 * отвечал 200 и на любой странице отдавал одну и ту же первую сотню.
 *
 * Обход идёт лестницей: следующая ступень включается сама, когда предыдущая
 * перестаёт двигать выборку.
 *   1. курсор метода;
 *   2. рез окна по дате последнего прочитанного отправления;
 *   3. делёж окна пополам.
 * Нижние две ступени опираются только на фильтр по датам, который заведомо
 * работает — им всё равно, чем именно метод листается и листается ли вообще.
 */
const ПАЧКА_ОТПРАВЛЕНИЙ = 100;
const ЗАПРОСОВ_МАКСИМУМ = 500;
// пауза между запросами — вежливость к живому API; для подставного адреса не нужна
const ПАУЗА_OZON = process.env.OZON_API_URL ? 0 : 300;

/** Одна страница. Поля запроса — только те, что у метода есть. */
async function страницаОтправлений(метод, с, по, курсор) {
  const тело = {
    limit: ПАЧКА_ОТПРАВЛЕНИЙ,
    filter: { since: iso(с), to: iso(по) },
    with: { analytics_data: true, financial_data: true },
    sort_dir: 'ASC',
  };
  if (курсор) тело.cursor = курсор;

  await сон(ПАУЗА_OZON);
  const ответ = await ozon(метод, тело);
  const т = ответ.result || ответ;
  const список = Array.isArray(т) ? т : (т.postings || null);
  if (!Array.isArray(список)) {
    // пустое тело, 204 или ответ чужой формы. Раньше это молча считалось
    // концом окна, то есть потеря данных выглядела как успешный прогон
    throw new Error(`метод ответил без списка отправлений на окне с ${вТаблицу(с)}`);
  }
  return {
    список,
    курсор: Array.isArray(т) ? '' : String(т.cursor || т.next_cursor || т.last_id || ''),
    естьЕщё: Array.isArray(т) ? null : т.has_next,
  };
}

const датаОтправления = (о) => new Date(о.created_at || о.in_process_at);

/**
 * Где резать окно. Годится любая точка строго внутри него, поэтому берём дату
 * последнего прочитанного отправления, а если она не внутри — середину.
 *
 * Двигать НАЧАЛО окна по дате страницы нельзя: это молчаливая ставка на то, что
 * метод сортирует ровно по тому полю, по которому считает период. Разойдись они —
 * начало перескочит через хвост сортировки, и отправления пропадут без единого
 * слова. Рез конца такой ставки не делает: две половины покрывают окно целиком
 * при любом месте реза.
 */
function точкаРеза(список, с, по) {
  const даты = список.map(датаОтправления)
    .filter((д) => !Number.isNaN(д.getTime())).map((д) => д.getTime());
  const макс = даты.length ? Math.max(...даты) : null;
  if (макс !== null && макс > с.getTime() && макс < по.getTime()) {
    return { дата: new Date(макс), способ: 'дата' };
  }
  const середина = Math.floor((с.getTime() + по.getTime()) / 2);
  if (середина > с.getTime() && середина < по.getTime()) {
    return { дата: new Date(середина), способ: 'делёж' };
  }
  return null;
}

async function обходОкна(метод, с, по, ст) {
  let курсор = '';
  let последняя = null;

  for (;;) {
    if (ст.запросов >= ЗАПРОСОВ_МАКСИМУМ) {
      throw new Error(`прочитано ${ст.собрано.length} отправлений и упёрлись в предел `
        + `${ЗАПРОСОВ_МАКСИМУМ} запросов — сузьте период`);
    }
    ст.запросов += 1;
    const стр = await страницаОтправлений(метод, с, по, курсор);
    последняя = стр.список;

    let свежих = 0;
    for (const о of стр.список) {
      const ключ = String(о.posting_number || '');
      if (ключ && ст.виденные.has(ключ)) continue;
      if (ключ) ст.виденные.add(ключ);
      ст.собрано.push(о);
      свежих += 1;
    }

    if (стр.список.length < ПАЧКА_ОТПРАВЛЕНИЙ) return;   // окно дочитано
    if (стр.естьЕщё === false) return;
    if (стр.курсор && стр.курсор !== курсор && свежих) {
      курсор = стр.курсор;
      ст.способы.add('курсор');
      continue;
    }
    break;   // курсор не двигает выборку — дальше идём по датам
  }

  // вся полная страница пришла одним мгновением: никакой рез её не разъединит,
  // а курсора нет. Ловим сразу, иначе обход сорок раз поделит окно пополам
  // и упрётся в предел запросов, сообщив совсем не о том
  const мгновения = new Set(последняя.map((о) => датаОтправления(о).getTime()));
  if (мгновения.size === 1) {
    throw new Error(`окно на ${вТаблицу(последняя[0] && датаОтправления(последняя[0]))} `
      + `уже не делится, а ${ПАЧКА_ОТПРАВЛЕНИЙ} отправлений в нём не кончаются`);
  }

  const рез = точкаРеза(последняя, с, по);
  if (!рез) {
    throw new Error(`окно на ${вТаблицу(с)} уже не делится, `
      + `а ${ПАЧКА_ОТПРАВЛЕНИЙ} отправлений в нём не кончаются`);
  }
  ст.способы.add(рез.способ);
  if (!ст.способы.has('курсор')) console.warn(`[${метод}] курсор не двигает выборку, дальше идём по дате`);

  await обходОкна(метод, с, рез.дата, ст);
  // правая половина начинается миллисекундой РАНЬШЕ реза: понимание границ
  // у метода неизвестно, и пойми он строго обе — отправление ровно на шве
  // выпало бы из обеих половин. Перекрытие снимет указатель прочитанных
  await обходОкна(метод, new Date(рез.дата.getTime() - 1), по, ст);
}

export async function ozonОтправления(метод, задача, кластер) {
  const { с, по } = период(задача);
  const ст = { виденные: new Set(), собрано: [], запросов: 0, способы: new Set() };
  await обходОкна(метод, с, по, ст);

  const отметка = вТаблицу(new Date());
  const строки = ст.собрано.flatMap((о) => {
    const а = о.analytics_data || {};
    const ф = о.financial_data || {};
    return (о.products || []).map((т) => [
      о.posting_number, о.order_number || '-',
      вТаблицу(датаОтправления(о)),
      т.offer_id || '-', String(т.sku), число(т.quantity), число(т.price),
      о.status || '-',
      // кластер приходит только в financial_data, а склад у FBS зовётся warehouse,
      // а не warehouse_name: перебираем оба, чтобы не зависеть от схемы метода
      кластер
        ? (ф.cluster_to || а.cluster_to || а.warehouse_name || а.warehouse || '-')
        : (а.warehouse_name || а.warehouse || '-'),
      а.region || '-', отметка,
    ]);
  });

  const порядок = ['курсор', 'дата', 'делёж'].filter((с_) => ст.способы.has(с_));
  return {
    строки,
    сводка: `отправлений ${ст.собрано.length}, запросов ${ст.запросов}, `
          + `листали: ${порядок.join(' + ') || 'одна страница'}`,
  };
}

async function ozonЗаказы(метод, лист, задача, кластер) {
  const { строки, сводка } = await ozonОтправления(метод, задача, кластер);
  const итог = await сохранить(лист, строки);
  return `строк ${строки.length}, новых ${итог.новых}, изменено ${итог.изменено}`
       + `${итог.заметка}, ${сводка}`;
}

export const ozonЗаказыFbo = (з) => ozonЗаказы('/v3/posting/fbo/list', 'Заказы ОЗОН FBO', з, true);
export const ozonЗаказыFbs = (з) => ozonЗаказы('/v4/posting/fbs/list', 'Заказы ОЗОН FBS', з, false);
