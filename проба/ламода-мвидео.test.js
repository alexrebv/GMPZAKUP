import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/tz.js';
import { лмСтрокиЗаказа, схемаПоОстаткам, продавецИзТокена } from '../src/lamoda.js';
import { мвСтрокаЗаказа, мвЦена, мвОбход, заголовки, телоСтраницы } from '../src/mvideo.js';
import { СХЕМЫ } from '../src/schemas.js';

const без = (з) => String(з).replace(/^'/, '');

test('Ламода: одинаковые штуки в заказе складываются в одну строку', () => {
  const заказ = { orderId: 'RU1', status: 'DELIVERED', createdAt: '2026-10-01T10:00:00Z', items: [
    { sku: 'MP1', externalSku: 'A-28', status: 'DELIVERED', salePrice: { amount: 199000 } },
    { sku: 'MP1', externalSku: 'A-28', status: 'DELIVERED', salePrice: { amount: 199000 } },
    { sku: 'MP2', externalSku: 'A-29', status: 'CANCELED', salePrice: { amount: 199000 } },
  ] };
  const строки = лмСтрокиЗаказа(заказ, () => 'fbo', '-');
  assert.equal(строки.length, 2);
  const [а] = строки;
  assert.equal(а.строка.length, СХЕМЫ['Заказы Ламода FBO'].length);
  assert.equal(а.строка[4], 2, 'две штуки');
  assert.equal(а.строка[5], 1990, 'копейки → рубли');
  assert.equal(без(а.строка[0]), 'RU1');
  assert.equal(строки[1].строка[6], 'CANCELED');
});

test('Ламода: разные статусы у штук одного артикула — пишем статус заказа', () => {
  const заказ = { orderId: 'RU2', status: 'PARTIALLY', items: [
    { sku: 'MP1', externalSku: 'A-28', status: 'DELIVERED' },
    { sku: 'MP1', externalSku: 'A-28', status: 'RETURNED' },
  ] };
  assert.equal(лмСтрокиЗаказа(заказ, () => 'fbo', '-')[0].строка[6], 'PARTIALLY');
});

test('Ламода: схема по остаткам — только на своём складе значит FBS', () => {
  const схема = схемаПоОстаткам([{ sku: 'A' }, { sku: 'B' }], [{ sku: 'B' }, { sku: 'C' }]);
  assert.equal(схема('A'), 'fbo');
  assert.equal(схема('B'), 'fbo');
  assert.equal(схема('C'), 'fbs');
  assert.equal(схема('Z'), 'fbo');
});

test('Ламода: sellerId читается из токена, мусор — пустая строка', () => {
  const тело = Buffer.from(JSON.stringify({ sellerId: 12345 })).toString('base64url');
  assert.equal(продавецИзТокена(`x.${тело}.y`), '12345');
  assert.equal(продавецИзТокена('не-jwt'), '');
});

test('М.Видео: цена из копеек, количество по экземплярам, схема в строке', () => {
  const з = { merchant_order_id: '987654321', created_at: '2026-10-01T10:00:00+03:00',
    offer_id: '025-12-28', status: 'DELIVERED',
    prices: [{ price_type: 'MERCHANT_PRICE', value: 150000 }, { price_type: 'CUSTOMER_FINAL_PRICE', value: 129900 }],
    exemplars: [{}, {}] };
  const р = мвСтрокаЗаказа(з, 'FBS', '-');
  assert.equal(р.length, СХЕМЫ['Заказы Мвидео FBS'].length);
  assert.equal(р[3], 2);
  assert.equal(р[4], 1299);
  assert.equal(р[6], 'FBS');
  assert.equal(мвЦена([]), 0);
  assert.equal(мвСтрокаЗаказа({ ...з, exemplars: [] }, 'DBS', '-')[3], 1, 'без экземпляров — одна штука');
});

test('М.Видео: обход по курсору доходит до конца и не крутится на месте', async () => {
  const прежний = globalThis.fetch;
  process.env.MVIDEO_API_KEY = 'k';
  const страницы = { '': { stocks: [1, 2], next_cursor: 'a' }, a: { stocks: [3], next_cursor: '' } };
  const курсоры = [];
  globalThis.fetch = async (у, о) => {
    const тело = JSON.parse(о.body);
    курсоры.push(тело.cursor);
    assert.equal(о.headers['api-key'], 'k');
    assert.equal(о.headers.Authorization, undefined, `на ${у} ключ — только в api-key`);
    return new Response(JSON.stringify(страницы[String(тело.cursor)]), { status: 200 });
  };
  try {
    assert.deepEqual(await мвОбход('/v1/product/stock/info', 'stocks'), [1, 2, 3]);
    assert.deepEqual(курсоры, ['', 'a']);
    globalThis.fetch = async () => new Response(JSON.stringify({ stocks: [1], next_cursor: 'same' }), { status: 200 });
    await assert.rejects(мвОбход('/v1/product/stock/info', 'stocks'), /курсор не двигает/);
    globalThis.fetch = async () => new Response(JSON.stringify({ oops: 1 }), { status: 200 });
    await assert.rejects(мвОбход('/v1/product/stock/info', 'stocks'), /без списка/);
  } finally {
    globalThis.fetch = прежний;
  }
});


test('М.Видео: на шлюзе М.Видео ключ одним способом — api-key или Bearer, на omniom — обоими', () => {
  const мвидео = 'https://omni-net.sellers.mvideo.ru';
  assert.equal(заголовки(мвидео, 'k').Authorization, undefined);
  assert.equal(заголовки(мвидео, 'k')['api-key'], 'k');
  // вторая схема — один Bearer, как велит стандарт omninet: не пара заголовков
  assert.equal(заголовки(мвидео, 'k', 1).Authorization, 'Bearer k');
  assert.equal(заголовки(мвидео, 'k', 1)['api-key'], undefined);
  assert.equal(заголовки('https://api.omniom.ru', 'k').Authorization, 'Bearer k');
  assert.equal(заголовки('https://api.omniom.ru', 'k')['api-key'], 'k');
});

test('М.Видео: тело страницы — вид метода плюс курсор со второй страницы', () => {
  assert.deepEqual(телоСтраницы(0, {}, ''), { filter: {}, cursor: '', limit: 100 });
  assert.deepEqual(телоСтраницы(1, {}, ''), { filter: {}, limit: 100 });
  assert.deepEqual(телоСтраницы(2, { a: 1 }, 'x'), { filter: { a: 1 }, cursor: 'x' });
});

test('М.Видео: на «HTTP 400» первая страница пробует другой вид тела и листает им же', async () => {
  const тела = [];
  const вызов = async (_п, тело) => {
    тела.push(тело);
    if ('cursor' in тело && тело.cursor === '') throw new Error('М.Видео: HTTP 400 {"message":"Некорректный запрос"}');
    if (!тело.cursor) return { mappings: [{ offer_id: 'A' }], next_cursor: 'c1' };
    return { mappings: [{ offer_id: 'B' }], next_cursor: '' };
  };
  const итог = await мвОбход('/проба/400', 'mappings', {}, вызов);
  assert.deepEqual(итог.map((м) => м.offer_id), ['A', 'B']);
  assert.deepEqual(тела, [
    { filter: {}, cursor: '', limit: 100 },
    { filter: {}, limit: 100 },
    { filter: {}, limit: 100, cursor: 'c1' },
  ]);
  // вид запомнен: второй обход сразу без пустого курсора
  тела.length = 0;
  await мвОбход('/проба/400', 'mappings', {}, вызов);
  assert.deepEqual(тела[0], { filter: {}, limit: 100 });
});

test('М.Видео: если 400 на всех видах тела — ошибка со всей историей', async () => {
  const вызов = async () => { throw new Error('М.Видео: HTTP 400 {}'); };
  await assert.rejects(мвОбход('/проба/всё400', 'mappings', {}, вызов), /HTTP 400.*вид тела 1, 2 — тоже 400/);
  const чужая = async () => { throw new Error('М.Видео: HTTP 500 {}'); };
  await assert.rejects(мвОбход('/проба/500', 'mappings', {}, чужая), (е) => !/вид тела/.test(е.message));
});

// ─────────────────── М.Видео: FBO ───────────────────

test('М.Видео: остатки на складе площадки идут в FBO, а не выбрасываются', async () => {
  const { разделитьОстатки } = await import('../src/mvideo.js');
  const ответ = [
    { offer_id: 'СВОЙ-1', location_id: 'wh-1', count: 5 },               // свой склад → FBS
    { offer_id: 'ПЛОЩ-1', market_location_id: 'koledino', count: 7 },    // склад площадки → FBO
    { offer_id: 'ПЛОЩ-2', market_location_id: 'koledino', count: 0 },    // ноль — никуда
    { offer_id: 'ОБА', location_id: 'wh-1', market_location_id: 'x', count: 3 }, // есть свой склад → FBS
  ];
  const { fbs, fbo } = разделитьОстатки(ответ);
  assert.deepEqual(fbs.map((о) => о.offer_id), ['СВОЙ-1', 'ОБА']);
  assert.deepEqual(fbo.map((о) => о.offer_id), ['ПЛОЩ-1'],
    'строка со складом площадки и без своего склада — это FBO-остаток');
});

test('М.Видео: строка заказа FBO — по колонкам листа, цена из копеек, одна штука', async () => {
  const { мвСтрокаЗаказаFbo } = await import('../src/mvideo.js');
  const р = мвСтрокаЗаказаFbo({
    merchant_order_id: '7513432034713632943', created_at: '2026-11-03T10:00:00+03:00',
    offer_id: '1970-01-29', status: 'DELIVERED',
    prices: [{ price_type: 'MERCHANT_PRICE', value: 599900 },
      { price_type: 'CUSTOMER_FINAL_PRICE', value: 549900 }],
  }, '05.11.2026 12:00:00');
  assert.equal(р.length, СХЕМЫ['Заказы Мвидео FBO'].length, 'ширина строки не по схеме');
  assert.equal(р[0], "'7513432034713632943", 'длинный номер заказа — строго текстом');
  assert.equal(р[2], "'1970-01-29", 'артикул-дата — текстом');
  assert.equal(р[3], 1, 'один заказ в API — один товар');
  assert.equal(р[4], 5499, 'цена покупателя со скидкой, из копеек');
  assert.equal(р[5], 'DELIVERED');
});

test('М.Видео: OPERATION_NOT_SUPPORTED не перебирает виды тела', async () => {
  const { мвОбход, неПодключено } = await import('../src/mvideo.js');
  let вызовов = 0;
  const вызов = async () => {
    вызовов += 1;
    throw new Error('М.Видео /v1/order/fbo/list: HTTP 400 {"error_type":"ERROR_TYPE_UNSPECIFIED",'
      + '"code":"OPERATION_NOT_SUPPORTED","message":"операция недоступна для текущей конфигурации"}');
  };
  await assert.rejects(мвОбход('/v1/order/fbo/list-проба', 'orders', {}, вызов), (е) => {
    assert.ok(неПодключено(е), 'признак неподключённой схемы потерялся');
    return true;
  });
  assert.equal(вызовов, 1,
    `вызовов ${вызовов}: другой вид тела не лечит неподключённую схему, перебирать его незачем`);
});

test('М.Видео: на обычном 400 перебор видов тела по-прежнему работает', async () => {
  const { мвОбход } = await import('../src/mvideo.js');
  let вызовов = 0;
  const вызов = async (путь, тело) => {
    вызовов += 1;
    if ('cursor' in тело) throw new Error('М.Видео: HTTP 400 Некорректный запрос');
    return { orders: [{ merchant_order_id: '1' }] };
  };
  const итог = await мвОбход('/v1/order/fbo/list-проба-2', 'orders', {}, вызов);
  assert.equal(итог.length, 1);
  assert.equal(вызовов, 2, 'первый вид — 400, второй прошёл');
});

test('М.Видео: FBO-остатки собираются со складами площадки по именам', async () => {
  const { мвОстаткиFboСтроки } = await import('../src/mvideo.js');
  const вызов = async (путь) => {
    if (путь === '/v1/product/stock/info') {
      return { stocks: [
        { offer_id: 'СВОЙ', location_id: 'wh-1', count: 5 },
        { offer_id: '0042', market_location_id: 'koledino', count: 7 },
        { offer_id: 'Б', market_location_id: 'tula', count: 2 },
      ] };
    }
    if (путь === '/v1/market/location/list') {
      return { locations: [{ market_location_id: 'koledino', name: 'Коледино' }] };
    }
    throw new Error(`неожиданный путь ${путь}`);
  };
  const { строки, складов, безИмени } = await мвОстаткиFboСтроки(вызов);
  assert.equal(строки.length, 2, 'строка со своего склада в FBO попасть не должна');
  assert.equal(складов, 2);
  assert.equal(строки[0][0], "'0042", 'артикул с ведущим нулём — текстом');
  assert.equal(строки[0][1], 'Коледино');
  assert.equal(строки[0][2], 7);
  assert.equal(строки[1][1], 'tula', 'склад без имени — идентификатором, а не прочерком');
  assert.equal(безИмени, 1);
});

test('М.Видео: нет строк на складе площадки — ошибка с объяснением, лист не трогаем', async () => {
  const { мвОстаткиFboСтроки } = await import('../src/mvideo.js');
  const вызов = async (путь) => (путь === '/v1/product/stock/info'
    ? { stocks: [{ offer_id: 'СВОЙ', location_id: 'wh-1', count: 5 }] }
    : { locations: [] });
  await assert.rejects(мвОстаткиFboСтроки(вызов), (е) => {
    assert.match(е.message, /ненулевых остатков на складах площадки нет/);
    assert.match(е.message, /пришло 1: нулевых 0, на складе площадки 0, на своём складе 1, без склада 0/);
    assert.match(е.message, /Лист не перезаписан/);
    return true;
  });
});

test('М.Видео: сбой справочника складов площадки на 500 не прячется', async () => {
  const { мвОстаткиFboСтроки } = await import('../src/mvideo.js');
  const вызов = async (путь) => {
    if (путь === '/v1/product/stock/info') {
      return { stocks: [{ offer_id: 'А', market_location_id: 'koledino', count: 1 }] };
    }
    throw new Error('М.Видео /v1/market/location/list: HTTP 500 внутренняя ошибка');
  };
  // 404 или «не подключено» — пережить можно (снимок, имя вернётся следующим прогоном);
  // 500 — нет: это не «метода нет», а сбой, и молчать о нём нельзя
  await assert.rejects(мвОстаткиFboСтроки(вызов), /HTTP 500/);
});

// ─────────────────── Ламода: карточки заказов ───────────────────

const ошибка404 = (путь) => new Error(`Lamoda ${путь}: HTTP 404 {"error":{"code":"NOT_FOUND","message":"Not Found"}}`);

test('Ламода: 404 на карточке одного заказа не роняет выгрузку остальных', async () => {
  const { карточкиЗаказов } = await import('../src/lamoda.js');
  const получить = async (путь) => {
    if (путь.includes('RU261105-215938')) throw ошибка404(путь);
    return { orderId: путь.split('/').pop(), items: [] };
  };
  const { полные, ненайдены } = await карточкиЗаказов(
    [{ orderId: 'RU261101-000001' }, { orderId: 'RU261105-215938' }], получить, 0);
  assert.equal(полные.length, 1, 'карточка найденного заказа должна прийти');
  assert.deepEqual(ненайдены, ['RU261105-215938'], 'ненайденный заказ надо назвать, а не потерять молча');
});

test('Ламода: на 404 пробуется второй номер заказа из шапки', async () => {
  const { карточкиЗаказов } = await import('../src/lamoda.js');
  const спрошено = [];
  const получить = async (путь) => {
    спрошено.push(путь);
    if (путь.endsWith('/RU261105-215938')) throw ошибка404(путь);
    return { items: [] };
  };
  const { полные, ненайдены } = await карточкиЗаказов(
    [{ orderId: 'RU261105-215938', id: '987654' }], получить, 0);
  assert.equal(полные.length, 1);
  assert.deepEqual(ненайдены, []);
  assert.deepEqual(спрошено, ['/v2/orders/RU261105-215938', '/v2/orders/987654']);
});

test('Ламода: ни одной карточки — системная ошибка с перечнем полей шапки', async () => {
  const { карточкиЗаказов } = await import('../src/lamoda.js');
  const получить = async (путь) => { throw ошибка404(путь); };
  await assert.rejects(
    карточкиЗаказов([{ orderId: 'А', orderNr: 'Б', status: 'new' }, { orderId: 'В' }], получить, 0),
    (е) => {
      assert.match(е.message, /ни у одного из 2 заказов/);
      assert.match(е.message, /Поля заказа в списке: orderId, orderNr, status/);
      return true;
    },
  );
});

test('Ламода: не-404 на карточке по-прежнему роняет выгрузку', async () => {
  const { карточкиЗаказов } = await import('../src/lamoda.js');
  const получить = async () => { throw new Error('Lamoda /v2/orders/А: HTTP 500 сбой'); };
  await assert.rejects(карточкиЗаказов([{ orderId: 'А' }], получить, 0), /HTTP 500/);
});

// ─────────────────── М.Видео: видно, откуда пришли данные ───────────────────

test('М.Видео: запасной адрес виден в «Результате», основной — нет', async () => {
  const { пометкаАдреса } = await import('../src/mvideo.js');
  const адреса = ['https://omni-net.sellers.mvideo.ru', 'https://api.omniom.ru'];
  assert.equal(пометкаАдреса(0, адреса), '');
  assert.equal(пометкаАдреса(1, адреса), ', ЧЕРЕЗ ЗАПАСНОЙ АДРЕС api.omniom.ru');
});

test('М.Видео: без FBO-строк — разбивка ответа и имена полей, а не «со своего склада 0»', async () => {
  const { мвОстаткиFboСтроки } = await import('../src/mvideo.js');
  // ровно случай из книги: сорок строк, ни одна не узнана. Здесь — потому что
  // количество зовётся иначе: код его не видит и считает строку нулевой
  const stocks = Array.from({ length: 40 }, (_, i) => ({ offer_id: `A${i}`, quantity: 5, warehouse_id: 'w' }));
  const вызов = async (путь) => (путь === '/v1/product/stock/info' ? { stocks } : { locations: [] });
  await assert.rejects(мвОстаткиFboСтроки(вызов), (е) => {
    assert.match(е.message, /пришло 40: нулевых 40/);
    assert.match(е.message, /без склада 40/);
    assert.match(е.message, /поля строки: offer_id, quantity, warehouse_id/);
    assert.doesNotMatch(е.message, /со своего склада 0/, 'прежний текст вводил в заблуждение');
    return true;
  });
});

test('М.Видео: ошибка запроса называет адрес, с которого пришла', async () => {
  // «404» шлюза М.Видео и «404» запасного api.omniom.ru неотличимы по тексту,
  // а значат совершенно разное: «метода нет у М.Видео» против «ходим не туда»
  const http = await import('node:http');
  const сервер = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error_type":"ERROR_TYPE_UNSPECIFIED","message":"not found"}');
    });
  });
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  const адрес = `http://127.0.0.1:${сервер.address().port}`;
  const было = { url: process.env.MVIDEO_API_URL, ключ: process.env.MVIDEO_API_KEY };
  process.env.MVIDEO_API_URL = адрес;
  process.env.MVIDEO_API_KEY = 'test-key';
  try {
    const м = await import(`../src/mvideo.js?адрес=${Math.random()}`);
    await assert.rejects(м.мвОбход('/v1/order/fbo/list', 'orders'), (е) => {
      assert.match(е.message, /HTTP 404/);
      assert.ok(е.message.includes(`[127.0.0.1:${сервер.address().port}]`),
        `в ошибке нет адреса: ${е.message}`);
      return true;
    });
  } finally {
    сервер.close();
    if (было.url === undefined) delete process.env.MVIDEO_API_URL; else process.env.MVIDEO_API_URL = было.url;
    if (было.ключ === undefined) delete process.env.MVIDEO_API_KEY; else process.env.MVIDEO_API_KEY = было.ключ;
  }
});

/* ── Схема ключа М.Видео: api-key, а на 401/404 — Bearer (omni-net.dev/spec/fbo/common/auth) ──
 * Главное правило: вторая попытка меняет исход, только если она прошла.
 * Каждая проба берёт свой экземпляр модуля: выбранная схема живёт до конца
 * процесса, и проба, переключившая её, не должна влиять на другие. */
const свежийМв = (метка) => import(`../src/mvideo.js?схема=${метка}`);
const МВИДЕО = 'https://omni-net.sellers.mvideo.ru';
const числоHTTP = (е) => (е.message.match(/HTTP \d{3}/g) || []).length;

/** Поддельный `запрос()`: отвечает по схеме ключа, записывает, каким способом звали. */
function поддельныйЗапрос(ответы) {
  const звали = [];
  const звать = async (url, опции, { имя }) => {
    const з = опции.headers;
    const сх = з.Authorization && з['api-key'] ? 'оба' : (з.Authorization ? 'Bearer' : 'api-key');
    const путь = url.replace(/^https?:\/\/[^/]+/, '');
    звали.push(`${путь} ${сх}`);
    const ответ = ответы(путь, сх);
    if (ответ === 'сеть') throw new Error(`${имя}: fetch failed`);
    if (ответ === 'не JSON') throw new Error(`${имя}: ответ не JSON: <html>`);
    if (typeof ответ === 'number') {
      throw new Error(`${имя}: HTTP ${ответ} {"message":"ответ ${ответ} на ${сх}"}`);
    }
    return ответ;
  };
  return { звать, звали };
}

test('М.Видео: 401 на api-key — Bearer, и только для этого метода; новые методы — снова с api-key', async () => {
  const м = await свежийМв('401');
  const { звать, звали } = поддельныйЗапрос((путь, сх) => (
    путь === '/v1/a' && сх === 'api-key' ? 401 : { ok: сх }));
  assert.deepEqual(await м.сКлючом(МВИДЕО, '/v1/a', {}, 'k', звать), { ok: 'Bearer' });
  await м.сКлючом(МВИДЕО, '/v1/a', {}, 'k', звать);
  await м.сКлючом(МВИДЕО, '/v1/b', {}, 'k', звать);
  // общей схемы нет: один 401 не переводит на Bearer методы, ни разу на нём не ответившие
  assert.deepEqual(звали, ['/v1/a api-key', '/v1/a Bearer', '/v1/a Bearer', '/v1/b api-key']);
  assert.equal(м.пометкаСхемы('/v1/a'), ', ключ в Authorization: Bearer');
  assert.equal(м.пометкаСхемы('/v1/b'), '');
  assert.equal(м.пометкаСхемы('/v1/ни-разу'), '');
});

test('М.Видео: 404 на api-key, а с Bearer метод есть — Bearer только для этого метода', async () => {
  const м = await свежийМв('404-один');
  const { звать, звали } = поддельныйЗапрос((путь, сх) => (
    путь === '/v1/order/fbo/list' && сх === 'api-key' ? 404 : { ok: `${путь} ${сх}` }));
  assert.deepEqual(await м.сКлючом(МВИДЕО, '/v1/order/fbo/list', {}, 'k', звать),
    { ok: '/v1/order/fbo/list Bearer' });
  await м.сКлючом(МВИДЕО, '/v1/order/fbo/list', {}, 'k', звать);
  await м.сКлючом(МВИДЕО, '/v1/order/fbs/list', {}, 'k', звать);
  assert.deepEqual(звали, ['/v1/order/fbo/list api-key', '/v1/order/fbo/list Bearer',
    '/v1/order/fbo/list Bearer', '/v1/order/fbs/list api-key']);
  assert.equal(м.пометкаСхемы('/v1/order/fbo/list'), ', ключ в Authorization: Bearer');
  assert.equal(м.пометкаСхемы('/v1/order/fbs/list'), '');
});

test('М.Видео: Bearer не прошёл ничем — решает api-key, и следующий запрос снова с api-key', async () => {
  // главное: если Bearer не прошёл, а api-key не получил 401, всё как до правки.
  // Иначе «DBS не подключён» (404, его терпят) превращается в падение задачи FBS
  for (const [ответBearer, статус] of [[404, 404], [401, 401], [400, 400], [403, 403],
    [429, 429], [500, 500], ['сеть', 0], ['не JSON', 0]]) {
    const м = await свежийМв(`провал-${ответBearer}`);
    const { звать, звали } = поддельныйЗапрос((путь, сх) => (сх === 'api-key' ? 404 : ответBearer));
    for (let прогон = 0; прогон < 2; прогон += 1) {
      await assert.rejects(м.сКлючом(МВИДЕО, '/v1/order/dbs/list', {}, 'k', звать), (е) => {
        assert.equal(м.статусОшибки(е), 404, `Bearer ${ответBearer}: решать должен ответ api-key`);
        assert.equal(числоHTTP(е), 1, `Bearer ${ответBearer}: «HTTP» второй схемы попал в текст`);
        assert.match(е.message, /\(ключ в api-key\); в Authorization: Bearer — /);
        assert.deepEqual(е.статусы, [404, статус]);
        return true;
      });
    }
    assert.deepEqual(звали, ['/v1/order/dbs/list api-key', '/v1/order/dbs/list Bearer',
      '/v1/order/dbs/list api-key', '/v1/order/dbs/list Bearer'], `Bearer ${ответBearer}`);
    assert.equal(м.пометкаСхемы('/v1/order/dbs/list'), '', `Bearer ${ответBearer}: пометка без успеха`);
  }
});

test('М.Видео: проба второй схемы — одна попытка, без повторов', async () => {
  const м = await свежийМв('одна-попытка');
  const попыток = [];
  const звать = async (url, опции, { имя, попыток: n }) => {
    попыток.push(n);
    throw new Error(`${имя}: HTTP ${опции.headers.Authorization ? 503 : 404} {}`);
  };
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/g', {}, 'k', звать, 5));
  assert.deepEqual(попыток, [5, 1]);
});

test('М.Видео: повторы второй схемы — одна у пробы, обычные, если её ответ решает', async () => {
  // после 404 и OPERATION_NOT_SUPPORTED проба Bearer ничего не решает — одна
  // попытка; после 401 решает ответ Bearer — обычные повторы: иначе в мире
  // Bearer разовый сбой связи после перезапуска уводил на запасной адрес
  for (const [ответКлюч, попыток, ждём] of [
    [404, 5, [5, 1]], [[400, 'OPERATION_NOT_SUPPORTED'], 5, [5, 1]], [401, 5, [5, 5]], [401, 2, [2, 2]]]) {
    const м = await свежийМв(`повторы-${ответКлюч}-${попыток}`);
    const было = [];
    const звать = async (url, опции, { имя, попыток: n }) => {
      было.push(n);
      if (опции.headers.Authorization) throw new Error(`${имя}: HTTP 503 {}`);
      const [код, тело] = Array.isArray(ответКлюч) ? ответКлюч : [ответКлюч, ''];
      throw new Error(`${имя}: HTTP ${код} {"code":"${тело}"}`);
    };
    await assert.rejects(м.сКлючом(МВИДЕО, '/v1/g', {}, 'k', звать, попыток));
    assert.deepEqual(было, ждём, `api-key ${ответКлюч}, попыток ${попыток}`);
  }
});

test('М.Видео: OPERATION_NOT_SUPPORTED на api-key — пробуется Bearer; «не подключено» решает api-key', async () => {
  const м = await свежийМв('ons-проба');
  const { звать, звали } = поддельныйЗапрос((путь, сх) => {
    if (сх === 'api-key') throw new Error(`М.Видео ${путь}: HTTP 400 {"code":"OPERATION_NOT_SUPPORTED"}`);
    return путь === '/v1/есть' ? { ok: сх } : 401;
  });
  assert.deepEqual(await м.сКлючом(МВИДЕО, '/v1/есть', {}, 'k', звать), { ok: 'Bearer' });
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/нет', {}, 'k', звать), (е) => {
    assert.equal(м.статусОшибки(е), 400);
    assert.ok(м.неПодключено(е), е.message);
    assert.deepEqual(е.статусы, [400, 401]);
    return true;
  });
  assert.deepEqual(звали, ['/v1/есть api-key', '/v1/есть Bearer', '/v1/нет api-key', '/v1/нет Bearer']);
});

test('М.Видео: справка о второй схеме не включает решения — ни перебор тела, ни «не подключено»', async () => {
  const м = await свежийМв('справка');
  const { звать } = поддельныйЗапрос((путь, сх) => {
    if (сх === 'api-key') return 404;
    throw new Error(`М.Видео ${путь}: HTTP 400 {"code":"OPERATION_NOT_SUPPORTED"}`);
  });
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/order/fbo/list', {}, 'k', звать), (е) => {
    assert.equal(м.статусОшибки(е), 404);
    assert.ok(!/HTTP 400/.test(е.message), е.message);
    assert.ok(!м.неПодключено(е), `OPERATION_NOT_SUPPORTED из справки включил «не подключено»: ${е.message}`);
    assert.match(е.message, /в Authorization: Bearer — 400 \{"code":"OPERATION NOT SUPPORTED"\}/);
    return true;
  });
});

test('М.Видео: обе не прошли — Bearer решает, только если api-key отвергнут (401), а Bearer нет', async () => {
  const код = (ответ) => (typeof ответ === 'number' ? ответ : 0);
  for (const [ответКлюч, ответBearer, кто] of [
    [401, 404, 'Bearer'], [401, 400, 'Bearer'], [401, 'сеть', 'Bearer'], [401, 401, 'api-key'],
    [404, 401, 'api-key'], [404, 403, 'api-key']]) {
    const м = await свежийМв(`решает-${ответКлюч}-${ответBearer}`);
    const { звать } = поддельныйЗапрос((путь, сх) => (сх === 'api-key' ? ответКлюч : ответBearer));
    await assert.rejects(м.сКлючом(МВИДЕО, '/v1/h', {}, 'k', звать), (е) => {
      const имя = `api-key ${ответКлюч}, Bearer ${ответBearer}`;
      const решил = кто === 'api-key' ? ответКлюч : ответBearer;
      assert.equal(м.статусОшибки(е), код(решил), имя);
      assert.deepEqual(е.статусы, [код(ответКлюч), код(ответBearer)], имя);
      assert.equal(числоHTTP(е), код(решил) ? 1 : 0, имя);
      const [первый, второй] = кто === 'api-key'
        ? ['api-key', 'Authorization: Bearer'] : ['Authorization: Bearer', 'api-key'];
      assert.ok(е.message.includes(`(ключ в ${первый}); в ${второй} — `), `${имя}: ${е.message}`);
      return true;
    });
  }
});

test('М.Видео: запомненный Bearer не прошёл ничем — пробуется api-key и, если прошёл, запоминается', async () => {
  for (const ответBearer of [400, 403, 503, 'сеть', 404, 401]) {
    const м = await свежийМв(`назад-${ответBearer}`);
    let этап = 'bearer';                                   // сначала метод отвечает только на Bearer
    const { звать, звали } = поддельныйЗапрос((путь, сх) => {
      if (этап === 'bearer') return сх === 'api-key' ? 401 : { ok: сх };
      return сх === 'api-key' ? { ok: сх } : ответBearer;   // шлюз вернулся к api-key
    });
    await м.сКлючом(МВИДЕО, '/v1/i', {}, 'k', звать);
    этап = 'api-key';
    assert.deepEqual(await м.сКлючом(МВИДЕО, '/v1/i', {}, 'k', звать), { ok: 'api-key' }, `Bearer ${ответBearer}`);
    await м.сКлючом(МВИДЕО, '/v1/i', {}, 'k', звать);
    assert.deepEqual(звали.slice(2), ['/v1/i Bearer', '/v1/i api-key', '/v1/i api-key'], `Bearer ${ответBearer}`);
    assert.equal(м.пометкаСхемы('/v1/i'), '');
  }
  // запомненный Bearer и api-key оба не прошли — статусы по схемам, а не по порядку попыток
  const м = await свежийМв('назад-оба');
  let раз = 0;
  const { звать } = поддельныйЗапрос((путь, сх) => {
    раз += 1;
    if (раз <= 2) return сх === 'api-key' ? 401 : { ok: сх };
    return сх === 'api-key' ? 401 : 404;
  });
  await м.сКлючом(МВИДЕО, '/v1/j', {}, 'k', звать);
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/j', {}, 'k', звать), (е) => {
    assert.deepEqual(е.статусы, [401, 404]);
    assert.equal(м.статусОшибки(е), 404);
    assert.match(е.message, /HTTP 404 .*\(ключ в Authorization: Bearer\); в api-key — 401 /);
    return true;
  });
});

test('М.Видео: запомненный Bearer и api-key оба не прошли, у api-key не 401 — решает api-key', async () => {
  // DBS ходил через Bearer, потом отключён: ответ api-key (404, его терпят)
  // должен решать и здесь, иначе задачи FBS снова падают на ответе Bearer
  const код = (ответ) => (typeof ответ === 'number' ? ответ : 0);
  for (const ответBearer of [400, 403, 404, 503, 'сеть']) {
    for (const ответКлюч of [404, 400, 500, 'сеть']) {
      const м = await свежийМв(`память-${ответBearer}-${ответКлюч}`);
      let этап = 'bearer';
      const { звать, звали } = поддельныйЗапрос((путь, сх) => {
        if (этап === 'bearer') return сх === 'api-key' ? 401 : { ok: сх };
        return сх === 'api-key' ? ответКлюч : ответBearer;
      });
      await м.сКлючом(МВИДЕО, '/v1/m', {}, 'k', звать);
      этап = 'оба';
      const имя = `Bearer ${ответBearer}, api-key ${ответКлюч}`;
      await assert.rejects(м.сКлючом(МВИДЕО, '/v1/m', {}, 'k', звать), (е) => {
        assert.equal(м.статусОшибки(е), код(ответКлюч), имя);
        assert.ok(е.message.includes('(ключ в api-key); в Authorization: Bearer — '), `${имя}: ${е.message}`);
        assert.deepEqual(е.статусы, [код(ответКлюч), код(ответBearer)], имя);
        return true;
      });
      assert.deepEqual(звали.slice(2), ['/v1/m Bearer', '/v1/m api-key'], имя);
    }
  }
});

test('М.Видео: возврат с запомненного Bearer к api-key — с обычными повторами, как до правки', async () => {
  // находка третьей проверки: возврат получал одну попытку, и разовый 500
  // ронял прогон, который прежний код пережил бы повтором
  const м = await свежийМв('возврат-повторы');
  const попытки = [];
  let этап = 'bearer';
  const звать = async (url, опции, { имя, попыток: n }) => {
    const сх = опции.headers.Authorization ? 'Bearer' : 'api-key';
    попытки.push(`${сх} ${n}`);
    if (этап === 'bearer') {
      if (сх === 'api-key') throw new Error(`${имя}: HTTP 401 {}`);
      return { ok: сх };
    }
    if (сх === 'Bearer') throw new Error(`${имя}: HTTP 401 {}`);
    if (n < 2) throw new Error(`${имя}: HTTP 500 {}`);     // как запрос(): разовый 500 лечит повтор
    return { ok: сх };
  };
  await м.сКлючом(МВИДЕО, '/v1/n', {}, 'k', звать, 5);
  этап = 'api-key';
  assert.deepEqual(await м.сКлючом(МВИДЕО, '/v1/n', {}, 'k', звать, 5), { ok: 'api-key' });
  assert.deepEqual(попытки, ['api-key 5', 'Bearer 5', 'Bearer 5', 'api-key 5']);
});

test('М.Видео: справка о второй схеме — ответ целиком, но не длиннее 200 знаков', async () => {
  const м = await свежийМв('справка-длина');
  const тело = `{"message":"${'я'.repeat(150)}КОНЕЦ"}`;
  assert.ok(м.справкой(new Error(`М.Видео /v1/x: HTTP 404 ${тело}`)).endsWith('КОНЕЦ"}'));
  assert.equal(м.справкой(new Error(`М.Видео /v1/x: HTTP 404 ${'я'.repeat(1000)}`)).length, 200);
});

test('М.Видео: 400, 429, 500, сеть на api-key — без второй попытки и без памяти', async () => {
  const м = await свежийМв('прочие');
  for (const ответ of [400, 429, 500, 'сеть']) {
    const путь = `/v1/код-${ответ}`;
    const { звать, звали } = поддельныйЗапрос(() => ответ);
    await assert.rejects(м.сКлючом(МВИДЕО, путь, {}, 'k', звать), (е) => {
      assert.ok(!е.message.includes('ключ в'), `пометка схемы без второй попытки: ${е.message}`);
      return true;
    });
    assert.deepEqual(звали, [`${путь} api-key`], `на ${ответ} была вторая попытка`);
    assert.equal(м.пометкаСхемы(путь), '');
  }
  // слово OPERATION_NOT_SUPPORTED в теле пятисотки — сбой, а не «не подключено»:
  // второй попытки нет и здесь
  const было = [];
  const пятисотка = async (url, опции, { имя }) => {
    было.push(опции.headers.Authorization ? 'Bearer' : 'api-key');
    throw new Error(`${имя}: HTTP 500 {"message":"upstream OPERATION_NOT_SUPPORTED"}`);
  };
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/код-500-ons', {}, 'k', пятисотка), /HTTP 500/);
  assert.deepEqual(было, ['api-key']);
  // и не на 400: «не подключено» по стандарту — только 400 OPERATION_NOT_SUPPORTED
  for (const текст of ['HTTP 422 {"code":"OPERATION_NOT_SUPPORTED"}', 'ответ не JSON: OPERATION_NOT_SUPPORTED']) {
    const звали = [];
    const звать = async (url, опции, { имя }) => {
      звали.push(опции.headers.Authorization ? 'Bearer' : 'api-key');
      throw new Error(`${имя}: ${текст}`);
    };
    await assert.rejects(м.сКлючом(МВИДЕО, `/v1/не-400-${звали.length}${текст.length}`, {}, 'k', звать));
    assert.deepEqual(звали, ['api-key'], текст);
  }
});

test('М.Видео: решения читают решающий ответ, а не справку о второй схеме', async () => {
  const м = await свежийМв('решающий-текст');
  const { звать } = поддельныйЗапрос((путь, сх) => {
    if (сх === 'api-key') throw new Error(`М.Видео ${путь}: HTTP 400 {"code":"OPERATION_NOT_SUPPORTED"}`);
    return 'сеть';
  });
  await assert.rejects(м.сКлючом(МВИДЕО, '/v1/р', {}, 'k', звать), (е) => {
    assert.match(е.message, /\(ключ в api-key\); в Authorization: Bearer — fetch failed$/);
    assert.equal(м.решающийТекст(е), 'М.Видео /v1/р: HTTP 400 {"code":"OPERATION_NOT_SUPPORTED"}');
    assert.equal(м.статусОшибки(е), 400);
    assert.ok(м.неПодключено(е));
    return true;
  });
  assert.equal(м.решающийТекст(new Error('просто текст')), 'просто текст');
});

test('М.Видео: на omniom ключ обоими заголовками, второй попытки и памяти нет', async () => {
  const м = await свежийМв('omniom');
  const { звать, звали } = поддельныйЗапрос(() => 401);
  await assert.rejects(м.сКлючом('https://api.omniom.ru', '/v1/f', {}, 'k', звать), /HTTP 401/);
  assert.deepEqual(звали, ['/v1/f оба']);
  // повторы — те, что задал вызывающий, как до правки
  const попытки = [];
  const считать = async (url, опции, { попыток: n }) => { попытки.push(n); return {}; };
  await м.сКлючом('https://api.omniom.ru', '/v1/f', {}, 'k', считать, 5);
  await м.сКлючом('https://api.omniom.ru', '/v1/f', {}, 'k', считать, 2);
  assert.deepEqual(попытки, [5, 2]);
});

test('М.Видео: ошибка заказов FBO — «метода нет» только при 404 на обеих схемах', async () => {
  const м = await свежийМв('fbo-ошибка');
  const хост = 'omni-net.sellers.mvideo.ru';
  const ошибка = (статусы, текст = 'М.Видео /v1/order/fbo/list: HTTP 404 {"x":1} (ключ в api-key); '
    + 'в Authorization: Bearer — 404 {"y":2}') => Object.assign(new Error(текст), { статусы });
  const нет = м.ошибкаЗаказовFbo(ошибка([404, 404]), хост).message;
  assert.match(нет, /нет метода \/v1\/order\/fbo\/list ни с одной схемой ключа \(api-key — 404, Authorization: Bearer — 404\)/);
  assert.match(нет, /\{"x":1\}.*\{"y":2\}/);                // ответ шлюза не выбрасывается
  for (const [статусы, слова] of [[[404, 401], 'api-key — 404, Authorization: Bearer — 401'],
    [[401, 404], 'api-key — 401, Authorization: Bearer — 404'],
    [[401, 401], 'api-key — 401, Authorization: Bearer — 401'],
    [[404, 400], 'api-key — 404, Authorization: Bearer — 400'],
    [[404, 0], 'api-key — 404, Authorization: Bearer — без HTTP-ответа']]) {
    const т = м.ошибкаЗаказовFbo(ошибка(статусы), хост).message;
    assert.ok(!т.includes('нет метода'), `${статусы}: это не «метода нет»: ${т}`);
    assert.ok(т.startsWith(`М.Видео: /v1/order/fbo/list на шлюзе ${хост} не отдал заказы ни с одной `
      + `схемой ключа: ${слова}`), т);
    assert.match(т, /\{"x":1\}.*\{"y":2\}/, `${статусы}: ответ шлюза выброшен`);
  }
  const неПодкл = new Error('М.Видео /v1/order/fbo/list: HTTP 400 {"code":"OPERATION_NOT_SUPPORTED"}');
  assert.match(м.ошибкаЗаказовFbo(неПодкл, хост).message,
    /FBO для этого кабинета не подключён .*Ответ шлюза: .*OPERATION_NOT_SUPPORTED/);
  const omniom = new Error('М.Видео /v1/order/fbo/list: HTTP 404 {"z":3}');
  assert.match(м.ошибкаЗаказовFbo(omniom, 'api.omniom.ru').message, /нет метода .*\(HTTP 404\).*\{"z":3\}/);
  const прочая = new Error('М.Видео /v1/order/fbo/list: HTTP 500 {}');
  assert.equal(м.ошибкаЗаказовFbo(прочая, хост), прочая);
});

/* ── Задачи М.Видео целиком: поддельный шлюз (fetch) и поддельная книга ── */

/** Подменяет fetch: ответ по пути и схеме ключа; записывает, кого и как звали. */
function поддельныйШлюз(ответить) {
  const звали = [];
  const было = globalThis.fetch;
  globalThis.fetch = async (url, опции) => {
    const u = new URL(url);
    const з = опции.headers;
    const сх = з.Authorization && з['api-key'] ? 'оба' : (з.Authorization ? 'Bearer' : 'api-key');
    звали.push(`${u.host}${u.pathname} ${сх}`);
    const [статус, тело] = ответить(u.pathname, сх, u.host);
    return new Response(JSON.stringify(тело ?? { message: `ответ ${статус} на ${сх}` }),
      { status: статус, headers: { 'content-type': 'application/json' } });
  };
  return { звали, вернуть: () => { globalThis.fetch = было; } };
}

/** Окружение задачи: адрес шлюза, ключ, книга; после — всё как было. */
async function вОкружении(адрес, тело) {
  const было = { url: process.env.MVIDEO_API_URL, ключ: process.env.MVIDEO_API_KEY };
  if (адрес) process.env.MVIDEO_API_URL = адрес; else delete process.env.MVIDEO_API_URL;
  process.env.MVIDEO_API_KEY = 'test-key';
  try {
    return await тело();
  } finally {
    if (было.url === undefined) delete process.env.MVIDEO_API_URL; else process.env.MVIDEO_API_URL = было.url;
    if (было.ключ === undefined) delete process.env.MVIDEO_API_KEY; else process.env.MVIDEO_API_KEY = было.ключ;
  }
}

const заказМв = (номер, артикул) => ({ merchant_order_id: номер, created_at: '2026-11-05T10:00:00+03:00',
  offer_id: артикул, prices: [{ price_type: 'CUSTOMER_PRICE', value: 150000 }], status: 'NEW' });
const список = (поле, строки) => [200, { [поле]: строки, next_cursor: '' }];
const ЗАДАЧА = { глубина: 7 };

test('М.Видео, задача: DBS не подключён и Bearer отвечает 400/403 — FBS пишется, а DBS подхватится сам', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    let dbsПодключён = false;
    let ответBearer = 400;
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      if (путь === '/v1/order/dbs/list') {
        if (dbsПодключён && сх === 'api-key') return список('orders', [заказМв('D1', 'A2')]);
        return [сх === 'api-key' ? 404 : ответBearer];
      }
      return [500];
    });
    try {
      const { книга } = поддельнаяКнига({});
      const м = await свежийМв('задача-dbs');
      const первый = await м.мвЗаказыFbs(ЗАДАЧА);
      assert.match(первый, /заказов FBS 1, DBS 0, DBS недоступен/);
      assert.ok(!первый.includes('ключ в'), первый);
      assert.ok((книга.get('Заказы Мвидео FBS') || []).some((р) => String(р[0]).includes('F1')));
      ответBearer = 403;
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /DBS 0, DBS недоступен/);
      // DBS подключили — следующий прогон берёт его с api-key, без перезапуска
      dbsПодключён = true;
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 1,/);
      assert.ok((книга.get('Заказы Мвидео FBS') || []).some((р) => String(р[0]).includes('D1')));
      const dbs = шлюз.звали.filter((з) => з.includes('/v1/order/dbs/list'));
      assert.deepEqual(dbs.map((з) => з.split(' ')[1]), ['api-key', 'Bearer', 'api-key', 'Bearer', 'api-key']);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задача: заказы FBO — текст ошибки по ответу каждой схемы, а с Bearer — данные и пометка', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    let ответBearer = [404];
    const шлюз = поддельныйШлюз((путь, сх) => (сх === 'api-key' ? [404] : ответBearer));
    try {
      const { книга } = поддельнаяКнига({});
      await assert.rejects((await свежийМв('fbo-404')).мвЗаказыFbo(ЗАДАЧА),
        /нет метода \/v1\/order\/fbo\/list ни с одной схемой ключа \(api-key — 404, Authorization: Bearer — 404\)/);
      ответBearer = [401];
      await assert.rejects((await свежийМв('fbo-401')).мвЗаказыFbo(ЗАДАЧА), (е) => {
        assert.match(е.message, /^М\.Видео: \/v1\/order\/fbo\/list на шлюзе https:\/\/omni-net\.sellers\.mvideo\.ru не отдал заказы ни с одной схемой ключа: api-key — 404, Authorization: Bearer — 401/);
        assert.ok(!е.message.includes('нет метода'));
        return true;
      });
      ответBearer = список('orders', [заказМв('B1', 'A9')]);
      const итог = await (await свежийМв('fbo-ok')).мвЗаказыFbo(ЗАДАЧА);
      assert.match(итог, /^заказов FBO 1, .*, ключ в Authorization: Bearer$/);
      assert.ok((книга.get('Заказы Мвидео FBO') || []).some((р) => String(р[0]).includes('B1')));
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: шлюз перешёл на Bearer — данные идут, и «Результат» каждой задачи это говорит', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (сх === 'api-key') return [401];
      if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
      if (путь === '/v1/market/location/list') {
        return список('locations', [{ market_location_id: 'M1', name: 'Склад площадки' }]);
      }
      if (путь === '/v1/product/stock/info') {
        return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 },
          { offer_id: 'A2', market_location_id: 'M1', count: 2, available_count: 2 }]);
      }
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      if (путь === '/v1/order/fbo/list') return список('orders', [заказМв('B1', 'A2')]);
      return [404];                                          // DBS не подключён
    });
    try {
      const { книга } = поддельнаяКнига({});
      const м = await свежийМв('всё-на-bearer');
      const пометка = /, ключ в Authorization: Bearer$/;
      assert.match(await м.мвОстаткиFbs(), /^складов 1, строк 1, ключ в Authorization: Bearer$/);
      assert.match(await м.мвОстаткиFbo(), пометка);
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /DBS недоступен.*, ключ в Authorization: Bearer$/);
      assert.match(await м.мвЗаказыFbo(ЗАДАЧА), пометка);
      assert.ok((книга.get('FBS остатки Мвидео') || []).some((р) => String(р[0]).includes('A1')));
      assert.ok((книга.get('FBO остатки Мвидео') || []).some((р) => String(р[0]).includes('A2')));
      assert.ok((книга.get('Заказы Мвидео FBS') || []).some((р) => String(р[0]).includes('F1')));
      // второй прогон: методы, отдавшие данные с Bearer, идут сразу с ним; api-key
      // пробуют только те, что ни разу не ответили (DBS) — общей схемы нет
      const до = шлюз.звали.length;
      await м.мвОстаткиFbs();
      await м.мвЗаказыFbs(ЗАДАЧА);
      assert.deepEqual(шлюз.звали.slice(до).filter((з) => з.endsWith('api-key')).map((з) => з.split(' ')[0]), [
        'omni-net.sellers.mvideo.ru/v1/location/list',
        'omni-net.sellers.mvideo.ru/v1/order/dbs/list']);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: разовый 401 на api-key не переводит DBS на Bearer — задачи FBS живут дальше', async () => {
  // находка повторной проверки: прежняя версия держала общую схему, и после
  // одного «api-key 401, Bearer прошёл» DBS шёл с Bearer, а его 400 ронял FBS
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    let сбой = true;
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/dbs/list' || путь === '/v1/location/list') {
        return сх === 'api-key' ? [404] : [400, { code: 'OPERATION_NOT_SUPPORTED' }];
      }
      if (сх === 'api-key' && сбой && путь === '/v1/order/fbs/list') { сбой = false; return [401]; }
      if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
      if (путь === '/v1/product/stock/info') {
        return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 }]);
      }
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('разовый-401');
      for (let прогон = 0; прогон < 3; прогон += 1) {
        assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 0, DBS недоступен/, `прогон ${прогон}`);
        assert.match(await м.мвОстаткиFbs(), /^складов 1, строк 1/, `прогон ${прогон}`);
      }
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: FBO только на Bearer, остальное на api-key — FBS не ломается после FBO', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/fbo/list') return сх === 'api-key' ? [401] : список('orders', [заказМв('B1', 'A2')]);
      if (сх === 'Bearer') return [401];                       // остальное Bearer не принимает
      if (путь === '/v1/order/dbs/list' || путь === '/v1/location/list') return [404];
      if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
      if (путь === '/v1/product/stock/info') {
        return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 }]);
      }
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('fbo-раздельно');
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /DBS недоступен/);
      assert.match(await м.мвЗаказыFbo(ЗАДАЧА), /^заказов FBO 1, .*, ключ в Authorization: Bearer$/);
      const fbs = await м.мвЗаказыFbs(ЗАДАЧА);
      assert.match(fbs, /заказов FBS 1, DBS 0, DBS недоступен/);
      assert.ok(!fbs.includes('ключ в'), fbs);
      assert.match(await м.мвОстаткиFbs(), /^складов 1, строк 1$/);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задача: проба Bearer на 503 — одна попытка, без пауз; DBS по-прежнему терпится', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      if (путь === '/v1/order/dbs/list') return [сх === 'api-key' ? 404 : 503];
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('503');
      const старт = Date.now();
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /DBS недоступен/);
      assert.ok(Date.now() - старт < 1500, `проба с повторами и паузами: ${Date.now() - старт} мс`);
      assert.deepEqual(шлюз.звали.filter((з) => з.includes('dbs')).map((з) => з.split(' ')[1]), ['api-key', 'Bearer']);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задача: заказы FBO первыми после перезапуска не уводят процесс на запасной адрес', async () => {
  // №50: 404 на /v1/order/fbo/list первым запросом процесса раньше уводил все
  // задачи М.Видео на api.omniom.ru до перезапуска воркера
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(undefined, async () => {
    const шлюз = поддельныйШлюз((путь, сх, хост) => {
      if (хост === 'api.omniom.ru') return [401];
      if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
      if (путь === '/v1/order/fbo/list') return [404];
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      if (путь === '/v1/order/dbs/list') return [404];
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('fbo-первыми');
      await assert.rejects(м.мвЗаказыFbo(ЗАДАЧА),
        /М\.Видео: на шлюзе https:\/\/omni-net\.sellers\.mvideo\.ru нет метода \/v1\/order\/fbo\/list ни с одной схемой ключа/);
      const fbs = await м.мвЗаказыFbs(ЗАДАЧА);
      assert.match(fbs, /заказов FBS 1/);
      assert.ok(!fbs.includes('ЗАПАСНОЙ'), fbs);
      assert.ok(!шлюз.звали.some((з) => з.startsWith('api.omniom.ru')), шлюз.звали.join('\n'));
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задача: заказы FBO первыми после перезапуска не зависят от методов FBS', async () => {
  // находка третьей проверки: прежняя починка №50 подтверждала адрес вызовом
  // /v1/merchant/location/list, и его отказ (кабинет без FBS) ронял FBO или
  // уводил процесс на запасной адрес. Теперь адрес решает сам ответ FBO
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  for (const отказ of [[400, { code: 'OPERATION_NOT_SUPPORTED' }], [404], [500]]) {
    await вОкружении(undefined, async () => {
      const шлюз = поддельныйШлюз((путь, сх, хост) => {
        if (хост === 'api.omniom.ru') return [401];
        if (путь === '/v1/merchant/location/list') return отказ;
        if (путь === '/v1/order/fbo/list' && сх === 'api-key') return список('orders', [заказМв('B1', 'A2')]);
        return [404];
      });
      try {
        const { книга } = поддельнаяКнига({});
        const м = await свежийМв(`fbo-без-fbs-${отказ[0]}`);
        const итог = await м.мвЗаказыFbo(ЗАДАЧА);
        assert.match(итог, /^заказов FBO 1, /, `отказ ${отказ[0]}`);
        assert.ok(!итог.includes('ЗАПАСНОЙ'), итог);
        assert.ok((книга.get('Заказы Мвидео FBO') || []).some((р) => String(р[0]).includes('B1')));
        assert.ok(!шлюз.звали.some((з) => з.startsWith('api.omniom.ru')), шлюз.звали.join('\n'));
      } finally {
        шлюз.вернуть();
      }
    });
  }
});

test('М.Видео, задача: 401 на заказах FBO первыми после перезапуска адрес меняет, как раньше', async () => {
  // исключение №50 — только для 404: 401 на обеих схемах — про ключ и адрес, не про метод
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(undefined, async () => {
    const шлюз = поддельныйШлюз((путь, сх, хост) => {
      if (хост === 'api.omniom.ru') return список('orders', [заказМв('O1', 'A2')]);
      return [401];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('fbo-401-адрес');
      assert.match(await м.мвЗаказыFbo(ЗАДАЧА), /^заказов FBO 1, .*, ЧЕРЕЗ ЗАПАСНОЙ АДРЕС api\.omniom\.ru$/);
    } finally {
      шлюз.вернуть();
    }
  });
});

/** Паузы между повторами `запрос()` — без ожидания: проба про исход, а не про время. */
async function безПауз(тело) {
  const было = globalThis.setTimeout;
  globalThis.setTimeout = (ф, мс, ...арг) => было(ф, 0, ...арг);
  try {
    return await тело();
  } finally {
    globalThis.setTimeout = было;
  }
}

test('М.Видео, задача: 404 на заказах FBO первыми после перезапуска не меняет адрес, что бы ни ответил Bearer', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  for (const [ответКлюч, ответBearer] of [[404, 404], [404, 401], [404, 403], [404, 500], [404, 'сеть'], [401, 404]]) {
    await вОкружении(undefined, async () => {
      const шлюз = поддельныйШлюз((путь, сх, хост) => {
        if (хост === 'api.omniom.ru') return [401];
        if (путь === '/v1/order/fbo/list') return [сх === 'api-key' ? ответКлюч : ответBearer];
        if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
        return [404];
      });
      const сеть = globalThis.fetch;
      globalThis.fetch = async (url, опции) => {
        if (ответBearer === 'сеть' && опции.headers.Authorization && !опции.headers['api-key']) {
          throw new TypeError('fetch failed');
        }
        return сеть(url, опции);
      };
      try {
        поддельнаяКнига({});
        const м = await свежийМв(`fbo-адрес-${ответКлюч}-${ответBearer}`);
        await безПауз(() => assert.rejects(м.мвЗаказыFbo(ЗАДАЧА), /omni-net\.sellers\.mvideo\.ru/));
        const fbs = await м.мвЗаказыFbs(ЗАДАЧА);
        assert.ok(!fbs.includes('ЗАПАСНОЙ'), `api-key ${ответКлюч}, Bearer ${ответBearer}: ${fbs}`);
        assert.ok(!шлюз.звали.some((з) => з.startsWith('api.omniom.ru')),
          `api-key ${ответКлюч}, Bearer ${ответBearer}: ${шлюз.звали.join(', ')}`);
      } finally {
        globalThis.fetch = сеть;
        шлюз.вернуть();
      }
    });
  }
});

test('М.Видео, задача: сбой связи на заказах FBO первыми после перезапуска адрес меняет, как раньше', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(undefined, async () => {
    const шлюз = поддельныйШлюз(() => список('orders', [заказМв('O1', 'A2')]));
    const сеть = globalThis.fetch;
    globalThis.fetch = async (url, опции) => {
      if (new URL(url).host !== 'api.omniom.ru') throw new TypeError('fetch failed');
      return сеть(url, опции);
    };
    try {
      поддельнаяКнига({});
      const м = await свежийМв('fbo-сеть-адрес');
      assert.match(await безПауз(() => м.мвЗаказыFbo(ЗАДАЧА)), /, ЧЕРЕЗ ЗАПАСНОЙ АДРЕС api\.omniom\.ru$/);
    } finally {
      globalThis.fetch = сеть;
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: шлюз на Bearer, разовый сбой связи первым запросом после перезапуска — адрес тот же', async () => {
  // после 401 на api-key решает ответ Bearer; с одной попыткой сбой связи на нём
  // уводил процесс на запасной адрес до перезапуска
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(undefined, async () => {
    let сбоев = 1;
    const шлюз = поддельныйШлюз((путь, сх, хост) => {
      if (хост === 'api.omniom.ru' || сх === 'api-key') return [401];
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      return [404];
    });
    const сеть = globalThis.fetch;
    globalThis.fetch = async (url, опции) => {
      if (опции.headers.Authorization && !опции.headers['api-key'] && сбоев > 0) {
        сбоев -= 1;
        throw new TypeError('fetch failed');
      }
      return сеть(url, опции);
    };
    try {
      поддельнаяКнига({});
      const м = await свежийМв('bearer-сбой-связи');
      for (let прогон = 0; прогон < 2; прогон += 1) {
        const итог = await безПауз(() => м.мвЗаказыFbs(ЗАДАЧА));
        assert.match(итог, /заказов FBS 1, .*, ключ в Authorization: Bearer$/, `прогон ${прогон}: ${итог}`);
        assert.ok(!итог.includes('ЗАПАСНОЙ'), итог);
      }
    } finally {
      globalThis.fetch = сеть;
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: OPERATION_NOT_SUPPORTED первым запросом после перезапуска и сбой пробы Bearer — адрес тот же', async () => {
  // находка пятой проверки: справка «в Authorization: Bearer — fetch failed»
  // попадала в выбор адреса, хотя решал 400 api-key, и процесс уходил на omniom
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  const задачи = [
    ['мвЗаказыFbo', '/v1/order/fbo/list', /FBO для этого кабинета не подключён/],
    ['мвОстаткиFbs', '/v1/merchant/location/list', /OPERATION_NOT_SUPPORTED/],
    ['мвТовары', '/v1/product/mapping/list', /OPERATION_NOT_SUPPORTED/],
  ];
  for (const [задача, первый, ждём] of задачи) {
    for (const сбой of ['сеть', 'пятисотка']) {
      await вОкружении(undefined, async () => {
        const шлюз = поддельныйШлюз((путь, сх, хост) => {
          if (хост === 'api.omniom.ru') return список('orders', [заказМв('O1', 'A9')]);
          if (путь === первый) {
            if (сх === 'api-key') return [400, { code: 'OPERATION_NOT_SUPPORTED' }];
            return [502, { message: 'upstream fetch failed' }];
          }
          if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
          return [404];
        });
        const сеть = globalThis.fetch;
        globalThis.fetch = async (url, опции) => {
          if (сбой === 'сеть' && опции.headers.Authorization && !опции.headers['api-key']) {
            throw new TypeError('fetch failed');
          }
          return сеть(url, опции);
        };
        try {
          поддельнаяКнига({});
          const м = await свежийМв(`ons-сбой-${задача}-${сбой}`);
          await безПауз(() => assert.rejects(м[задача](ЗАДАЧА), ждём, `${задача}, ${сбой}`));
          const fbs = await м.мвЗаказыFbs(ЗАДАЧА);
          assert.ok(!fbs.includes('ЗАПАСНОЙ'), `${задача}, ${сбой}: ${fbs}`);
          assert.ok(!шлюз.звали.some((з) => з.startsWith('api.omniom.ru')),
            `${задача}, ${сбой}: ${шлюз.звали.join(', ')}`);
        } finally {
          globalThis.fetch = сеть;
          шлюз.вернуть();
        }
      });
    }
  }
});

test('М.Видео, задачи: DBS отвечает 403 — «не подключён», как и до правки', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/dbs/list' || путь === '/v1/location/list') return [403];
      if (сх !== 'api-key') return [401];
      if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
      if (путь === '/v1/product/stock/info') {
        return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 }]);
      }
      if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('dbs-403');
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 0, DBS недоступен/);
      assert.match(await м.мвОстаткиFbs(), /^складов 1, строк 1/);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: настоящий отказ DBS по-прежнему роняет задачу и не трогает лист', async () => {
  // терпится только «не подключён»: 404/403 или решающий 400 OPERATION_NOT_SUPPORTED.
  // Пятисотка — даже со словом в теле — и голый 400 — это сбой, а не «DBS недоступен»
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  for (const отказ of [[500], [400], [500, { message: 'upstream OPERATION_NOT_SUPPORTED' }],
    [422, { code: 'OPERATION_NOT_SUPPORTED' }]]) {
    await вОкружении(МВИДЕО, async () => {
      const шлюз = поддельныйШлюз((путь, сх) => {
        if (сх !== 'api-key') return [401];
        if (путь === '/v1/order/dbs/list' || путь === '/v1/location/list') return отказ;
        if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
        if (путь === '/v1/product/stock/info') {
          return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 }]);
        }
        if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
        return [500];
      });
      try {
        const { книга } = поддельнаяКнига({});
        const м = await свежийМв(`dbs-сбой-${отказ[0]}-${отказ.length}`);
        await безПауз(() => assert.rejects(м.мвЗаказыFbs(ЗАДАЧА), /\/v1\/order\/dbs\/list/, `заказы, ${отказ[0]}`));
        await безПауз(() => assert.rejects(м.мвОстаткиFbs(), /\/v1\/location\/list/, `остатки, ${отказ[0]}`));
        assert.equal(книга.get('Заказы Мвидео FBS'), undefined);
        assert.equal(книга.get('FBS остатки Мвидео'), undefined);
      } finally {
        шлюз.вернуть();
      }
    });
  }
});

test('М.Видео, задачи: OPERATION_NOT_SUPPORTED на api-key, а с Bearer данные — данные пишутся', async () => {
  // «не подключено» по одной схеме ключа — вывод только про неё
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/fbs/list') return сх === 'api-key' ? список('orders', [заказМв('F1', 'A1')]) : [401];
      if (сх === 'api-key') return [400, { code: 'OPERATION_NOT_SUPPORTED' }];
      if (путь === '/v1/order/dbs/list') return список('orders', [заказМв('D1', 'A2')]);
      if (путь === '/v1/order/fbo/list') return список('orders', [заказМв('B1', 'A3')]);
      return [401];
    });
    try {
      const { книга } = поддельнаяКнига({});
      const м = await свежийМв('ons-bearer-данные');
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 1,.*, ключ в Authorization: Bearer$/);
      assert.match(await м.мвЗаказыFbo(ЗАДАЧА), /^заказов FBO 1, .*, ключ в Authorization: Bearer$/);
      assert.ok((книга.get('Заказы Мвидео FBS') || []).some((р) => String(р[0]).includes('D1')));
      assert.ok((книга.get('Заказы Мвидео FBO') || []).some((р) => String(р[0]).includes('B1')));
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: DBS отвечает OPERATION_NOT_SUPPORTED — это «не подключён», задачи FBS живут', async () => {
  // стандарт: неподключённая схема — 400 OPERATION_NOT_SUPPORTED. Шлюз на Bearer:
  // решает ответ Bearer, и без этого правила обе задачи FBS падали бы каждый прогон
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  for (const мир of ['Bearer', 'api-key']) {
    await вОкружении(МВИДЕО, async () => {
      const шлюз = поддельныйШлюз((путь, сх) => {
        if (сх !== мир) return [401];
        if (путь === '/v1/order/dbs/list' || путь === '/v1/location/list') {
          return [400, { code: 'OPERATION_NOT_SUPPORTED' }];
        }
        if (путь === '/v1/merchant/location/list') return список('locations', [{ location_id: 'L1', name: 'Склад' }]);
        if (путь === '/v1/product/stock/info') {
          return список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 }]);
        }
        if (путь === '/v1/order/fbs/list') return список('orders', [заказМв('F1', 'A1')]);
        return [500];
      });
      try {
        const { книга } = поддельнаяКнига({});
        const м = await свежийМв(`dbs-ons-${мир}`);
        for (let прогон = 0; прогон < 2; прогон += 1) {
          assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 0, DBS недоступен/, `${мир}, прогон ${прогон}`);
          assert.match(await м.мвОстаткиFbs(), /^складов 1, строк 1/, `${мир}, прогон ${прогон}`);
        }
        assert.ok((книга.get('Заказы Мвидео FBS') || []).some((р) => String(р[0]).includes('F1')));
      } finally {
        шлюз.вернуть();
      }
    });
  }
});

test('М.Видео, задача: DBS ходил через Bearer, потом отключён — FBS пишется, DBS недоступен', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  await вОкружении(МВИДЕО, async () => {
    let dbs = 'есть';
    const шлюз = поддельныйШлюз((путь, сх) => {
      if (путь === '/v1/order/fbs/list') return сх === 'api-key' ? список('orders', [заказМв('F1', 'A1')]) : [401];
      if (путь === '/v1/order/dbs/list') {
        if (сх === 'api-key') return [404];
        return dbs === 'есть' ? список('orders', [заказМв('D1', 'A2')]) : [400];
      }
      return [500];
    });
    try {
      поддельнаяКнига({});
      const м = await свежийМв('dbs-bearer-отключён');
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 1,.*, ключ в Authorization: Bearer$/);
      dbs = 'нет';
      assert.match(await м.мвЗаказыFbs(ЗАДАЧА), /заказов FBS 1, DBS 0, DBS недоступен/);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео, задачи: пометка схемы — по каждому методу своей задачи и только своей', async () => {
  const { поддельнаяКнига } = await import('./поддельная-книга.js');
  const данные = {
    '/v1/product/stock/info': список('stocks', [{ offer_id: 'A1', location_id: 'L1', count: 3, available_count: 3 },
      { offer_id: 'A2', market_location_id: 'M1', count: 2, available_count: 2 }]),
    '/v1/merchant/location/list': список('locations', [{ location_id: 'L1', name: 'Склад' }]),
    '/v1/location/list': список('locations', [{ location_id: 'D1', name: 'Склад DBS' }]),
    '/v1/market/location/list': список('locations', [{ market_location_id: 'M1', name: 'Площадка' }]),
    '/v1/order/fbs/list': список('orders', [заказМв('F1', 'A1')]),
    '/v1/order/dbs/list': список('orders', [заказМв('D1', 'A2')]),
    '/v1/order/fbo/list': список('orders', [заказМв('B1', 'A2')]),
  };
  const задачи = {
    мвОстаткиFbs: ['/v1/product/stock/info', '/v1/merchant/location/list', '/v1/location/list'],
    мвОстаткиFbo: ['/v1/product/stock/info', '/v1/market/location/list'],
    мвЗаказыFbs: ['/v1/order/fbs/list', '/v1/order/dbs/list'],
    мвЗаказыFbo: ['/v1/order/fbo/list'],
  };
  await вОкружении(МВИДЕО, async () => {
    for (const [задача, пути] of Object.entries(задачи)) {
      for (const наBearer of пути) {
        const шлюз = поддельныйШлюз((путь, сх) => {
          if (путь === наBearer) return сх === 'api-key' ? [404] : данные[путь];
          return сх === 'api-key' ? (данные[путь] ?? [404]) : [401];
        });
        try {
          поддельнаяКнига({});
          const м = await свежийМв(`пометка-${задача}-${наBearer}`);
          const итог = await м[задача](ЗАДАЧА);
          assert.match(итог, /, ключ в Authorization: Bearer$/, `${задача}, на Bearer ${наBearer}: ${итог}`);
          for (const [другая, свои] of Object.entries(задачи)) {
            if (свои.includes(наBearer)) continue;
            const чужой = await м[другая](ЗАДАЧА);
            assert.ok(!чужой.includes('ключ в'), `${другая}, на Bearer чужой ${наBearer}: ${чужой}`);
          }
        } finally {
          шлюз.вернуть();
        }
      }
    }
  });
});

test('М.Видео: при уходе на запасной адрес справка М.Видео не останавливает перебор видов тела', async () => {
  await вОкружении(undefined, async () => {
    const шлюз = поддельныйШлюз((путь, сх, хост) => {
      if (хост === 'api.omniom.ru') return шлюз.звали.filter((з) => з.startsWith('api.omniom.ru')).length === 1
        ? [400] : список('rows', [{ id: 1 }]);
      return сх === 'api-key' ? [404] : [400, { code: 'OPERATION_NOT_SUPPORTED' }];
    });
    try {
      const м = await свежийМв('справка-до-этого');
      assert.deepEqual(await м.мвОбход('/v1/x', 'rows'), [{ id: 1 }]);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео: при уходе на запасной адрес решает ответ запасного, а не «до этого»', async () => {
  // находка шестой проверки: у ошибки после ухода не было решающего текста, и
  // слова из ответа шлюза М.Видео (теперь до 600 знаков) решали на omniom
  const тело = { message: `${'м'.repeat(100)} конфигурации`, code: 'OPERATION_NOT_SUPPORTED', note: 'HTTP 400' };
  for (const [omniom, ждём] of [['400-потом-данные', 'данные'], ['500', 'одна попытка тела']]) {
    await вОкружении(undefined, async () => {
      const шлюз = поддельныйШлюз((путь, сх, хост) => {
        if (хост !== 'api.omniom.ru') return сх === 'api-key' ? [404, тело] : [500];
        if (omniom === '500') return [500];
        return шлюз.звали.filter((з) => з.startsWith('api.omniom.ru')).length === 1
          ? [400] : список('mappings', [{ offer_id: 'A1', product_id: 'P1' }]);
      });
      try {
        const м = await свежийМв(`до-этого-${omniom}`);
        if (ждём === 'данные') {
          assert.deepEqual(await безПауз(() => м.мвОбход('/v1/product/mapping/list', 'mappings')),
            [{ offer_id: 'A1', product_id: 'P1' }]);
        } else {
          await безПауз(() => assert.rejects(м.мвОбход('/v1/product/mapping/list', 'mappings'), (е) => {
            assert.match(е.message, /HTTP 500 .*\[api\.omniom\.ru\]; до этого: /);
            assert.equal(м.статусОшибки(е), 500);
            assert.ok(!м.неПодключено(е), е.message);
            return true;
          }));
          // 500 на omniom — не повод перебирать виды тела: «HTTP 400» был в «до этого»
          assert.equal(шлюз.звали.filter((з) => з.startsWith('api.omniom.ru')).length, 2);
        }
      } finally {
        шлюз.вернуть();
      }
    });
  }
});

test('М.Видео: при уходе на запасной адрес ответ Bearer шлюза М.Видео остаётся в ошибке', async () => {
  // два адреса (MVIDEO_API_URL не задан): ответ М.Видео пишется в «до этого»,
  // и раньше его обрезали до 120 знаков — от ответа Bearer не оставалось ничего
  await вОкружении(undefined, async () => {
    const шлюз = поддельныйШлюз((путь, сх, хост) => {
      if (хост === 'api.omniom.ru') return [404, { message: 'omniom: нет такого' }];
      // тело api-key — во всю длину, что оставляет запрос() (300 знаков)
      return сх === 'api-key' ? [404, { message: 'x'.repeat(300) }] : [401, { message: 'Ошибка авторизации' }];
    });
    try {
      const м = await свежийМв('два-адреса');
      await assert.rejects(м.мвОбход('/v1/order/fbs/list', 'orders'), (е) => {
        assert.match(е.message, /\[api\.omniom\.ru\]; до этого: https:\/\/omni-net\.sellers\.mvideo\.ru: /);
        assert.match(е.message, /в Authorization: Bearer — 401 \{"message":"Ошибка авторизации"\}/);
        return true;
      });
      assert.deepEqual(шлюз.звали, ['omni-net.sellers.mvideo.ru/v1/order/fbs/list api-key',
        'omni-net.sellers.mvideo.ru/v1/order/fbs/list Bearer', 'api.omniom.ru/v1/order/fbs/list оба']);
    } finally {
      шлюз.вернуть();
    }
  });
});

test('М.Видео: до шлюза доходит один заголовок ключа, и на 404 вторая попытка идёт с Bearer', async () => {
  const http = await import('node:http');
  const пришло = [];
  const сервер = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      пришло.push({ apiKey: req.headers['api-key'], auth: req.headers.authorization });
      const ок = req.headers.authorization === 'Bearer test-key' && !req.headers['api-key'];
      res.writeHead(ок ? 200 : 404, { 'content-type': 'application/json' });
      res.end(ок ? '{"orders":[],"next_cursor":""}' : '{"message":"not found"}');
    });
  });
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  try {
    await вОкружении(`http://127.0.0.1:${сервер.address().port}`, async () => {
      const м = await свежийМв(`сервер-${сервер.address().port}`);
      assert.deepEqual(await м.мвОбход('/v1/order/fbo/list', 'orders'), []);
      assert.deepEqual(пришло, [
        { apiKey: 'test-key', auth: undefined },
        { apiKey: undefined, auth: 'Bearer test-key' },
      ]);
    });
  } finally {
    сервер.close();
  }
});
