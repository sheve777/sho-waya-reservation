const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const weekday = require('dayjs/plugin/weekday');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
const isHoliday = require('japanese-holidays');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

dayjs.extend(weekday);
dayjs.extend(isSameOrAfter);

// Google Calendar 認証
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json',
  scopes: ['https://www.googleapis.com/auth/calendar']
});
const calendar = google.calendar({ version: 'v3', auth });
const calendarId = process.env.GOOGLE_CALENDAR_ID;

// shop-config を読み込み
const shopConfig = JSON.parse(fs.readFileSync('shop-config.json', 'utf-8'));

// 定休日（日曜＋祝日）チェック
function isClosed(date) {
  return date.day() === 0 || isHoliday.isHoliday(date.toDate());
}

// 30分刻みの時間スロット（〜22:00まで予約可能に調整）
function generateSlots(date) {
  const slots = [];
  let time = date.hour(17).minute(0);
  const end = date.hour(22).minute(0).add(1, 'minute');
  while (time.isBefore(end)) {
    slots.push(time.format('HH:mm'));
    time = time.add(30, 'minute');
  }
  return slots;
}

// スロットごとの予約数をチェックし、空き枠のみ返す
async function getAvailableSlots(dateStr) {
  const date = dayjs(dateStr);
  const events = await calendar.events.list({
    calendarId,
    timeMin: date.hour(0).minute(0).toISOString(),
    timeMax: date.hour(23).minute(59).toISOString(),
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

// 日付選択ページ
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

// 時間スロット選択ページ
app.get('/day/:date', async (req, res) => {
  const { date } = req.params;
  const slots = await getAvailableSlots(date);
  res.render('slots', { date, slots });
});

// 予約処理
app.post('/reserve', async (req, res) => {
  const { date, time, name, guests, seatType } = req.body;
  const guestCount = parseInt(guests, 10);

  if (!name || !guestCount || guestCount < 1 || guestCount > 8) {
    return res.send('無効な予約内容です。人数は1〜8名で指定してください。');
  }

  const seatRules = {
    maxGuests: 8,
    tableMinGuests: shopConfig.rules?.tableMinGuests || 3,
    counterMaxGuests: shopConfig.rules?.counterMaxGuests || 2
  };

  if (seatType === 'table' && guestCount < seatRules.tableMinGuests) {
    return res.send(`テーブル席は${seatRules.tableMinGuests}名以上からご予約いただけます。`);
  }

  if (seatType === 'counter' && guestCount > seatRules.counterMaxGuests) {
    return res.send(`カウンター席は${seatRules.counterMaxGuests}名以下までのご予約となります。`);
  }

  const start = dayjs(`${date}T${time}`);
  const end = start.add(30, 'minute');

  let seatNote = seatType;
  if (seatType === 'table' && guestCount >= 5) {
    seatNote = 'テーブル2席（8席分）確保';
  }

  try {
    await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: `笑わ家予約 - ${name}様（${guestCount}名）`,
        description: `席タイプ：${seatType}／対応：${seatNote}`,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() }
      }
    });

    res.send(`ご予約ありがとうございます！\n${date} ${time} に ${guestCount}名様で予約を承りました。`);
  } catch (err) {
    console.error('予約エラー:', err);
    res.send('予約中にエラーが発生しました。時間をおいて再試行してください。');
  }
});

// 起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`予約システムがポート${PORT}で起動しました`);
});
