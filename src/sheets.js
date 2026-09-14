import { google } from 'googleapis';
import { СХЕМЫ, КЛЮЧИ, СНИМКИ } from './schemas.js';

const SHEET_ID = process.env.SHEET_ID;
let клиент;

function ключСервиса() {
  const сырой = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!сырой) throw new Error('не задан GOOGLE_SERVICE_ACCOUNT_JSON');
  const текст = сырой.trim().startsWith('{')
    ? сырой
    : Buffer.from(сырой, 'base64').toString('utf8');
  return JSON.parse(текст);
}

export async function таблицы() {
  if (клиент) return клиент;
  const ключ = ключСервиса();
  const авторизация = new google.auth.JWT({
    email: ключ.client_email,
    key: ключ.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  await авторизация.authorize();
  клиент = google.sheets({ version: 'v4', auth: авторизация });
  return клиент;
}

export async function читать(диапазон) {
  const api = await таблицы();
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: диапазон,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return data.values || [];
}

export async function писать(диапазон, значения) {
  const api = await таблицы();
  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: диапазон,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: значения },
  });
}

async function очистить(лист, колонок, доСтроки) {
  const api = await таблицы();
  const буква = String.fromCharCode(64 + Math.min(колонок, 26));
  await api.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `'${лист}'!A2:${буква}${Math.max(доСтроки, 2)}`,
  });
}

/**
 * Пишет строки в лист. Остатки перезаписываются целиком, заказы дозаписываются:
 * строка с тем же ключом обновляется, новая уходит в конец.
 * Ширина записи ограничена схемой — служебные колонки книги остаются нетронутыми.
 */
export async function сохранить(лист, строки) {
  const схема = СХЕМЫ[лист];
  if (!схема) throw new Error(`нет схемы для листа «${лист}»`);
  const ширина = схема.length;
  const буква = String.fromCharCode(64 + ширина);

  if (СНИМКИ.has(лист)) {
    const было = await читать(`'${лист}'!A2:A20000`);
    await очистить(лист, ширина, было.length + 2);
    if (строки.length) await писать(`'${лист}'!A2`, строки);
    return { всего: строки.length, новых: строки.length };
  }

  const ключи = КЛЮЧИ[лист] || [0];
  const было = await читать(`'${лист}'!A2:${буква}20000`);
  const индекс = new Map();
  было.forEach((строка, i) => {
    const к = ключи.map((j) => String(строка[j] ?? '')).join('|');
    if (к.replace(/\|/g, '')) индекс.set(к, i);
  });

  let новых = 0;
  const итог = было.map((с) => [...с]);
  for (const строка of строки) {
    const к = ключи.map((j) => String(строка[j] ?? '')).join('|');
    if (индекс.has(к)) {
      итог[индекс.get(к)] = строка;
    } else {
      индекс.set(к, итог.length);
      итог.push(строка);
      новых += 1;
    }
  }
  if (итог.length) await писать(`'${лист}'!A2`, итог);
  return { всего: итог.length, новых };
}
