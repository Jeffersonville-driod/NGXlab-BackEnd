const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePerformance,
  contestStatus,
  isEligible,
  validateContest,
  validateTrade
} = require('../lib/contest-router');

function contest(overrides = {}) {
  return validateContest({
    _id: 'demo-contest',
    title: 'Demo contest',
    startsAt: new Date('2026-11-10T00:00:00Z'),
    endsAt: new Date('2026-11-20T00:00:00Z'),
    startingBalanceNgn: 1_000_000,
    rules: ['Trades are simulated only.'],
    ...overrides
  });
}

test('contest status follows configured start and end dates', () => {
  const record = contest();
  assert.equal(contestStatus(record, new Date('2026-11-09T23:59:59Z')), 'upcoming');
  assert.equal(contestStatus(record, new Date('2026-11-10T00:00:00Z')), 'active');
  assert.equal(contestStatus(record, new Date('2026-11-20T00:00:00Z')), 'completed');
});

test('invalid contest dates and balances are rejected', () => {
  assert.throws(() => contest({ endsAt: new Date('2026-11-09T00:00:00Z') }), {
    code: 'CONTEST_CONFIGURATION_INVALID'
  });
  assert.throws(() => contest({ startingBalanceNgn: 0 }), {
    code: 'CONTEST_CONFIGURATION_INVALID'
  });
});

test('eligibility can restrict accounts by ID and account age', () => {
  const record = contest({
    eligibility: { allowedUserIds: ['allowed-id'], minimumAccountAgeDays: 2 }
  });
  const user = {
    _id: { toString: () => 'allowed-id' },
    createdAt: new Date('2026-11-01T00:00:00Z')
  };
  assert.equal(isEligible(user, record, new Date('2026-11-10T00:00:00Z')), true);
  assert.equal(isEligible({ ...user, _id: { toString: () => 'other-id' } }, record), false);
  assert.equal(isEligible({ ...user, createdAt: new Date('2026-11-09T00:00:00Z') }, record), false);
});

test('trade validation accepts only client order inputs', () => {
  assert.deepEqual(validateTrade({ symbol: 'dangsugar', side: 'buy', quantity: 2 }), {
    symbol: 'DANGSUGAR',
    side: 'BUY',
    quantity: 2
  });
  assert.throws(() => validateTrade({
    symbol: 'DANGSUGAR',
    side: 'BUY',
    quantity: 2,
    price: 1
  }), { code: 'INVALID_TRADE' });
});

test('portfolio performance is calculated from stored cash, holdings, and quote', () => {
  const performance = calculatePerformance({
    virtualBalanceNgn: 999_350,
    holdings: [{
      symbol: 'DANGSUGAR',
      name: 'Dangote Sugar',
      quantity: 10,
      averagePrice: 65
    }]
  }, 1_000_000, [{ symbol: 'DANGSUGAR', current_price: 70 }]);

  assert.equal(performance.portfolioValueNgn, 1_000_050);
  assert.equal(performance.returnNgn, 50);
  assert.equal(performance.returnPercent, 0.005);
});

test('missing market quotes leave the result unranked rather than using client values', () => {
  const performance = calculatePerformance({
    virtualBalanceNgn: 999_350,
    holdings: [{ symbol: 'DANGSUGAR', quantity: 10, averagePrice: 65 }]
  }, 1_000_000, []);

  assert.equal(performance.portfolioValueNgn, null);
  assert.equal(performance.returnPercent, null);
  assert.equal(performance.holdings[0].marketValueNgn, null);
});
