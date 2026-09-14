import { задачи, отметитьЗапуск, пора } from './config.js';
import * as wbOzon from './wb-ozon.js';
import * as ямLm from './yandex-lamoda.js';

const ОБРАБОТЧИКИ = {
  'FBO остатки ВБ': wbOzon.wbОстаткиFbo,
  'FBS остатки ВБ': wbOzon.wbОстаткиFbs,
  'Заказы ВБ FBO': wbOzon.wbЗаказыFbo,
  'Заказы ВБ FBS': wbOzon.wbЗаказыFbs,

  'FBO остатки ОЗОН': wbOzon.ozonОстаткиFbo,
  'FBS остатки ОЗОН': wbOzon.ozonОстаткиFbs,
  'Заказы ОЗОН FBO': wbOzon.ozonЗаказыFbo,
  'Заказы ОЗОН FBS': wbOzon.ozonЗаказыFbs,

  'FBO остатки Яндекс': ямLm.ямОстаткиFbo,
  'FBS остатки Яндекс': ямLm.ямОстаткиFbs,
  'Заказы Яндекс FBO': ямLm.ямЗаказыFbo,
  'Заказы Яндекс FBS': ямLm.ямЗаказыFbs,

  'FBO остатки Ламода': ямLm.лмОстаткиFbo,
  'FBS остатки Ламода': ямLm.лмОстаткиFbs,
  'Заказы Ламода FBO': ямLm.лмЗаказыFbo,
  'Заказы Ламода FBS': ямLm.лмЗаказыFbs,
  // у М.Видео публичного API продавца нет: эти листы заполняются вручную
};

async function выполнить(задача) {
  const обработчик = ОБРАБОТЧИКИ[задача.имя];
  if (!обработчик) {
    await отметитьЗапуск(задача, 'нет коннектора, данные заливаются вручную');
    return;
  }
  const старт = Date.now();
  try {
    const результат = await обработчик(задача);
    const сек = ((Date.now() - старт) / 1000).toFixed(1);
    const хвост = задача.сдаты ? `, период с ${задача.сдаты} — глубина не действует` : '';
    await отметитьЗапуск(задача, `${результат}, ${сек} c${хвост}`);
    console.log(`[ok] ${задача.имя}: ${результат} (${сек} c)`);
  } catch (е) {
    await отметитьЗапуск(задача, `ОШИБКА: ${е.message}`.slice(0, 400));
    console.error(`[fail] ${задача.имя}: ${е.message}`);
  }
}

async function проход(принудительно = null) {
  const список = await задачи();
  const кЗапуску = принудительно
    ? список.filter((з) => з.имя === принудительно)
    : список.filter(пора);
  if (!кЗапуску.length) return;
  console.log(`к запуску: ${кЗапуску.map((з) => з.имя).join(', ')}`);
  for (const задача of кЗапуску) {
    await выполнить(задача);
  }
}

const аргументы = process.argv.slice(2);
const одинРаз = аргументы.includes('--once');
const позиция = аргументы.indexOf('--task');
const однаЗадача = позиция >= 0 ? аргументы[позиция + 1] : null;

if (однаЗадача) {
  await проход(однаЗадача);
} else if (одинРаз) {
  await проход();
} else {
  console.log('сервис запущен, проверка расписания раз в минуту');
  await проход();
  setInterval(() => {
    проход().catch((е) => console.error('сбой прохода:', е.message));
  }, 60000);
}
