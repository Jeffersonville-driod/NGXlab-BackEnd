const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ObjectId } = require('mongodb');
const { publicUser, sendWelcomeEmail } = require('../lib/auth-router');
const {
  insertUserWithSimulatedInvestorIds,
  provisionSimulatedInvestorIds
} = require('../lib/simulated-investor-ids');

function createUsersCollection(initialUsers = []) {
  const records = [...initialUsers];

  function getValue(document, path) {
    return path.split('.').reduce((value, key) => value?.[key], document);
  }

  function matches(document, filter) {
    return Object.entries(filter).every(([path, expected]) => {
      if (expected && typeof expected === 'object' && '$in' in expected) {
        const value = getValue(document, path);
        return expected.$in.includes(value ?? null);
      }
      const actual = getValue(document, path);
      return actual === expected || expected?.equals?.(actual) === true;
    });
  }

  function assertUnique(candidate, ignoredId) {
    for (const field of ['simulatedInvestorIds.cscs', 'simulatedInvestorIds.chn']) {
      const value = getValue(candidate, field);
      if (value && records.some((record) => (
        record._id !== ignoredId && getValue(record, field) === value
      ))) {
        const error = new Error('duplicate simulated investor identifier');
        error.code = 11000;
        error.keyPattern = { [field]: 1 };
        throw error;
      }
    }
  }

  return {
    records,
    async findOne(filter) {
      return records.find((record) => matches(record, filter)) || null;
    },
    async insertOne(document) {
      assertUnique(document);
      document._id = document._id || new ObjectId();
      records.push(document);
      return { insertedId: document._id };
    },
    async updateOne(filter, update) {
      const record = records.find((candidate) => matches(candidate, filter));
      if (!record) {
        return { matchedCount: 0 };
      }
      const candidate = structuredClone(record);
      candidate._id = record._id;
      for (const [path, value] of Object.entries(update.$set)) {
        const parts = path.split('.');
        const field = parts.pop();
        let parent = candidate;
        for (const part of parts) {
          parent[part] = parent[part] || {};
          parent = parent[part];
        }
        parent[field] = value;
      }
      assertUnique(candidate, record._id);
      Object.assign(record, candidate);
      return { matchedCount: 1 };
    }
  };
}

test('new accounts receive fictional identifiers from the server', async () => {
  const users = createUsersCollection();
  const user = await insertUserWithSimulatedInvestorIds(users, {
    email: 'new@example.com'
  });

  assert.match(user.simulatedInvestorIds.cscs, /^DEMO-CSCS-[0-9a-f]{16}$/);
  assert.match(user.simulatedInvestorIds.chn, /^DEMO-CHN-[0-9a-f]{16}$/);
  assert.equal(user.cscsNumber, user.simulatedInvestorIds.cscs);
  assert.equal(user.chnNumber, user.simulatedInvestorIds.chn);
});

test('existing accounts are provisioned once and retain stable identifiers', async () => {
  const user = { _id: new ObjectId(), email: 'existing@example.com' };
  const users = createUsersCollection([user]);

  const provisioned = await provisionSimulatedInvestorIds(users, user._id);
  const again = await provisionSimulatedInvestorIds(users, user._id);

  assert.deepEqual(again.simulatedInvestorIds, provisioned.simulatedInvestorIds);
});

test('provisioning a partial record preserves the identifier that already exists', async () => {
  const cscs = 'DEMO-CSCS-0123456789abcdef';
  const user = {
    _id: new ObjectId(),
    simulatedInvestorIds: { cscs }
  };
  const users = createUsersCollection([user]);

  const provisioned = await provisionSimulatedInvestorIds(users, user._id);
  assert.equal(provisioned.simulatedInvestorIds.cscs, cscs);
  assert.match(provisioned.simulatedInvestorIds.chn, /^DEMO-CHN-[0-9a-f]{16}$/);
});

test('concurrent provisioning assigns one stable pair per account', async () => {
  const user = { _id: new ObjectId(), email: 'concurrent@example.com' };
  const users = createUsersCollection([user]);

  const results = await Promise.all([
    provisionSimulatedInvestorIds(users, user._id),
    provisionSimulatedInvestorIds(users, user._id),
    provisionSimulatedInvestorIds(users, user._id)
  ]);
  assert.ok(results.every((result) => (
    result.simulatedInvestorIds.cscs === results[0].simulatedInvestorIds.cscs
    && result.simulatedInvestorIds.chn === results[0].simulatedInvestorIds.chn
  )));
});

test('concurrent account creation keeps both identifier values unique', async () => {
  const users = createUsersCollection();
  const [first, second] = await Promise.all([
    insertUserWithSimulatedInvestorIds(users, { email: 'parallel-1@example.com' }),
    insertUserWithSimulatedInvestorIds(users, { email: 'parallel-2@example.com' })
  ]);
  assert.notEqual(first.simulatedInvestorIds.cscs, second.simulatedInvestorIds.cscs);
  assert.notEqual(first.simulatedInvestorIds.chn, second.simulatedInvestorIds.chn);
});

test('account creation retries a database-rejected identifier collision', async () => {
  const duplicateIds = {
    cscs: 'DEMO-CSCS-0000000000000000',
    chn: 'DEMO-CHN-0000000000000000'
  };
  const users = createUsersCollection([{
    _id: new ObjectId(),
    email: 'existing-id@example.com',
    simulatedInvestorIds: duplicateIds
  }]);
  const originalRandomBytes = crypto.randomBytes;
  let calls = 0;
  crypto.randomBytes = (size) => {
    calls += 1;
    if (calls <= 2) {
      return Buffer.alloc(size);
    }
    return Buffer.from(calls === 3 ? '1234567890abcdef' : 'fedcba9876543210', 'hex');
  };

  try {
    const user = await insertUserWithSimulatedInvestorIds(users, {
      email: 'retry@example.com'
    });
    assert.equal(calls, 4);
    assert.equal(user.simulatedInvestorIds.cscs, 'DEMO-CSCS-1234567890abcdef');
    assert.equal(user.simulatedInvestorIds.chn, 'DEMO-CHN-fedcba9876543210');
    assert.equal(user.cscsNumber, user.simulatedInvestorIds.cscs);
    assert.equal(user.chnNumber, user.simulatedInvestorIds.chn);
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
});

test('each account receives unique identifiers', async () => {
  const users = createUsersCollection();
  const first = await insertUserWithSimulatedInvestorIds(users, { email: 'first@example.com' });
  const second = await insertUserWithSimulatedInvestorIds(users, { email: 'second@example.com' });

  assert.notEqual(first.simulatedInvestorIds.cscs, second.simulatedInvestorIds.cscs);
  assert.notEqual(first.simulatedInvestorIds.chn, second.simulatedInvestorIds.chn);
});

test('authenticated user output contains only the simulated IDs, not account secrets', () => {
  const response = publicUser({
    _id: new ObjectId(),
    name: 'Learner',
    email: 'learner@example.com',
    cscsNumber: '0001234567',
    chnNumber: '0000987654',
    passwordHash: 'private-hash',
    googleSub: 'private-google-id',
    simulatedInvestorIds: {
      cscs: 'DEMO-CSCS-0123456789abcdef',
      chn: 'DEMO-CHN-fedcba9876543210',
      internal: 'must-not-be-returned'
    }
  });

  assert.deepEqual(response.simulatedInvestorIds, {
    cscs: 'DEMO-CSCS-0123456789abcdef',
    chn: 'DEMO-CHN-fedcba9876543210'
  });
  assert.equal(response.cscsNumber, '0001234567');
  assert.equal(response.chnNumber, '0000987654');
  assert.equal(JSON.stringify(response).includes('private-hash'), false);
  assert.equal(JSON.stringify(response).includes('private-google-id'), false);
  assert.equal(JSON.stringify(response).includes('must-not-be-returned'), false);
});

test('authenticated user output uses null for missing or non-string profile numbers', () => {
  const response = publicUser({
    _id: new ObjectId(),
    name: 'Learner',
    email: 'learner@example.com',
    cscsNumber: 123456,
    simulatedInvestorIds: {
      cscs: 'DEMO-CSCS-0123456789abcdef',
      chn: 'DEMO-CHN-fedcba9876543210'
    }
  });

  assert.equal(response.cscsNumber, null);
  assert.equal(response.chnNumber, null);
});

test('new-account welcome email includes both simulated IDs and the real-trading disclaimer', async () => {
  const originalFetch = global.fetch;
  const originalConfiguration = {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM_EMAIL,
    apiUrl: process.env.RESEND_API_URL
  };
  let emailPayload;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM_EMAIL = 'NGXLab <test@example.com>';
  process.env.RESEND_API_URL = 'https://email.example.test/send';
  global.fetch = async (url, options) => {
    assert.equal(url, process.env.RESEND_API_URL);
    emailPayload = JSON.parse(options.body);
    return { ok: true };
  };

  try {
    await sendWelcomeEmail({
      name: 'New learner',
      email: 'learner@example.com',
      simulatedInvestorIds: {
        cscs: 'DEMO-CSCS-0123456789abcdef',
        chn: 'DEMO-CHN-fedcba9876543210'
      }
    });

    for (const content of [emailPayload.text, emailPayload.html]) {
      assert.match(content, /DEMO-CSCS-0123456789abcdef/);
      assert.match(content, /DEMO-CHN-fedcba9876543210/);
      assert.match(content, /Simulated — not valid for real trading\./);
    }
    assert.match(emailPayload.html, /brokerage, settlement, or securities transfers/);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      RESEND_API_KEY: originalConfiguration.apiKey,
      RESEND_FROM_EMAIL: originalConfiguration.from,
      RESEND_API_URL: originalConfiguration.apiUrl
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
