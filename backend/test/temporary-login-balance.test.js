const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { applyTemporaryLoginBalance } = require('../lib/temporary-login-balance');

function createUsersCollection(records) {
  function matches(record, filter) {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') {
        return value.some((condition) => matches(record, condition));
      }
      if (key === '_id') {
        return record._id.equals(value);
      }
      return record[key] === value || (value === null && record[key] === undefined);
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

test('configured account receives ten million once when its zero-balance account logs in', async () => {
  const original = process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL;
  process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL = 'target@example.com';
  const user = {
    _id: new ObjectId(),
    email: 'target@example.com',
    virtualBalanceNgn: 0
  };
  const users = createUsersCollection([user]);

  try {
    const updated = await applyTemporaryLoginBalance(users, user);
    const onLaterLogin = await applyTemporaryLoginBalance(users, updated);
    assert.equal(updated.virtualBalanceNgn, 10_000_000);
    assert.equal(onLaterLogin.virtualBalanceNgn, 10_000_000);
  } finally {
    if (original === undefined) {
      delete process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL;
    } else {
      process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL = original;
    }
  }
});

test('temporary login adjustment leaves other accounts and nonzero balances unchanged', async () => {
  const original = process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL;
  process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL = 'target@example.com';
  const target = {
    _id: new ObjectId(),
    email: 'target@example.com',
    virtualBalanceNgn: 250
  };
  const other = {
    _id: new ObjectId(),
    email: 'other@example.com',
    virtualBalanceNgn: 0
  };
  const users = createUsersCollection([target, other]);

  try {
    assert.equal((await applyTemporaryLoginBalance(users, target)).virtualBalanceNgn, 250);
    assert.equal((await applyTemporaryLoginBalance(users, other)).virtualBalanceNgn, 0);
  } finally {
    if (original === undefined) {
      delete process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL;
    } else {
      process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL = original;
    }
  }
});
