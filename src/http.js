/** Запросы с повторами: маркетплейсы регулярно отдают 429 и пятисотки. */

export const сон = (мс) => new Promise((r) => setTimeout(r, мс));

export async function запрос(url, опции = {}, { имя = url, попыток = 5, пауза = 1000 } = {}) {
  let последняя;
  for (let n = 1; n <= попыток; n += 1) {
    try {
      const ответ = await fetch(url, опции);
      if (ответ.status === 429 || ответ.status >= 500) {
        последняя = new Error(`${имя}: HTTP ${ответ.status}`);
        await сон(пауза * n);
        continue;
      }
      const текст = await ответ.text();
      if (!ответ.ok) {
        throw new Error(`${имя}: HTTP ${ответ.status} ${текст.slice(0, 300)}`);
      }
      return текст ? JSON.parse(текст) : {};
    } catch (е) {
      последняя = е;
      if (n === попыток) break;
      await сон(пауза * n);
    }
  }
  throw последняя;
}

export const iso = (д) => new Date(д).toISOString();
export const число = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Дата в формате, который Google Таблицы разбирают как дату, а не как текст. */
export function вТаблицу(значение) {
  if (!значение) return '-';
  const д = значение instanceof Date ? значение : new Date(значение);
  if (Number.isNaN(д.getTime())) return '-';
  const п = (n) => String(n).padStart(2, '0');
  return `${п(д.getDate())}.${п(д.getMonth() + 1)}.${д.getFullYear()} `
       + `${п(д.getHours())}:${п(д.getMinutes())}:${п(д.getSeconds())}`;
}

/** Начало периода: явная дата с листа перебивает глубину в днях. */
export function началоПериода(задача) {
  if (задача.сдаты) {
    const м = String(задача.сдаты).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (м) return new Date(+м[3], +м[2] - 1, +м[1]);
    const д = new Date(задача.сдаты);
    if (!Number.isNaN(д.getTime())) return д;
  }
  const дней = задача.глубина || 14;
  return new Date(Date.now() - дней * 24 * 3600 * 1000);
}
