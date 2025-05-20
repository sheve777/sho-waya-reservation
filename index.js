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

// 店舗設定読み込み
const shopConfig = JSON.parse(fs.readFileSync('shop-config.json', 'utf-8'));

// 定休日チェック（日曜または祝日）
function isClosed(date) {
  return date.day() === 0 || isHoliday.isHoliday(date.toDate());
}

// スロット生成（30分刻み）
function generateSlots(date) {
  const slots = [];
  let time = date.hour(17).minute(0);
  const end = date.hour(22).minute(0);
  while (time.isBefore(end) || time.isSame(end)) {
    slots.push(time.format('HH:mm'));
    time = time.add(30, 'minute');
  }
  return slots;
}

// 空きスロット取得
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

  const max = shopConfig.maxReservationPerSlot || 18;
  return generateSlots(date).filter(slot => (slotCounts[slot] || 0) < max);
}

// トップページ（予約日選択）
app.get('/', async (req, res) => {
  const today = dayjs();
  const months = [today.startOf('month'), today.add(1, 'month').startOf('month')];
  const calendarData = [];

  for (const month of months) {
    const days = [];
    for (let i = 0; i < month.daysInMonth(); i++) {
      const date = month.add(i, 'day');
      const isHolidayOrSunday = isClosed(date);
      const slots = isHolidayOrSunday ? [] : await getAvailableSlots(date.format('YYYY-MM-DD'));
      const status = isHolidayOrSunday || slots.length === 0 ? '×' : '●';
      days.push({ date: date.format('YYYY-MM-DD'), day: date.date(), status });
    }
    calendarData.push({
      title: month.format('YYYY年M月'),
      startDay: month.day(), // 月初の曜日
      days
    });
  }

  res.render('index', { calendarData });
});

// スロット選択ページ
app.get('/day/:date', async (req, res) => {
  const { date } = req.params;
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

  // 席ルールの適用
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

  res.render('success', {
    name,
    date,
    time,
    people,
    seatType
  });
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`予約システムがポート${PORT}で起動しました`);
});
