const temporaryBalanceNgn = 10_000_000;

async function applyTemporaryLoginBalance(users, user) {
  const targetEmail = (process.env.TEMPORARY_VIRTUAL_BALANCE_EMAIL || '')
    .trim()
    .toLowerCase();
  if (!targetEmail || user.email?.trim().toLowerCase() !== targetEmail) {
    return user;
  }

  await users.updateOne(
    {
      _id: user._id,
      $or: [
        { virtualBalanceNgn: 0 },
        { virtualBalanceNgn: null }
      ]
    },
    { $set: { virtualBalanceNgn: temporaryBalanceNgn } }
  );
  return users.findOne({ _id: user._id });
}

module.exports = { applyTemporaryLoginBalance };
