const express = require('express');
const { timingSafeEqual } = require('node:crypto');
const { getAuthCollections } = require('./auth-database');

const router = express.Router();
const cacheDurationMs = 5 * 60 * 1000;
const koboApiBaseUrl = 'https://koboterminal.com/api/ngxdata';
const cache = new Map();
const pendingRequests = new Map();

async function fetchKoboData(path) {
  const apiKey = process.env.KOBO_MARKET_API_KEY;
  if (!apiKey) {
    const error = new Error('Market data is not configured');
    error.statusCode = 503;
    error.code = 'MARKET_DATA_NOT_CONFIGURED';
    throw error;
  }

  const response = await fetch(`${koboApiBaseUrl}${path}`, {
    headers: { 'X-API-Key': apiKey },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    console.error(`Kobo market API returned HTTP ${response.status} for ${path}`);
    const error = new Error('Market data provider returned an error');
    error.statusCode = 502;
    error.code = 'MARKET_DATA_UPSTREAM_ERROR';
    throw error;
  }

  return response.json();
}

async function getCachedKoboData(cacheKey, path) {
  const entry = cache.get(cacheKey);
  if (entry && Date.now() - entry.cachedAt < cacheDurationMs) {
    return entry.data;
  }

  let request = pendingRequests.get(cacheKey);
  if (!request) {
    request = fetchKoboData(path);
    pendingRequests.set(cacheKey, request);
  }

  try {
    const data = await request;
    cache.set(cacheKey, { data, cachedAt: Date.now() });
    return data;
  } finally {
    if (pendingRequests.get(cacheKey) === request) {
      pendingRequests.delete(cacheKey);
    }
  }
}

function sendMarketError(res, error, context) {
  if (error.statusCode === 503) {
    return res.status(503).json({
      error: {
        code: error.code,
        message: error.message
      }
    });
  }

  console.error(`Failed to retrieve ${context}:`, error);
  const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
  return res.status(timedOut ? 504 : 502).json({
    error: {
      code: timedOut ? 'MARKET_DATA_TIMEOUT' : 'MARKET_DATA_UPSTREAM_ERROR',
      message: `Could not retrieve ${context}`
    }
  });
}

function mapStock(stock) {
  return {
    symbol: stock.symbol,
    name: stock.name,
    current_price: stock.current_price,
    change_percent: Number.isFinite(stock.change_percent)
      ? stock.change_percent
      : stock.official_change_percent,
    volume: stock.volume,
    sector: stock.sector,
    trade_date: stock.trade_date
  };
}

function isAuthorizedCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  const authorization = req.get('authorization') || '';
  const expected = secret ? `Bearer ${secret}` : '';
  const providedBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);

  return Boolean(secret)
    && providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}

router.get('/dangsugar', async (req, res) => {
  try {
    const { marketSnapshots } = await getAuthCollections();
    const snapshot = await marketSnapshots.findOne({ _id: 'latest' });
    const stock = snapshot?.stocks.find((item) => item.symbol === 'DANGSUGAR');
    if (!stock) {
      return res.status(503).json({
        error: {
          code: 'MARKET_DATA_NOT_READY',
          message: 'DANGSUGAR data has not been collected yet'
        }
      });
    }

    return res.status(200).json({
      success: true,
      symbol: stock.symbol,
      trade_date: stock.trade_date || snapshot.tradeDate,
      stock
    });
  } catch (error) {
    return sendMarketError(res, error, 'DANGSUGAR market data');
  }
});

router.get('/overview', async (req, res) => {
  try {
    const { marketSnapshots } = await getAuthCollections();
    const snapshot = await marketSnapshots.findOne({ _id: 'latest' });
    if (!snapshot) {
      return res.status(503).json({
        error: {
          code: 'MARKET_DATA_NOT_READY',
          message: 'Market data has not been collected yet'
        }
      });
    }

    return res.status(200).json({
      success: true,
      as_of: snapshot.asOf,
      trade_date: snapshot.tradeDate,
      refreshed_at: snapshot.refreshedAt,
      total_stocks: snapshot.totalStocks,
      market: snapshot.market,
      gainers: snapshot.gainers,
      losers: snapshot.losers,
      top_volume: snapshot.topVolume
    });
  } catch (error) {
    return sendMarketError(res, error, 'market overview');
  }
});

router.get('/stocks', async (req, res) => {
  try {
    const { marketSnapshots } = await getAuthCollections();
    const snapshot = await marketSnapshots.findOne({ _id: 'latest' });
    if (!snapshot) {
      return res.status(503).json({
        error: {
          code: 'MARKET_DATA_NOT_READY',
          message: 'Market data has not been collected yet'
        }
      });
    }

    return res.status(200).json({
      success: true,
      trade_date: snapshot.tradeDate,
      refreshed_at: snapshot.refreshedAt,
      total_stocks: snapshot.totalStocks,
      stocks: snapshot.stocks
    });
  } catch (error) {
    return sendMarketError(res, error, 'stored stock data');
  }
});

router.get('/refresh', async (req, res) => {
  if (!isAuthorizedCronRequest(req)) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'A valid cron authorization header is required'
      }
    });
  }

  try {
    const { marketSnapshots } = await getAuthCollections();
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    try {
      await marketSnapshots.findOneAndUpdate(
        { _id: 'kobo-daily-refresh-limit', lastAttemptDate: { $ne: today } },
        { $set: { lastAttemptDate: today, attemptedAt: now } },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }

      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'DAILY_KOBO_REQUEST_LIMIT',
        message: 'The Kobo API request limit for today has already been used'
      });
    }

    const data = await getCachedKoboData('overview', '/stocks');
    if (!Array.isArray(data.stocks) || data.stocks.length === 0) {
      console.error('Kobo market API returned an invalid stock list');
      return res.status(502).json({
        error: {
          code: 'MARKET_DATA_INVALID_RESPONSE',
          message: 'Market data provider returned an invalid response'
        }
      });
    }

    const stocks = data.stocks.filter((stock) => stock && typeof stock.symbol === 'string');
    const withChange = stocks
      .map((stock) => ({ stock, change: mapStock(stock).change_percent }))
      .filter(({ change }) => Number.isFinite(change));
    const byChange = (left, right) => left.change - right.change;
    const byVolume = (left, right) => (Number(right.volume) || 0) - (Number(left.volume) || 0);
    const refreshedAt = new Date();
    const snapshot = {
      _id: 'latest',
      asOf: data.as_of || data.market?.as_of || refreshedAt,
      tradeDate: data.market?.trade_date || stocks[0].trade_date || null,
      refreshedAt,
      totalStocks: data.total_stocks || data.total || stocks.length,
      market: data.market || null,
      stocks: stocks.map(mapStock),
      gainers: withChange
        .filter(({ change }) => change > 0)
        .sort((left, right) => byChange(right, left))
        .slice(0, 5)
        .map(({ stock }) => mapStock(stock)),
      losers: withChange
        .filter(({ change }) => change < 0)
        .sort(byChange)
        .slice(0, 5)
        .map(({ stock }) => mapStock(stock)),
      topVolume: [...stocks]
        .sort(byVolume)
        .slice(0, 5)
        .map(mapStock)
    };

    await marketSnapshots.replaceOne({ _id: 'latest' }, snapshot, { upsert: true });
    return res.status(200).json({
      success: true,
      refreshed: true,
      trade_date: snapshot.tradeDate,
      total_stocks: snapshot.totalStocks,
      refreshed_at: refreshedAt
    });
  } catch (error) {
    return sendMarketError(res, error, 'market snapshot refresh');
  }
});

module.exports = router;
