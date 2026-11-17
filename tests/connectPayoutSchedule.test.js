const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getWeekdayInPayoutTimezone,
  isPayoutDay,
  payoutDayNames,
} = require('../services/connectPayoutSchedule');

test('payout weekdays are evaluated in West Africa Time at the midnight boundary', () => {
  assert.equal(getWeekdayInPayoutTimezone(new Date('2026-11-15T22:59:59.000Z')), 0);
  assert.equal(getWeekdayInPayoutTimezone(new Date('2026-11-15T23:00:00.000Z')), 1);
  assert.equal(isPayoutDay([1], new Date('2026-11-15T23:00:00.000Z')), true);
  assert.equal(isPayoutDay([1], new Date('2026-11-15T22:59:59.000Z')), false);
});

test('payout schedule names remain in weekday order', () => {
  assert.deepEqual(payoutDayNames([1, 4, 6]), ['Monday', 'Thursday', 'Saturday']);
});
