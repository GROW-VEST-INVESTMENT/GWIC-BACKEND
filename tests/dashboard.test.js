const assert = require('node:assert/strict');
const { test } = require('node:test');
const SavingsGoal = require('../models/SavingsGoal');
const { createSavingsGoal, getDashboard } = require('../controllers/dashboardController');

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
}

test('savings goal creation stores the date and planning-only contribution settings', async () => {
  const originalCreate = SavingsGoal.create;
  let createdGoal;
  SavingsGoal.create = async (goal) => {
    createdGoal = {
      ...goal,
      id: 'goal-1',
      savedAmount: 0,
    };
    return createdGoal;
  };

  const response = makeResponse();
  try {
    await createSavingsGoal(
      {
        user: { id: 'user-1' },
        body: {
          name: '  Emergency Fund  ',
          targetAmount: 500000,
          targetDate: '2099-12-31',
          planDurationDays: 90,
          plannedContributionAmount: 25000,
          plannedContributionFrequency: 'weekly',
        },
      },
      response,
      (error) => { throw error; },
    );
  } finally {
    SavingsGoal.create = originalCreate;
  }

  assert.equal(response.statusCode, 201);
  assert.equal(createdGoal.userId, 'user-1');
  assert.equal(createdGoal.name, 'Emergency Fund');
  assert.equal(createdGoal.targetAmount, 500000);
  assert.equal(createdGoal.targetDate.toISOString(), '2099-12-31T00:00:00.000Z');
  assert.equal(createdGoal.planDurationDays, 90);
  assert.equal(createdGoal.plannedContributionAmount, 25000);
  assert.equal(createdGoal.plannedContributionFrequency, 'weekly');
  assert.equal(response.body.goal.savedAmount, 0);
});

test('savings goal creation rejects invalid dates, timelines, and planned contributions', async () => {
  const invalidBodies = [
    { name: 'Goal', targetAmount: 10000, targetDate: '2099-02-30', planDurationDays: 30 },
    { name: 'Goal', targetAmount: 10000, targetDate: '2099-12-31', planDurationDays: 45 },
    {
      name: 'Goal',
      targetAmount: 10000,
      targetDate: '2099-12-31',
      planDurationDays: 30,
      plannedContributionAmount: 12000,
      plannedContributionFrequency: 'weekly',
    },
  ];

  for (const body of invalidBodies) {
    const response = makeResponse();
    await createSavingsGoal(
      { user: { id: 'user-1' }, body },
      response,
      (error) => { throw error; },
    );
    assert.equal(response.statusCode, 400);
  }
});

test('legacy savings goal requests remain accepted without optional planning fields', async () => {
  const originalCreate = SavingsGoal.create;
  let createdGoal;
  SavingsGoal.create = async (goal) => {
    createdGoal = { ...goal, id: 'goal-legacy', savedAmount: 0 };
    return createdGoal;
  };
  const response = makeResponse();

  try {
    await createSavingsGoal(
      { user: { id: 'user-1' }, body: { name: 'Holiday', targetAmount: 100000 } },
      response,
      (error) => { throw error; },
    );
  } finally {
    SavingsGoal.create = originalCreate;
  }

  assert.equal(response.statusCode, 201);
  assert.equal(createdGoal.targetDate, null);
  assert.equal(createdGoal.planDurationDays, null);
  assert.equal(createdGoal.plannedContributionAmount, null);
  assert.equal(createdGoal.plannedContributionFrequency, null);
});

test('dashboard returns saved goal planning details', async () => {
  const originalFind = SavingsGoal.find;
  SavingsGoal.find = () => ({
    sort() {
      return this;
    },
    lean: async () => [{
      _id: { toString: () => 'goal-1' },
      name: 'Emergency Fund',
      targetAmount: 500000,
      targetDate: new Date('2099-12-31T00:00:00.000Z'),
      planDurationDays: 90,
      plannedContributionAmount: 25000,
      plannedContributionFrequency: 'weekly',
      savedAmount: 0,
    }],
  });
  const response = makeResponse();
  try {
    await getDashboard({
      user: {
        id: 'user-1',
        name: 'Ada Example',
        email: 'ada@example.com',
        phone: '+2348000000000',
        isKycVerified: true,
      },
    }, response, (error) => { throw error; });
  } finally {
    SavingsGoal.find = originalFind;
  }

  assert.equal(response.body.savingsGoals[0].targetDate.toISOString(), '2099-12-31T00:00:00.000Z');
  assert.equal(response.body.savingsGoals[0].planDurationDays, 90);
  assert.equal(response.body.savingsGoals[0].plannedContributionAmount, 25000);
  assert.equal(response.body.savingsGoals[0].plannedContributionFrequency, 'weekly');
  assert.equal(response.body.user.phone, '+2348000000000');
  assert.equal(response.body.user.isKycVerified, true);
});
