require('dotenv').config();
const mongoose = require('mongoose');
const { runDailyCoreSavingsSweep } = require('../services/coreSavingsJobs');

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI must be configured to run the Core savings daily job.');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const result = await runDailyCoreSavingsSweep();
    console.log(`Core savings daily sweep completed: ${JSON.stringify(result)}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Core savings daily sweep failed:', error.name, error.message);
  process.exitCode = 1;
});
