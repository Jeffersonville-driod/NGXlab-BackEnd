const accountSetupBalanceNgn = 10_000_000;

async function applyAccountSetup(users, user) {
  if (user.accountSetupAppliedAt) {
    return user;
  }

  const cscsNumber = typeof user.cscsNumber === 'string' && user.cscsNumber.length > 0
    ? user.cscsNumber
    : user.simulatedInvestorIds?.cscs;
  const chnNumber = typeof user.chnNumber === 'string' && user.chnNumber.length > 0
    ? user.chnNumber
    : user.simulatedInvestorIds?.chn;

  if (typeof cscsNumber !== 'string' || typeof chnNumber !== 'string') {
    throw new Error('Account must have simulated CSCS and CHN identifiers before setup');
  }

  await users.updateOne(
    {
      _id: user._id,
      accountSetupAppliedAt: { $exists: false }
    },
    {
      $set: {
        cscsNumber,
        chnNumber,
        virtualBalanceNgn: accountSetupBalanceNgn,
        accountSetupAppliedAt: new Date()
      }
    }
  );

  const updatedUser = await users.findOne({ _id: user._id });
  if (!updatedUser) {
    throw new Error('Account could not be found after setup');
  }

  return updatedUser;
}

module.exports = { applyAccountSetup };
