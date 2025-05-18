const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const weekday = require('dayjs/plugin/weekday');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const isHoliday = require('japanese-holidays');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

dayjs.extend(weekday);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

// Googleカレンダー認証
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });
const calendarId = process.env.GOOGLE_CALENDAR_ID;

// 店舗設定読み込み
const shopConfig = JSON.parse(fs.readFileSync('shop-config.json', 'utf-8'));

// 定休日チェック
function isClosed(date) {
  return date.day() === 0 || isHoliday.isHoliday(date.toDate());
}

// 時間スロット（17:00〜22:00の30分刻み）
function generateSlots(date) {
  const slots = [];
  let time = date.hour(17).minute(0);
  const end = date.hour(22).minute(0);
  while (time.isSameOrBefore(end)) {
    slots.push(time.format('HH:mm'));
    time = time.add(30, 'minute');
  }
  return slots;
}

// 予約済み時間と人数を考慮して利用可能なスロットを返す
async function getAvailableSlots(dateStr) {
  const date = dayjs(dateStr);
  const events = await calendar.events.list({
    calendarId,
    timeMin: date.startOf('day').toISOString(),
    timeMax: date.endOf('day').toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const slotCounts = {};
  events.data.items.forEach(ev => {
    const slot = dayjs(ev.start.dateTime).format('HH:mm');
    slotCounts[slot] = (slotCounts[slot] || 0) + 1;
  });

  const max = shopConfig.maxReservationPerSlot || 5;
  return generateSlots(date).filter(slot => (slotCounts[slot] || 0) < max);
}

// トップページ（日付一覧）
app.get('/', async (req, res) => {
  const days = [];
  const today = dayjs();
  for (let i = 0; i < 7; i++) {
    const date = today.add(i, 'day');
    if (!isClosed(date)) {
      days.push(date.format('YYYY-MM-DD'));
    }
  }
  res.render('index', { days });
});

// 時間スロット一覧ページ
app.get('/day/:date', async (req, res) => {
  const { date } = req.params;
  const slots = await getAvailableSlots(date);
  res.render('slots', { date, slots });
});

// 予約処理（POST）
app.post('/reserve', async (req, res) => {
  const { name, seats, type, date, time } = req.body;
  const numSeats = parseInt(seats);

  const maxSeats = shopConfig.tables.reduce((sum, table) => {
    if (type === 'table' && table.type === 'table') return sum + table.seats;
    if (type === 'counter' && table.type === 'counter') return sum + table.seats;
    return sum;
  }, 0);

  // 席数制限チェック
  if (
    (type === 'table' && numSeats < 3) ||
    (type === 'counter' && numSeats > 2) ||
    numSeats > 8
  ) {
    return res.send('不正な予約条件です。ルールに従ってください。');
  }

  // テーブル2席を使用する場合（5名以上）
  let usedSeats = numSeats;
  if (type === 'table' && numSeats >= 5) {
    usedSeats = 8;
  }

  const start = dayjs(`${date}T${time}`);
  const end = start.add(30, 'minute');

  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: `笑わ家予約：${name}様（${seats}名／${type === 'table' ? 'テーブル' : 'カウンター'}）`,
      start: {
        dateTime: start.toISOString(),
        timeZone: 'Asia/Tokyo'
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'Asia/Tokyo'
      }
    }
  });

  res.send('予約が完了しました！');
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`予約システムがポート${PORT}で起動しました`);
});
