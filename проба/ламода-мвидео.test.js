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


test('М.Видео: Bearer — только для omniom, на шлюзе М.Видео — один api-key', () => {
  assert.equal(заголовки('https://omni-net.sellers.mvideo.ru', 'k').Authorization, undefined);
  assert.equal(заголовки('https://omni-net.sellers.mvideo.ru', 'k')['api-key'], 'k');
  assert.equal(заголовки('https://api.omniom.ru', 'k').Authorization, 'Bearer k');
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
