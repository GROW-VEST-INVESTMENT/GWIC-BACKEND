const { runDailyCoreSavingsSweep } = require('./coreSavingsJobs');

const RETRY_DELAY_MS = 5 * 60 * 1000;

function millisecondsUntilNextUtcMidnight(now = new Date()) {
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  return Math.max(1, nextMidnight.getTime() - now.getTime());
}

function startCoreSavingsScheduler({
  runSweep = runDailyCoreSavingsSweep,
  now = () => new Date(),
  schedule = setTimeout,
  logger = console,
} = {}) {
  let stopped = false;
  let timer;

  async function runAndScheduleNext(delay) {
    if (stopped) return;
    timer = schedule(async () => {
      try {
        const result = await runSweep(now());
        logger.info(`Core savings daily sweep completed: ${JSON.stringify(result)}`);
        await runAndScheduleNext(millisecondsUntilNextUtcMidnight(now()));
      } catch (error) {
        logger.error('Core savings daily sweep failed:', error.name, error.message);
        await runAndScheduleNext(RETRY_DELAY_MS);
      }
    }, delay);
    timer.unref?.();
  }

  void runAndScheduleNext(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = {
  millisecondsUntilNextUtcMidnight,
  startCoreSavingsScheduler,
};
