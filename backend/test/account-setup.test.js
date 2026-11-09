const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { applyAccountSetup } = require('../lib/account-setup');

function createUsersCollection(records) {
  function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && '$exists' in expected) {
        return (record[key] !== undefined) === expected.$exists;
      }
      if (key === '_id') {
        return record._id.equals(expected);
      }
      return record[key] === expected;
    });
  }

  return {
    async updateOne(filter, update) {
      const record = records.find((item) => matches(item, filter));
      if (!record) {
        return { matchedCount: 0 };
      }
      Object.assign(record, update.$set);
      return { matchedCount: 1 };
    },
    async findOne(filter) {
      return records.find((record) => matches(record, filter)) || null;
    }
  };
}

test('existing account receives simulated numbers and ten million once on login setup', async () => {
  const user = {
    _id: new ObjectId(),
    email: 'target@gmail.com',
    virtualBalanceNgn: 1_000_000,
    simulatedInvestorIds: {
      cscs: 'DEMO-CSCS-0123456789abcdef',
      chn: 'DEMO-CHN-fedcba9876543210'
    }
  };
  const users = createUsersCollection([user]);

  const updated = await applyAccountSetup(users, user);
  assert.equal(updated.virtualBalanceNgn, 10_000_000);
  assert.ok(updated.accountSetupAppliedAt instanceof Date);
  updated.virtualBalanceNgn = 3_000_000;
  const onLaterLogin = await applyAccountSetup(users, updated);

  assert.equal(onLaterLogin.cscsNumber, 'DEMO-CSCS-0123456789abcdef');
  assert.equal(onLaterLogin.chnNumber, 'DEMO-CHN-fedcba9876543210');
  assert.equal(onLaterLogin.virtualBalanceNgn, 3_000_000);
});

test('account setup preserves existing string numbers', async () => {
  const user = {
    _id: new ObjectId(),
    email: 'target@gmail.com',
    cscsNumber: '000123',
    chnNumber: '000456',
    simulatedInvestorIds: {
      cscs: 'DEMO-CSCS-0123456789abcdef',
      chn: 'DEMO-CHN-fedcba9876543210'
    }
  };
  const users = createUsersCollection([user]);

  const updated = await applyAccountSetup(users, user);
  assert.equal(updated.cscsNumber, '000123');
  assert.equal(updated.chnNumber, '000456');
  assert.equal(updated.virtualBalanceNgn, 10_000_000);
});
