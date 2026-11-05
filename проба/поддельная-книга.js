/*
 * Поддельные Google Таблицы для проб: книга в памяти, подставляется в sheets.js
 * через подставитьКлиент(). Не проба сама по себе — npm test берёт только *.test.js.
 */
import { изТаблицы } from '../src/http.js';
import { подставитьКлиент } from '../src/sheets.js';

const ДАТА_РУ = /^\d{1,2}\.\d{1,2}\.\d{4}( \d{1,2}:\d{2}(:\d{2})?)?$/;
export const серийно = (г, м, д) => (Date.UTC(г, м - 1, д) - Date.UTC(1899, 11, 30)) / 86400000;

/**
 * Поддельные Таблицы, ведущие себя как настоящие при USER_ENTERED:
 * апостроф снимают и хранят текстом, дату и число разбирают по-своему,
 * а в ответ на чтение апостроф уже НЕ возвращают — на этом и горел код.
 */
export function поддельнаяКнига(начальные = {}) {
  const книга = new Map(Object.entries(начальные).map(([к, в]) => [к, в.map((р) => [...р])]));
  const записи = [];
  const какGoogle = (v) => {
    if (typeof v !== 'string') return v;
    if (v.startsWith("'")) return v.slice(1);            // пометка «текст» снимается
    const t = v.trim();
    if (ДАТА_РУ.test(t)) {
      const д = изТаблицы(t);
      return (Date.UTC(д.getFullYear(), д.getMonth(), д.getDate(),
        д.getHours(), д.getMinutes(), д.getSeconds()) - Date.UTC(1899, 11, 30)) / 86400000;
    }
    const м = t.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/);
    if (м) { let г = +м[1]; if (г < 100) г += 2000; return серийно(г, +м[2], +м[3]); }
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
    return v;
  };
  const вИндекс = (б) => [...б].reduce((а, с) => а * 26 + (с.charCodeAt(0) - 64), 0) - 1;
  const разбор = (r) => {
    const м = r.match(/^'(.+?)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    return { лист: м[1], кол: вИндекс(м[2]), строка: +м[3], до: м[5] ? +м[5] : null };
  };
  const положить = (л, стр, кол, зн) => {
    const в = книга.get(л) || [];
    зн.forEach((р, i) => {
      const с = в[стр - 1 + i] || [];
      р.forEach((з, j) => { с[кол + j] = какGoogle(з); });
      в[стр - 1 + i] = с;
    });
    книга.set(л, в);
  };
  подставитьКлиент({ spreadsheets: { values: {
    async get({ range }) {
      const { лист, строка, кол, до } = разбор(range);
      const с = (книга.get(лист) || []).slice(строка - 1, до ?? undefined)
        .map((р) => [...(р || [])].slice(кол));
      while (с.length && !(с[с.length - 1] || []).join('')) с.pop();
      return { data: { values: с } };
    },
    async update({ range, requestBody }) {
      записи.push({ range, values: requestBody.values });
      const { лист, строка, кол } = разбор(range);
      положить(лист, строка, кол, requestBody.values);
    },
    async batchUpdate({ requestBody }) {
      for (const д of requestBody.data) {
        записи.push({ range: д.range, values: д.values });
        const { лист, строка, кол } = разбор(д.range);
        положить(лист, строка, кол, д.values);
      }
    },
    async clear({ range }) {
      const { лист, строка, до } = разбор(range);
      const в = книга.get(лист) || [];
      for (let i = строка - 1; i < Math.min(до ?? в.length, в.length); i += 1) в[i] = [];
      книга.set(лист, в);
    },
  } } });
  return { книга, записи };
}
