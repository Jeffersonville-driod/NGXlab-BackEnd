const express = require('express');
const { getAuthCollections } = require('./auth-database');
const { requireSession } = require('./session-auth');

const router = express.Router();
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

function validateTrade(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_TRADE', 'Request body must be a JSON object');
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

function roundNaira(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapHolding(holding, marketStocks) {
  const quote = marketStocks.find((stock) => stock.symbol === holding.symbol);
  const currentPrice = Number.isFinite(quote?.current_price) && quote.current_price > 0
    ? quote.current_price
    : null;

  return {
    symbol: holding.symbol,
    name: holding.name,
    quantity: holding.quantity,
    averagePrice: holding.averagePrice,
    currentPrice,
    marketValueNgn: currentPrice === null ? null : roundNaira(currentPrice * holding.quantity)
  };
}

function mapTrade(trade) {
  return {
    id: trade._id.toString(),
    symbol: trade.symbol,
    name: trade.name,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    total: trade.total,
    trade_date: trade.tradeDate,
    market_trade_date: trade.marketTradeDate
  };
}

async function getPortfolio(users, portfolios, trades, marketSnapshots, userId, session) {
  const options = session ? { session } : undefined;
  const user = await users.findOne({ _id: userId }, {
    projection: { virtualBalanceNgn: 1 },
    ...options
  });
  const portfolio = await portfolios.findOne({ _id: userId }, options);
  const marketSnapshot = await marketSnapshots.findOne({ _id: 'latest' }, options);
  const history = await trades.find({ userId }, options)
    .sort({ tradeDate: -1 })
    .limit(tradeHistoryLimit)
    .toArray();

  if (!user) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'A valid signed-in session is required');
  }

  return {
    virtualBalanceNgn: user.virtualBalanceNgn ?? 0,
    as_of: marketSnapshot?.asOf ?? null,
    market_trade_date: marketSnapshot?.tradeDate ?? null,
    holdings: (portfolio?.holdings || []).map((holding) => mapHolding(
      holding,
      marketSnapshot?.stocks || []
    )),
    tradeHistory: history.map(mapTrade)
  };
}

router.use(requireSession);

router.get('/', asyncHandler(async (req, res) => {
  const { users, portfolios, trades, marketSnapshots } = await getAuthCollections();
  const portfolio = await getPortfolio(users, portfolios, trades, marketSnapshots, req.user._id);
  return res.status(200).json({ success: true, portfolio });
}));

router.post('/trades', asyncHandler(async (req, res) => {
  const input = validateTrade(req.body);
  const { client, users, portfolios, trades, marketSnapshots } = await getAuthCollections();
  const session = client.startSession();
  let tradeResult;
  let updatedPortfolio;

  try {
    await session.withTransaction(async () => {
      const snapshot = await marketSnapshots.findOne({ _id: 'latest' }, { session });
      if (!snapshot) {
        throw new HttpError(503, 'MARKET_DATA_NOT_READY', 'Market data has not been collected yet');
      }

      const stock = snapshot.stocks.find((item) => item.symbol === input.symbol);
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

      const user = await users.findOne({ _id: req.user._id }, { session });
      if (!user) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid signed-in session is required');
      }

      const portfolio = await portfolios.findOne({ _id: req.user._id }, { session });
      const holdings = portfolio?.holdings || [];
      const holdingIndex = holdings.findIndex((holding) => holding.symbol === input.symbol);
      const holding = holdingIndex >= 0 ? holdings[holdingIndex] : null;

      if (input.side === 'BUY') {
        if ((user.virtualBalanceNgn ?? 0) < total) {
          throw new HttpError(409, 'INSUFFICIENT_VIRTUAL_FUNDS', 'There are not enough virtual funds for this trade');
        }

        const balanceUpdate = await users.updateOne(
          { _id: req.user._id, virtualBalanceNgn: { $gte: total } },
          { $inc: { virtualBalanceNgn: -total } },
          { session }
        );
        if (balanceUpdate.matchedCount !== 1) {
          throw new HttpError(409, 'INSUFFICIENT_VIRTUAL_FUNDS', 'There are not enough virtual funds for this trade');
        }

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
          throw new HttpError(409, 'INSUFFICIENT_HOLDINGS', 'There are not enough shares to sell');
        }

        const balanceUpdate = await users.updateOne(
          { _id: req.user._id },
          { $inc: { virtualBalanceNgn: total } },
          { session }
        );
        if (balanceUpdate.matchedCount !== 1) {
          throw new HttpError(401, 'UNAUTHENTICATED', 'A valid signed-in session is required');
        }

        if (holding.quantity === input.quantity) {
          holdings.splice(holdingIndex, 1);
        } else {
          holdings[holdingIndex] = {
            ...holding,
            quantity: holding.quantity - input.quantity
          };
        }
      }

      const tradeDate = new Date();
      tradeResult = {
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

      await portfolios.replaceOne(
        { _id: req.user._id },
        { _id: req.user._id, userId: req.user._id, holdings },
        { upsert: true, session }
      );
      const insertedTrade = await trades.insertOne(tradeResult, { session });
      tradeResult._id = insertedTrade.insertedId;

      updatedPortfolio = await getPortfolio(
        users,
        portfolios,
        trades,
        marketSnapshots,
        req.user._id,
        session
      );
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
    trade: mapTrade(tradeResult),
    portfolio: updatedPortfolio
  });
}));

module.exports = router;
