const crypto = require('node:crypto');
const express = require('express');
const { getAuthCollections } = require('./auth-database');
const { requireSession } = require('./session-auth');

const router = express.Router();
const contestIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const tradeHistoryLimit = 100;

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function roundNaira(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundPercent(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function validateContestId(value) {
  if (typeof value !== 'string' || !contestIdPattern.test(value)) {
    throw new HttpError(400, 'INVALID_CONTEST_ID', 'Contest ID must be a lowercase slug');
  }
  return value;
}

function contestStatus(contest, now = new Date()) {
  if (contest.startsAt > now) {
    return 'upcoming';
  }
  if (contest.endsAt <= now) {
    return 'completed';
  }
  return 'active';
}

function validateContest(contest) {
  const startsAt = contest?.startsAt instanceof Date
    ? contest.startsAt
    : new Date(contest?.startsAt);
  const endsAt = contest?.endsAt instanceof Date
    ? contest.endsAt
    : new Date(contest?.endsAt);

  if (
    typeof contest?._id !== 'string'
    || !contestIdPattern.test(contest._id)
    || typeof contest.title !== 'string'
    || !contest.title.trim()
    || contest.title.length > 120
    || contest.startsAt === undefined
    || contest.startsAt === null
    || contest.endsAt === undefined
    || contest.endsAt === null
    || (contest.description !== undefined
      && (typeof contest.description !== 'string' || contest.description.length > 1000))
    || !Number.isFinite(startsAt.getTime())
    || !Number.isFinite(endsAt.getTime())
    || startsAt >= endsAt
    || !Number.isSafeInteger(contest.startingBalanceNgn)
    || contest.startingBalanceNgn <= 0
    || !Array.isArray(contest.rules)
    || contest.rules.length === 0
    || contest.rules.some((rule) => typeof rule !== 'string' || !rule.trim() || rule.length > 500)
  ) {
    throw new HttpError(503, 'CONTEST_CONFIGURATION_INVALID', 'Contest configuration is invalid');
  }

  if (
    contest.maxParticipants !== undefined
    && (!Number.isSafeInteger(contest.maxParticipants) || contest.maxParticipants <= 0)
  ) {
    throw new HttpError(503, 'CONTEST_CONFIGURATION_INVALID', 'Contest configuration is invalid');
  }

  const eligibility = contest.eligibility || {};
  if (
    (typeof eligibility !== 'object' || Array.isArray(eligibility))
    ||
    (eligibility.description !== undefined
      && (typeof eligibility.description !== 'string' || eligibility.description.length > 500))
    ||
    (eligibility.allowedUserIds !== undefined
      && (!Array.isArray(eligibility.allowedUserIds)
        || eligibility.allowedUserIds.some((id) => typeof id !== 'string')))
    || (eligibility.minimumAccountAgeDays !== undefined
      && (!Number.isSafeInteger(eligibility.minimumAccountAgeDays)
        || eligibility.minimumAccountAgeDays < 0))
  ) {
    throw new HttpError(503, 'CONTEST_CONFIGURATION_INVALID', 'Contest configuration is invalid');
  }

  return {
    ...contest,
    startsAt,
    endsAt,
    eligibility
  };
}

function isEligible(user, contest, now = new Date()) {
  const allowedUserIds = contest.eligibility.allowedUserIds;
  if (allowedUserIds && !allowedUserIds.includes(user._id.toString())) {
    return false;
  }

  const minimumAge = contest.eligibility.minimumAccountAgeDays;
  if (minimumAge !== undefined) {
    const createdAt = new Date(user.createdAt);
    if (
      !Number.isFinite(createdAt.getTime())
      || createdAt.getTime() + minimumAge * 24 * 60 * 60 * 1000 > now.getTime()
    ) {
      return false;
    }
  }

  return true;
}

function mapContest(contest, participantCount) {
  return {
    id: contest._id,
    title: contest.title,
    description: contest.description || '',
    rules: contest.rules,
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    status: contestStatus(contest),
    startingBalanceNgn: contest.startingBalanceNgn,
    participantCount,
    maxParticipants: contest.maxParticipants ?? null,
    eligibilityDescription: contest.eligibility?.description || null
  };
}

function validateTrade(body) {
  const allowedKeys = ['symbol', 'side', 'quantity'];
  if (
    !body
    || typeof body !== 'object'
    || Array.isArray(body)
    || Object.keys(body).some((key) => !allowedKeys.includes(key))
  ) {
    throw new HttpError(400, 'INVALID_TRADE', 'Request must contain only symbol, side, and quantity');
  }

  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(symbol)) {
    throw new HttpError(400, 'INVALID_TRADE', 'A valid stock symbol is required');
  }

  const side = typeof body.side === 'string' ? body.side.toUpperCase() : '';
  if (side !== 'BUY' && side !== 'SELL') {
    throw new HttpError(400, 'INVALID_TRADE', 'Side must be BUY or SELL');
  }

  if (!Number.isSafeInteger(body.quantity) || body.quantity <= 0) {
    throw new HttpError(400, 'INVALID_TRADE', 'Quantity must be a positive whole number of shares');
  }

  return { symbol, side, quantity: body.quantity };
}

function calculatePerformance(portfolio, startingBalanceNgn, stocks) {
  let holdingsValueNgn = 0;
  const holdings = (portfolio?.holdings || []).map((holding) => {
    const stock = stocks.find((item) => item.symbol === holding.symbol);
    const currentPrice = Number.isFinite(stock?.current_price) && stock.current_price > 0
      ? stock.current_price
      : null;
    if (currentPrice === null) {
      return {
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        averagePrice: holding.averagePrice,
        currentPrice: null,
        marketValueNgn: null
      };
    }

    const marketValueNgn = roundNaira(currentPrice * holding.quantity);
    holdingsValueNgn += marketValueNgn;
    return {
      symbol: holding.symbol,
      name: holding.name,
      quantity: holding.quantity,
      averagePrice: holding.averagePrice,
      currentPrice,
      marketValueNgn
    };
  });

  const virtualBalanceNgn = portfolio?.virtualBalanceNgn ?? startingBalanceNgn;
  const complete = holdings.every((holding) => holding.currentPrice !== null);
  if (!complete) {
    return { holdings, virtualBalanceNgn, portfolioValueNgn: null, returnNgn: null, returnPercent: null };
  }

  const portfolioValueNgn = roundNaira(virtualBalanceNgn + holdingsValueNgn);
  const returnNgn = roundNaira(portfolioValueNgn - startingBalanceNgn);
  return {
    holdings,
    virtualBalanceNgn,
    portfolioValueNgn,
    returnNgn,
    returnPercent: roundPercent((returnNgn / startingBalanceNgn) * 100)
  };
}

async function getContest(contests, contestId, session) {
  const contest = await contests.findOne({ _id: contestId }, session ? { session } : undefined);
  if (!contest) {
    throw new HttpError(404, 'CONTEST_NOT_FOUND', 'Contest was not found');
  }
  return validateContest(contest);
}

async function getValuationSnapshot(contest, marketSnapshots, marketHistory, session) {
  const options = session ? { session } : undefined;
  if (contestStatus(contest) === 'completed') {
    const archived = await marketHistory.find(
      { refreshedAt: { $lte: contest.endsAt } },
      options
    ).sort({ refreshedAt: -1 }).limit(1).next();
    if (archived) {
      return archived;
    }

    const latest = await marketSnapshots.findOne({ _id: 'latest' }, options);
    if (latest?.refreshedAt && new Date(latest.refreshedAt) <= contest.endsAt) {
      return latest;
    }
    throw new HttpError(
      503,
      'CONTEST_VALUATION_NOT_READY',
      'No stored market snapshot is available for the contest end date'
    );
  }

  const snapshot = await marketSnapshots.findOne({ _id: 'latest' }, options);
  if (!snapshot) {
    throw new HttpError(503, 'MARKET_DATA_NOT_READY', 'Market data has not been collected yet');
  }
  return snapshot;
}

async function getContestView(collections, contest, userId, session) {
  const options = session ? { session } : undefined;
  const participant = await collections.contestParticipants.findOne(
    { contestId: contest._id, userId },
    options
  );
  if (!participant) {
    throw new HttpError(404, 'NOT_JOINED', 'You have not joined this contest');
  }

  const portfolio = await collections.contestPortfolios.findOne(
    { contestId: contest._id, userId },
    options
  );
  const snapshot = await getValuationSnapshot(
    contest,
    collections.marketSnapshots,
    collections.marketHistory,
    session
  );
  const performance = calculatePerformance(
    portfolio,
    contest.startingBalanceNgn,
    snapshot.stocks || []
  );
  const history = await collections.contestTrades.find(
    { contestId: contest._id, userId },
    options
  ).sort({ tradeDate: -1 }).limit(tradeHistoryLimit).toArray();

  return {
    contest: mapContest(
      contest,
      await collections.contestParticipants.countDocuments({ contestId: contest._id }, options)
    ),
    participation: {
      joinedAt: participant.createdAt,
      publicAlias: participant.publicAlias,
      virtualBalanceNgn: performance.virtualBalanceNgn,
      holdings: performance.holdings,
      tradeHistory: history.map((trade) => ({
        id: trade._id.toString(),
        symbol: trade.symbol,
        name: trade.name,
        side: trade.side,
        quantity: trade.quantity,
        price: trade.price,
        total: trade.total,
        tradeDate: trade.tradeDate,
        marketTradeDate: trade.marketTradeDate
      }))
    },
    result: {
      portfolioValueNgn: performance.portfolioValueNgn,
      returnNgn: performance.returnNgn,
      returnPercent: performance.returnPercent,
      valuedAt: snapshot.asOf || snapshot.refreshedAt,
      marketTradeDate: snapshot.tradeDate || null
    }
  };
}

router.use(requireSession);

router.get('/', asyncHandler(async (req, res) => {
  const { contests, contestParticipants } = await getAuthCollections();
  const records = await contests.find({}).sort({ startsAt: 1 }).toArray();
  const list = await Promise.all(records.map(async (record) => {
    const contest = validateContest(record);
    const participantCount = await contestParticipants.countDocuments({ contestId: contest._id });
    return mapContest(contest, participantCount);
  }));
  return res.status(200).json({ success: true, contests: list });
}));

router.get('/me', asyncHandler(async (req, res) => {
  const collections = await getAuthCollections();
  const participations = await collections.contestParticipants
    .find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .toArray();
  const entries = await Promise.all(participations.map(async (participant) => {
    const contest = await getContest(collections.contests, participant.contestId);
    return getContestView(collections, contest, req.user._id);
  }));
  return res.status(200).json({ success: true, participations: entries });
}));

router.get('/:contestId/leaderboard', asyncHandler(async (req, res) => {
  const contestId = validateContestId(req.params.contestId);
  const collections = await getAuthCollections();
  const contest = await getContest(collections.contests, contestId);
  const snapshot = await getValuationSnapshot(
    contest,
    collections.marketSnapshots,
    collections.marketHistory
  );
  const participants = await collections.contestParticipants
    .find({ contestId })
    .toArray();
  const results = await Promise.all(participants.map(async (participant) => {
    const portfolio = await collections.contestPortfolios.findOne({
      contestId,
      userId: participant.userId
    });
    const performance = calculatePerformance(
      portfolio,
      contest.startingBalanceNgn,
      snapshot.stocks || []
    );
    if (performance.returnPercent === null) {
      return null;
    }
    return {
      publicAlias: participant.publicAlias,
      portfolioValueNgn: performance.portfolioValueNgn,
      returnNgn: performance.returnNgn,
      returnPercent: performance.returnPercent,
      joinedAt: participant.createdAt
    };
  }));

  const ranked = results.filter(Boolean).sort((left, right) => (
    right.returnPercent - left.returnPercent
    || left.joinedAt - right.joinedAt
    || left.publicAlias.localeCompare(right.publicAlias)
  ));
  return res.status(200).json({
    success: true,
    contest: mapContest(
      contest,
      await collections.contestParticipants.countDocuments({ contestId })
    ),
    asOf: snapshot.asOf || snapshot.refreshedAt,
    marketTradeDate: snapshot.tradeDate || null,
    unrankedCount: results.length - ranked.length,
    leaderboard: ranked.map(({ publicAlias, portfolioValueNgn, returnNgn, returnPercent }, index) => ({
      rank: index + 1,
      publicAlias,
      portfolioValueNgn,
      returnNgn,
      returnPercent
    }))
  });
}));

router.get('/:contestId/me', asyncHandler(async (req, res) => {
  const contestId = validateContestId(req.params.contestId);
  const collections = await getAuthCollections();
  const contest = await getContest(collections.contests, contestId);
  const view = await getContestView(collections, contest, req.user._id);
  return res.status(200).json({ success: true, ...view });
}));

router.get('/:contestId', asyncHandler(async (req, res) => {
  const contestId = validateContestId(req.params.contestId);
  const { contests, contestParticipants } = await getAuthCollections();
  const contest = await getContest(contests, contestId);
  const participant = await contestParticipants.findOne({
    contestId,
    userId: req.user._id
  });
  return res.status(200).json({
    success: true,
    contest: mapContest(
      contest,
      await contestParticipants.countDocuments({ contestId })
    ),
    participation: participant ? { joined: true, joinedAt: participant.createdAt } : { joined: false },
    eligible: contestStatus(contest) === 'upcoming' && isEligible(req.user, contest)
  });
}));

router.post('/:contestId/join', asyncHandler(async (req, res) => {
  const contestId = validateContestId(req.params.contestId);
  const collections = await getAuthCollections();
  const session = collections.client.startSession();
  let contest;
  let joinedAt;

  try {
    await session.withTransaction(async () => {
      contest = await getContest(collections.contests, contestId, session);
      const now = new Date();
      const alreadyJoined = await collections.contestParticipants.findOne(
        { contestId, userId: req.user._id },
        { session }
      );
      if (alreadyJoined) {
        throw new HttpError(409, 'ALREADY_JOINED', 'You have already joined this contest');
      }
      if (!isEligible(req.user, contest, now)) {
        throw new HttpError(403, 'NOT_ELIGIBLE', 'You are not eligible to join this contest');
      }
      if (contestStatus(contest, now) !== 'upcoming') {
        throw new HttpError(409, 'JOINING_CLOSED', 'This contest is not open for joining');
      }

      const capacity = contest.maxParticipants ?? Number.MAX_SAFE_INTEGER;
      const reserved = await collections.contests.updateOne(
        {
          _id: contestId,
          startsAt: { $gt: now },
          endsAt: { $gt: now },
          $expr: { $lt: [{ $ifNull: ['$participantCount', 0] }, capacity] }
        },
        { $inc: { participantCount: 1 } },
        { session }
      );
      if (reserved.matchedCount !== 1) {
        const latestCount = await collections.contestParticipants.countDocuments(
          { contestId },
          { session }
        );
        if (latestCount >= capacity) {
          throw new HttpError(409, 'CONTEST_FULL', 'This contest has reached its participant limit');
        }
        throw new HttpError(409, 'JOINING_CLOSED', 'This contest is not open for joining');
      }

      joinedAt = new Date();
      const publicAlias = `Learner-${crypto.randomBytes(6).toString('hex')}`;
      await collections.contestParticipants.insertOne({
        contestId,
        userId: req.user._id,
        publicAlias,
        createdAt: joinedAt
      }, { session });
      await collections.contestPortfolios.insertOne({
        contestId,
        userId: req.user._id,
        virtualBalanceNgn: contest.startingBalanceNgn,
        holdings: [],
        createdAt: joinedAt,
        updatedAt: joinedAt
      }, { session });
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } catch (error) {
    if (error.code === 11000) {
      throw new HttpError(409, 'ALREADY_JOINED', 'You have already joined this contest');
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return res.status(201).json({
    success: true,
    participation: {
      contestId,
      joinedAt,
      virtualBalanceNgn: contest.startingBalanceNgn
    }
  });
}));

router.post('/:contestId/trades', asyncHandler(async (req, res) => {
  const contestId = validateContestId(req.params.contestId);
  const input = validateTrade(req.body);
  const collections = await getAuthCollections();
  const session = collections.client.startSession();
  let trade;
  let updatedPortfolio;

  try {
    await session.withTransaction(async () => {
      const contest = await getContest(collections.contests, contestId, session);
      if (contestStatus(contest) !== 'active') {
        throw new HttpError(409, 'CONTEST_NOT_ACTIVE', 'Trades are accepted only while the contest is active');
      }

      const participant = await collections.contestParticipants.findOne(
        { contestId, userId: req.user._id },
        { session }
      );
      if (!participant) {
        throw new HttpError(403, 'NOT_JOINED', 'Join this contest before placing simulated trades');
      }

      const snapshot = await collections.marketSnapshots.findOne({ _id: 'latest' }, { session });
      if (!snapshot) {
        throw new HttpError(503, 'MARKET_DATA_NOT_READY', 'Market data has not been collected yet');
      }
      const stock = snapshot.stocks?.find((item) => item.symbol === input.symbol);
      if (!stock) {
        throw new HttpError(404, 'UNKNOWN_SYMBOL', 'The symbol is not in the latest market snapshot');
      }
      const price = stock.current_price;
      if (!Number.isFinite(price) || price <= 0) {
        throw new HttpError(503, 'MARKET_DATA_NOT_READY', 'The latest quote is not valid for trading');
      }

      const total = roundNaira(price * input.quantity);
      if (!Number.isFinite(total) || total <= 0) {
        throw new HttpError(400, 'INVALID_TRADE', 'Trade value is outside the supported range');
      }

      const portfolio = await collections.contestPortfolios.findOne(
        { contestId, userId: req.user._id },
        { session }
      );
      if (!portfolio) {
        throw new HttpError(409, 'PARTICIPATION_NOT_READY', 'Contest participation is not ready for trading');
      }
      const holdings = portfolio.holdings || [];
      const holdingIndex = holdings.findIndex((holding) => holding.symbol === input.symbol);
      const holding = holdingIndex >= 0 ? holdings[holdingIndex] : null;

      if (input.side === 'BUY') {
        if (portfolio.virtualBalanceNgn < total) {
          throw new HttpError(409, 'INSUFFICIENT_VIRTUAL_FUNDS', 'There are not enough contest virtual funds');
        }
        portfolio.virtualBalanceNgn = roundNaira(portfolio.virtualBalanceNgn - total);
        if (holding) {
          const newQuantity = holding.quantity + input.quantity;
          holdings[holdingIndex] = {
            ...holding,
            name: stock.name || holding.name,
            quantity: newQuantity,
            averagePrice: roundNaira(
              ((holding.quantity * holding.averagePrice) + (input.quantity * price)) / newQuantity
            )
          };
        } else {
          holdings.push({
            symbol: input.symbol,
            name: stock.name || input.symbol,
            quantity: input.quantity,
            averagePrice: price
          });
        }
      } else {
        if (!holding || holding.quantity < input.quantity) {
          throw new HttpError(409, 'INSUFFICIENT_HOLDINGS', 'There are not enough contest shares to sell');
        }
        portfolio.virtualBalanceNgn = roundNaira(portfolio.virtualBalanceNgn + total);
        if (holding.quantity === input.quantity) {
          holdings.splice(holdingIndex, 1);
        } else {
          holdings[holdingIndex] = { ...holding, quantity: holding.quantity - input.quantity };
        }
      }

      const tradeDate = new Date();
      trade = {
        contestId,
        userId: req.user._id,
        symbol: input.symbol,
        name: stock.name || input.symbol,
        side: input.side,
        quantity: input.quantity,
        price,
        total,
        tradeDate,
        marketTradeDate: stock.trade_date || snapshot.tradeDate || null
      };
      portfolio.holdings = holdings;
      portfolio.updatedAt = tradeDate;
      await collections.contestPortfolios.replaceOne(
        { contestId, userId: req.user._id },
        portfolio,
        { session }
      );
      const inserted = await collections.contestTrades.insertOne(trade, { session });
      trade._id = inserted.insertedId;

      const performance = calculatePerformance(
        portfolio,
        contest.startingBalanceNgn,
        snapshot.stocks || []
      );
      updatedPortfolio = {
        virtualBalanceNgn: performance.virtualBalanceNgn,
        holdings: performance.holdings,
        portfolioValueNgn: performance.portfolioValueNgn,
        returnNgn: performance.returnNgn,
        returnPercent: performance.returnPercent
      };
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } finally {
    await session.endSession();
  }

  return res.status(200).json({
    success: true,
    trade: {
      id: trade._id.toString(),
      symbol: trade.symbol,
      name: trade.name,
      side: trade.side,
      quantity: trade.quantity,
      price: trade.price,
      total: trade.total,
      tradeDate: trade.tradeDate,
      marketTradeDate: trade.marketTradeDate
    },
    portfolio: updatedPortfolio
  });
}));

module.exports = router;
module.exports.calculatePerformance = calculatePerformance;
module.exports.contestStatus = contestStatus;
module.exports.isEligible = isEligible;
module.exports.validateContest = validateContest;
module.exports.validateTrade = validateTrade;
