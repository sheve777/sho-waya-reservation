const express = require('express');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const weekday = require('dayjs/plugin/weekday');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
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

// 店舗設定の読み込み
const shopConfig = JSON.parse(fs.readFileSync('shop-config.json', 'utf-8'));
const MAX_PER_SLOT = shopConfig.maxReservationPerSlot || 18;

// 定休日（日曜または祝日）
function isClosed(date) {
  return date.day() === 0 || isHoliday.isHoliday(date.toDate());
}

// スロット生成（30分刻み）
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

// 空きスロットを取得
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

// トップページ：カレンダーで日付選択
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

// 空きスロット表示
app.get('/day', async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.redirect('/');
  }
  const slots = await getAvailableSlots(date);
  res.render('slots', { date, slots, error: null });
});

// 予約処理
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

  // 席ルールの判定
  if (seatType === 'counter' && peopleCount > 2) {
    return res.render('slots', {
      date,
      slots: await getAvailableSlots(date),
      error: 'カウンター席は2名までの予約に限られます。'
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
