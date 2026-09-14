/** Запросы с повторами: маркетплейсы регулярно отдают 429 и пятисотки. */

export const сон = (мс) => new Promise((r) => setTimeout(r, мс));

/** Повторять имеет смысл только временные отказы: остальные 4xx повтор не чинит. */
const ВРЕМЕННЫЕ = new Set([408, 425, 429]);
const временный = (код) => ВРЕМЕННЫЕ.has(код) || код >= 500;

export async function запрос(
  url,
  опции = {},
  { имя = url, попыток = 5, пауза = 1000, таймаут = 120000 } = {},
) {
  let последняя;
  for (let n = 1; n <= попыток; n += 1) {
    let ответ;
    try {
      ответ = await fetch(url, { ...опции, signal: AbortSignal.timeout(таймаут) });
    } catch (е) {
      // сеть, DNS, обрыв, таймаут — это как раз тот случай, ради которого нужны повторы
      последняя = new Error(`${имя}: ${е.message}`);
      if (n === попыток) break;
      await сон(пауза * n);
      continue;
    }
    // тело читаем всегда, иначе соединение остаётся висеть в пуле
    const текст = await ответ.text().catch(() => '');
    if (!ответ.ok) {
      const ошибка = new Error(`${имя}: HTTP ${ответ.status} ${текст.slice(0, 300)}`.trim());
      if (!временный(ответ.status)) throw ошибка;
      последняя = ошибка;
      if (n === попыток) break;
      await сон(пауза * n);
      continue;
    }
    if (!текст) return {};
    try {
      return JSON.parse(текст);
    } catch {
      throw new Error(`${имя}: ответ не JSON: ${текст.slice(0, 200)}`);
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

/** Локальное время без смещения: так даты ждут WB и Яндекс — у них всё в московском. */
export function локальныйISO(д) {
  const п = (n) => String(n).padStart(2, '0');
  return `${д.getFullYear()}-${п(д.getMonth() + 1)}-${п(д.getDate())}T`
       + `${п(д.getHours())}:${п(д.getMinutes())}:${п(д.getSeconds())}`;
}

/** Таблицы считают дни от 30.12.1899. */
const ЭПОХА_ТАБЛИЦ = Date.UTC(1899, 11, 30);

/**
 * Значение ячейки → Date.
 * Читаем книгу с valueRenderOption=UNFORMATTED_VALUE, поэтому дата приходит
 * числом — днями от 30.12.1899. Отдавать такое число конструктору Date нельзя:
 * он считает его миллисекундами и получает 1970 год, а строку «46249» —
 * номером года. Оба случая раньше молча уезжали в запросы к маркетплейсам.
 */
export function изТаблицы(значение) {
  if (значение === null || значение === undefined || значение === '') return null;
  if (значение instanceof Date) return Number.isNaN(значение.getTime()) ? null : значение;

  const текст = String(значение).trim();
  if (!текст) return null;

  const чис = typeof значение === 'number' ? значение : Number(текст.replace(',', '.'));
  if (Number.isFinite(чис)) {
    // всё осмысленное лежит между 1900 и 2100 годом: 1 — 31.12.1899, 73415 — 2100
    if (чис <= 0 || чис > 100000) return null;
    const дней = Math.floor(чис);
    const мс = Math.round((чис - дней) * 86400000);
    const сутки = new Date(ЭПОХА_ТАБЛИЦ + дней * 86400000);
    // собираем локальную дату по календарным частям: так значение уходит
    // и возвращается из книги без сдвига на часовой пояс
    const д = new Date(сутки.getUTCFullYear(), сутки.getUTCMonth(), сутки.getUTCDate());
    д.setTime(д.getTime() + мс);
    return д;
  }

  const м = текст.match(
    /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (м) {
    return new Date(+м[3], +м[2] - 1, +м[1], +(м[4] || 0), +(м[5] || 0), +(м[6] || 0));
  }
  const д = new Date(текст);
  return Number.isNaN(д.getTime()) ? null : д;
}

/** Начало периода: явная дата с листа перебивает глубину в днях. */
export function началоПериода(задача) {
  if (задача.сдаты !== '' && задача.сдаты !== null && задача.сдаты !== undefined) {
    const явная = изТаблицы(задача.сдаты);
    const предел = Date.now() + 24 * 3600 * 1000;
    if (!явная || явная.getFullYear() < 2015 || явная.getTime() > предел) {
      throw new Error(`не разобрана «С даты»: ${String(задача.сдаты).slice(0, 40)}`);
    }
    return явная;
  }
  const дней = задача.глубина || 14;
  return new Date(Date.now() - дней * 24 * 3600 * 1000);
}
