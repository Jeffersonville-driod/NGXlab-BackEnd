const crypto = require('node:crypto');

const maxAttempts = 5;
const cscsPattern = /^DEMO-CSCS-[0-9a-f]{16}$/;
const chnPattern = /^DEMO-CHN-[0-9a-f]{16}$/;

function generateSimulatedInvestorIds() {
  const suffix = () => crypto.randomBytes(8).toString('hex');
  return {
    cscs: `DEMO-CSCS-${suffix()}`,
    chn: `DEMO-CHN-${suffix()}`
  };
}

function isDuplicateInvestorIdError(error) {
  const fields = Object.keys(error.keyPattern || {});
  return error.code === 11000 && fields.some((field) => (
    field === 'simulatedInvestorIds.cscs'
    || field === 'simulatedInvestorIds.chn'
  ));
}

async function provisionSimulatedInvestorIds(users, userId) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const user = await users.findOne({ _id: userId });
    if (!user) {
      const error = new Error('Account could not be found while provisioning simulated investor IDs');
      error.statusCode = 401;
      error.code = 'UNAUTHENTICATED';
      throw error;
    }

    const currentIds = user.simulatedInvestorIds || {};
    const missingCscs = !cscsPattern.test(currentIds.cscs || '');
    const missingChn = !chnPattern.test(currentIds.chn || '');
    if (!missingCscs && !missingChn) {
      return user;
    }

    const generated = generateSimulatedInvestorIds();
    const filter = { _id: userId };
    if (missingCscs) {
      filter['simulatedInvestorIds.cscs'] = currentIds.cscs == null
        ? { $in: [null] }
        : currentIds.cscs;
    } else {
      filter['simulatedInvestorIds.cscs'] = currentIds.cscs;
    }
    if (missingChn) {
      filter['simulatedInvestorIds.chn'] = currentIds.chn == null
        ? { $in: [null] }
        : currentIds.chn;
    } else {
      filter['simulatedInvestorIds.chn'] = currentIds.chn;
    }

    const idsToSet = {};
    if (missingCscs) {
      idsToSet['simulatedInvestorIds.cscs'] = generated.cscs;
    }
    if (missingChn) {
      idsToSet['simulatedInvestorIds.chn'] = generated.chn;
    }

    try {
      const result = await users.updateOne(filter, { $set: idsToSet });
      if (result.matchedCount === 1) {
        return await users.findOne({ _id: userId });
      }
    } catch (error) {
      if (!isDuplicateInvestorIdError(error)) {
        throw error;
      }
    }
  }

  const error = new Error('Could not provision unique simulated investor IDs after several attempts');
  error.statusCode = 503;
  error.code = 'SIMULATED_INVESTOR_IDS_UNAVAILABLE';
  throw error;
}

async function insertUserWithSimulatedInvestorIds(users, user) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const previousIds = user.simulatedInvestorIds || {};
    user.simulatedInvestorIds = generateSimulatedInvestorIds();
    if (user.cscsNumber == null || user.cscsNumber === previousIds.cscs) {
      user.cscsNumber = user.simulatedInvestorIds.cscs;
    }
    if (user.chnNumber == null || user.chnNumber === previousIds.chn) {
      user.chnNumber = user.simulatedInvestorIds.chn;
    }
    try {
      const result = await users.insertOne(user);
      user._id = result.insertedId;
      return user;
    } catch (error) {
      if (!isDuplicateInvestorIdError(error)) {
        throw error;
      }
    }
  }

  const error = new Error('Could not assign unique simulated investor IDs after several attempts');
  error.statusCode = 503;
  error.code = 'SIMULATED_INVESTOR_IDS_UNAVAILABLE';
  throw error;
}

module.exports = {
  generateSimulatedInvestorIds,
  insertUserWithSimulatedInvestorIds,
  provisionSimulatedInvestorIds
};
