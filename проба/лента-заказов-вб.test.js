import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import '../src/tz.js';
import { СХЕМЫ } from '../src/schemas.js';

process.env.WB_ANALYTICS_KEY = 'test-key';
process.env.WB_MARKET_KEY = 'test-key';

const СХЕМА = СХЕМЫ['WB заказы проверка'];
const серийно = (г, м, д) => (Date.UTC(г, м - 1, д) - Date.UTC(1899, 11, 30)) / 86400000;
const сутки = 24 * 3600 * 1000;
const ПАЧКА = 10000;       // предел метода, он же размер полной страницы
const СНИМОК = '2026-07-28T15:04:05Z';

/**
 * Заказ ровно теми полями, какие описаны в спецификации метода.
 *
 * Время отсчитывается от МОМЕНТА ЗАПУСКА пробы, а не от Date.now() в каждом
 * вызове: иначе один и тот же заказ приходил бы с разным updatedAt на разных
 * страницах, и проба на застрявший offset молча перестала бы что-либо проверять.
 */
const ЗАПУСК = Date.now();
function заказ(i) {
  const д = new Date(ЗАПУСК - (i % 20) * 3600 * 1000);
  return {
    nmId: 47254354 + i,
    chrtId: 91663228 + (i % 3),
    // srid бывает девятнадцатизначным — проверяем, что цифры не теряются.
    // Собираем строкой, а не арифметикой: 7513432034713000000 + 1 в JavaScript
    // даёт то же число, и все srid стали бы одинаковыми — ровно та беда,
    // от которой этот столбец и защищают
    srid: `75134320347130${String(10000 + i)}.1.0`,
    createdAt: new Date(д.getTime() - 5 * сутки).toISOString(),
    updatedAt: д.toISOString(),
    status: ['created', 'buyout', 'cancel', 'return', 'returnDefective'][i % 5],
    cancelType: i % 5 === 2 ? 'app' : undefined,
    warehouseName: 'Склад WB',
    warehouseRegion: '',
    isMp: i % 2 === 0,
    destinationCity: 'Санкт-Петербург',
    destinationDistrict: 'Северо-Западный',
    sellerPrice: 4328 + i,
    isB2b: i % 7 === 0,
  };
}

/**
 * Поддельная лента: держит предел в 31 сутки, листает offset-ом и требует
 * snapshotTime ровно там, где его требует спецификация — со второго запроса.
 */
function поддельнаяЛента({
  всего = 7,
  предел = 31,
  пустойОтвет = false,
  безСнимка = false,
  offsetНеРаботает = false,
  sridПовторяется = false,
} = {}) {
  const запросы = [];
  const сервер = http.createServer((req, res) => {
    let сырое = '';
    req.on('data', (к) => { сырое += к; });
    req.on('end', () => {
      const отдать = (код, тело) => {
        res.writeHead(код, { 'content-type': 'application/json' });
        res.end(JSON.stringify(тело));
      };
      if (req.url.includes('cards/list')) {
        return отдать(200, { cards: [{
          nmID: 47254354,
          vendorCode: '1970-01-29',
          sizes: [
            { chrtID: 91663228, skus: ['4680000000000'] },
            { chrtID: 91663229, skus: ['0046800000001'] },
          ],
        }], cursor: { total: 1 } });
      }

      const тело = JSON.parse(сырое || '{}');
      запросы.push(тело);
      const п = тело.pagination || {};
      const период = тело.selectedPeriod || {};

      const глубина = (Date.now() - new Date(период.start).getTime()) / сутки;
      if (!(глубина <= предел)) {
        return отдать(400, { title: 'bad period', detail: `глубина ${глубина.toFixed(1)} суток` });
      }
      // снимок обязателен со второго запроса и запрещён в первом
      if (п.offset > 0 && !безСнимка && п.snapshotTime !== СНИМОК) {
        return отдать(400, { title: 'bad snapshot', detail: `offset ${п.offset} без снимка` });
      }
      if (!п.offset && п.snapshotTime) {
        return отдать(400, { title: 'bad snapshot', detail: 'снимок в первом запросе' });
      }
      if (пустойОтвет) return отдать(200, {});

      const от = offsetНеРаботает ? 0 : (п.offset || 0);
      const сколько = Math.min(п.limit || 50, Math.max(всего - от, 0));
      const страница = Array
        .from({ length: offsetНеРаботает ? Math.min(п.limit || 50, всего) : сколько },
          (_, k) => заказ(от + k))
        // один и тот же srid на всех страницах: разные заказы, общий идентификатор
        .map((з) => (sridПовторяется ? { ...з, srid: '7513432034713000000.1.0' } : з));
      отдать(200, {
        data: {
          snapshotTime: безСнимка ? undefined : СНИМОК,
          currency: 'RUB',
          orders: страница,
        },
      });
    });
  });
  return { сервер, запросы };
}

async function собрать(задача = {}, опции = {}) {
  const { сервер, запросы } = поддельнаяЛента(опции);
  await new Promise((r) => сервер.listen(0, '127.0.0.1', r));
  const адрес = `http://127.0.0.1:${сервер.address().port}`;
  process.env.WB_ANALYTICS_URL = адрес;
  process.env.WB_CONTENT_URL = адрес;
  try {
    const m = await import(`../src/wb-ozon.js?${Math.random()}`);
    return { ...(await m.wbЛентаЗаказовСтроки(задача)), запросы };
  } finally {
    сервер.close();
  }
}

// ─────────────────────────── период ───────────────────────────

test('период глубже предела метода обрезается, и обрезка видна', async () => {
  // «С даты» девяносто суток назад: метод такое не отдаёт и отвечает 400
  const давно = Math.floor(серийно(2026, 1, 1));
  const { строки, обрезано, запросы } = await собрать({ сдаты: давно });
  assert.equal(обрезано, true, 'обрезку надо показывать, а не делать молча');
  assert.ok(строки.length > 0, 'после обрезки выгрузка должна пройти');
  const глубина = (Date.now() - new Date(запросы[0].selectedPeriod.start).getTime()) / сутки;
  assert.ok(глубина <= 31, `в метод ушла глубина ${глубина.toFixed(1)} суток`);
});

test('период внутри предела не обрезается', async () => {
  const { обрезано, запросы } = await собрать({ глубина: 7 });
  assert.equal(обрезано, false);
  const глубина = (Date.now() - new Date(запросы[0].selectedPeriod.start).getTime()) / сутки;
  assert.ok(глубина > 6 && глубина < 8, `глубина ${глубина.toFixed(2)} вместо семи суток`);
});

test('даты уходят со явным смещением от UTC', async () => {
  const { запросы } = await собрать({ глубина: 3 });
  for (const поле of ['start', 'end']) {
    const з = запросы[0].selectedPeriod[поле];
    assert.match(з, /[+-]\d{2}:\d{2}$/, `${поле} без смещения: ${з}`);
  }
});

// ─────────────────────────── пагинация ───────────────────────────

test('выборка листается offset-ом, ничего не теряя и не задваивая', async () => {
  const всего = ПАЧКА * 2 + 11;
  const { строки, страниц } = await собрать({ глубина: 7 }, { всего });
  assert.equal(строки.length, всего, `собрано ${строки.length} из ${всего}`);
  assert.equal(страниц, 3);
  const srid = new Set(строки.map((р) => р[0]));
  assert.equal(srid.size, всего, `срослись разные заказы: уникальных srid ${srid.size}`);
});

test('снимок не передаётся в первом запросе и неизменен в остальных', async () => {
  const { запросы } = await собрать({ глубина: 7 }, { всего: ПАЧКА * 2 + 1 });
  assert.equal(запросы.length, 3);
  assert.equal(запросы[0].pagination.snapshotTime, undefined,
    'в первом запросе снимка быть не должно');
  for (const з of запросы.slice(1)) {
    assert.equal(з.pagination.snapshotTime, СНИМОК, 'снимок должен быть снимком ПЕРВОГО ответа');
  }
  assert.deepEqual(запросы.map((з) => з.pagination.offset), [0, ПАЧКА, ПАЧКА * 2]);
});

test('одна короткая страница — один запрос', async () => {
  const { страниц, запросы } = await собрать({ глубина: 7 }, { всего: 5 });
  assert.equal(страниц, 1);
  assert.equal(запросы.length, 1);
});

test('offset не двигает выборку — падаем, а не крутимся', async () => {
  await assert.rejects(
    собрать({ глубина: 7 }, { всего: ПАЧКА * 3, offsetНеРаботает: true }),
    /offset не двигает выборку/,
  );
});

test('повторяющийся srid не выглядит застрявшим offset-ом', async () => {
  // srid повторяется, а страницы разные: это законно, и падать тут не на чем.
  // Прежняя проверка «нет новых srid» ровно здесь и давала ложную тревогу
  const { строки, страниц } = await собрать(
    { глубина: 7 }, { всего: ПАЧКА * 2 + 3, sridПовторяется: true });
  assert.equal(страниц, 3, `страниц ${страниц} — обход оборвался раньше времени`);
  assert.equal(строки.length, 1, 'общий srid сворачивается в одну строку, как и ключ листа');
});

test('многостраничная выборка без snapshotTime — ошибка, а не тихая каша', async () => {
  await assert.rejects(
    собрать({ глубина: 7 }, { всего: ПАЧКА * 2, безСнимка: true }),
    /не вернул snapshotTime/,
  );
});

test('ответ без списка заказов — ошибка, а не пустой успех', async () => {
  await assert.rejects(
    собрать({ глубина: 7 }, { пустойОтвет: true }),
    /ответил без списка/,
  );
});

// ─────────────────────────── строка листа ───────────────────────────

test('строка собрана по схеме', async () => {
  const { строки } = await собрать({ глубина: 7 }, { всего: 10 });
  for (const р of строки) assert.equal(р.length, СХЕМА.length, 'ширина строки не по схеме');
  const поля = Object.fromEntries(СХЕМА.map((и, i) => [и, строки[0][i]]));
  assert.equal(поля['Склад'], 'Склад WB');
  assert.equal(поля['Город доставки'], 'Санкт-Петербург');
  assert.equal(поля['Округ доставки'], 'Северо-Западный');
  assert.equal(поля['Валюта'], 'RUB');
  assert.equal(поля['nmID'], 47254354);
  assert.match(String(поля['Дата заказа']), /^\d{2}\.\d{2}\.\d{4} /);
  assert.match(String(поля['Дата статуса']), /^\d{2}\.\d{2}\.\d{4} /);
});

test('srid уходит текстом и не теряет цифр', async () => {
  const { строки } = await собрать({ глубина: 7 }, { всего: 3 });
  for (const р of строки) {
    assert.ok(String(р[0]).startsWith("'"),
      `srid без пометки «текст»: ${р[0]} — Таблицы срежут хвост девятнадцатизначного числа`);
    assert.match(String(р[0]).slice(1), /^\d{19}\.1\.0$/,
      `srid не девятнадцатизначный: ${р[0]}`);
  }
});

test('пустое поле «Тип отмены» не превращается в undefined', async () => {
  const { строки } = await собрать({ глубина: 7 }, { всего: 10 });
  const индекс = СХЕМА.indexOf('Тип отмены');
  for (const р of строки) {
    assert.notEqual(String(р[индекс]), 'undefined', 'в лист уехало слово undefined');
    assert.ok(р[индекс] === 'app' || р[индекс] === '-', `неожиданный тип отмены: ${р[индекс]}`);
  }
});

test('схема берётся из isMp: склад продавца — FBS, склад WB — FBO', async () => {
  const { строки } = await собрать({ глубина: 7 }, { всего: 4 });
  const индекс = СХЕМА.indexOf('Схема');
  assert.deepEqual(строки.map((р) => р[индекс]), ['FBS', 'FBO', 'FBS', 'FBO']);
});

test('артикул продавца и штрихкод подставляются из карточек', async () => {
  const { строки, безКарточки } = await собрать({ глубина: 7 }, { всего: 3 });
  const арт = СХЕМА.indexOf('Артикул продавца');
  const шк = СХЕМА.indexOf('Штрихкод');
  // карточки знают размеры 91663228 и 91663229, третий (…230) им неизвестен
  assert.equal(строки[0][арт], "'1970-01-29",
    'артикул-дата обязан уйти текстом, иначе Таблицы сделают из него дату');
  assert.equal(строки[0][шк], '4680000000000');
  assert.equal(строки[1][шк], "'0046800000001", 'ведущий ноль штрихкода обязан сохраниться');
  assert.equal(строки[2][арт], '-', 'размер без карточки должен давать прочерк');
  assert.equal(безКарточки, 1, `без карточки посчитано ${безКарточки}`);
});
