const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  millisecondsUntilNextUtcMidnight,
  startCoreSavingsScheduler,
} = require('../services/coreSavingsScheduler');

test('daily sweep scheduler targets the next UTC midnight', () => {
  assert.equal(
    millisecondsUntilNextUtcMidnight(new Date('2026-10-25T23:59:00.000Z')),
    60_000,
  );
  assert.equal(
    millisecondsUntilNextUtcMidnight(new Date('2026-10-25T00:00:00.000Z')),
    24 * 60 * 60 * 1000,
  );
});

test('scheduler runs a startup catch-up and schedules the next UTC sweep', async () => {
  const scheduled = [];
  const sweepDates = [];
  const fixedNow = new Date('2026-10-25T10:00:00.000Z');
  const stop = startCoreSavingsScheduler({
    runSweep: async (date) => {
      sweepDates.push(date);
      return { processed: 2, accrued: 2, matured: 0, unchanged: 0 };
    },
    now: () => fixedNow,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay, unref() {} });
      return scheduled.at(-1);
    },
    logger: { info() {}, error() {} },
  });

  try {
    assert.equal(scheduled[0].delay, 0);
    await scheduled[0].callback();
    assert.equal(sweepDates.length, 1);
    assert.equal(sweepDates[0], fixedNow);
    assert.equal(scheduled[1].delay, millisecondsUntilNextUtcMidnight(fixedNow));
  } finally {
    stop();
  }
});

test('scheduler retries a failed sweep after five minutes', async () => {
  const scheduled = [];
  let attempts = 0;
  const stop = startCoreSavingsScheduler({
    runSweep: async () => {
      attempts += 1;
      throw new Error('database unavailable');
    },
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay, unref() {} });
      return scheduled.at(-1);
    },
    logger: { info() {}, error() {} },
  });

  try {
    await scheduled[0].callback();
    assert.equal(attempts, 1);
    assert.equal(scheduled[1].delay, 5 * 60 * 1000);
  } finally {
    stop();
  }
});
