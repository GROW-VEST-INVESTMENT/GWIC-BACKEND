const PAYOUT_TIMEZONE = 'Africa/Lagos';
const PAYOUT_TIMEZONE_LABEL = 'West Africa Time';
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getWeekdayInPayoutTimezone(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: PAYOUT_TIMEZONE,
    weekday: 'short',
  }).format(date);
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  if (index < 0) throw new Error('Unable to determine the payout weekday.');
  return index;
}

function isPayoutDay(payoutDays, date = new Date()) {
  return Array.isArray(payoutDays) && payoutDays.includes(getWeekdayInPayoutTimezone(date));
}

function payoutDayNames(payoutDays) {
  return payoutDays
    .filter((day) => Number.isInteger(day) && day >= 0 && day < WEEKDAY_NAMES.length)
    .map((day) => WEEKDAY_NAMES[day]);
}

module.exports = {
  PAYOUT_TIMEZONE,
  PAYOUT_TIMEZONE_LABEL,
  WEEKDAY_NAMES,
  getWeekdayInPayoutTimezone,
  isPayoutDay,
  payoutDayNames,
};
