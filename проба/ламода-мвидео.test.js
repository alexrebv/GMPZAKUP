import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/tz.js';
import { лмСтрокиЗаказа, схемаПоОстаткам, продавецИзТокена } from '../src/lamoda.js';
import { мвСтрокаЗаказа, мвЦена, мвОбход } from '../src/mvideo.js';
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
  const страницы = { null: { stocks: [1, 2], next_cursor: 'a' }, a: { stocks: [3], next_cursor: '' } };
  const курсоры = [];
  globalThis.fetch = async (_у, о) => {
    const тело = JSON.parse(о.body);
    курсоры.push(тело.cursor);
    assert.equal(о.headers['api-key'], 'k');
    return new Response(JSON.stringify(страницы[String(тело.cursor)]), { status: 200 });
  };
  try {
    assert.deepEqual(await мвОбход('/v1/product/stock/info', 'stocks'), [1, 2, 3]);
    assert.deepEqual(курсоры, [null, 'a']);
    globalThis.fetch = async () => new Response(JSON.stringify({ stocks: [1], next_cursor: 'same' }), { status: 200 });
    await assert.rejects(мвОбход('/v1/product/stock/info', 'stocks'), /курсор не двигает/);
    globalThis.fetch = async () => new Response(JSON.stringify({ oops: 1 }), { status: 200 });
    await assert.rejects(мвОбход('/v1/product/stock/info', 'stocks'), /без списка/);
  } finally {
    globalThis.fetch = прежний;
  }
});

