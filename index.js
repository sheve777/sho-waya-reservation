const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const weekday = require('dayjs/plugin/weekday');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isHoliday = require('japanese-holidays');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

dayjs.extend(weekday);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Tokyo");

// Google Calendar 認証
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });
const calendarId = process.env.GOOGLE_CALENDAR_ID;

// 店舗設定読み込み
const shopConfig = JSON.parse(fs.readFileSync('shop-config.json', 'utf-8'));
const MAX_PER_SLOT = shopConfig.maxReservationPerSlot || 18;

// 定休日か判定（日曜 or 祝日）
function isClosed(date) {
  return date.day() === 0 || isHoliday.isHoliday(date.toDate());
}

// 30分刻みのスロット生成
function generateSlots(date) {
  const slots = [];
  let time = date.hour(17).minute(0);
  const end = date.hour(22).minute(0).add(30, 'minute');
  while (time.isBefore(end)) {
    slots.push(time.format('HH:mm'));
    time = time.add(30, 'minute');
  }
  return slots;
}

// 指定日のスロット空き状況を取得
async function getAvailableSlots(dateStr) {
  const date = dayjs.tz(dateStr, "Asia/Tokyo");
  const events = await calendar.events.list({
    calendarId,
    timeMin: date.startOf('day').toISOString(),
    timeMax: date.endOf('day').toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const slotCounts = {};
  events.data.items.forEach(ev => {
    const slot = dayjs(ev.start.dateTime).tz().format('HH:mm');
    slotCounts[slot] = (slotCounts[slot] || 0) + 1;
  });

  return generateSlots(date).filter(slot => (slotCounts[slot] || 0) < MAX_PER_SLOT);
}

// カレンダー描画補助：月の配列を返す
async function buildCalendar(year, month) {
  const startDate = dayjs(`${year}-${month}-01`);
  const endDate = startDate.endOf('month');
  const days = [];

  for (let d = startDate; d.isSameOrBefore(endDate); d = d.add(1, 'day')) {
    if (isClosed(d)) {
      days.push({ date: d.format('YYYY-MM-DD'), status: '×' });
    } else {
      const slots = await getAvailableSlots(d.format('YYYY-MM-DD'));
      days.push({ date: d.format('YYYY-MM-DD'), status: slots.length > 0 ? '◯' : '×' });
    }
  }

  return {
    year,
    month,
    days,
    monthLabel: `${year}年${month}月`,
    prev: dayjs(`${year}-${month}-01`).subtract(1, 'month'),
    next: dayjs(`${year}-${month}-01`).add(1, 'month')
  };
}

// トップページ（カレンダー）
app.get('/', async (req, res) => {
  const year = req.query.year || dayjs().year();
  const month = req.query.month || dayjs().month() + 1;

  const calendarData = await buildCalendar(year, month);
  res.render('index', calendarData);
});

// スロット表示
app.get('/day', async (req, res) => {
  const { date } = req.query;
  const slots = await getAvailableSlots(date);
  res.render('slots', { date, slots, error: null });
});

// 予約POST
app.post('/reserve', async (req, res) => {
  const { date, time, name, people, seatType } = req.body;
  const peopleCount = parseInt(people);

  if (!name || !date || !time || !people || !seatType) {
    return res.render('slots', {
      date,
      slots: await getAvailableSlots(date),
      error: 'すべての項目を入力してください。'
    });
  }

  if (peopleCount > 8 || peopleCount < 1) {
    return res.render('slots', {
      date,
      slots: await getAvailableSlots(date),
      error: '人数は1〜8人の間で指定してください。'
    });
  }

  if (seatType === 'counter' && peopleCount > 4) {
    return res.render('slots', {
      date,
      slots: await getAvailableSlots(date),
      error: 'カウンター席は4名までの予約に限られます。'
    });
  }

  if (seatType === 'table' && peopleCount < 3) {
    return res.render('slots', {
      date,
      slots: await getAvailableSlots(date),
      error: 'テーブル席は3名以上からご利用いただけます。'
    });
  }

  const start = dayjs.tz(`${date} ${time}`, "Asia/Tokyo");
  const end = start.add(30, 'minute');

  await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: `予約 - ${name}（${people}名 / ${seatType === 'table' ? 'テーブル' : 'カウンター'}）`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      description: `氏名: ${name} / 人数: ${people} / 席種: ${seatType}`
    }
  });

  res.send(`
    <h2 style="font-size: 1.5em;">予約が完了しました！</h2>
    <p>日付: ${date} / 時間: ${time} / 氏名: ${name} / 人数: ${people}名 / 席種: ${seatType}</p>
    <a href="/" style="display:inline-block;margin-top:1em;font-size:1.1em;">トップに戻る</a>
  `);
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`予約システムがポート${PORT}で起動しました`);
});
