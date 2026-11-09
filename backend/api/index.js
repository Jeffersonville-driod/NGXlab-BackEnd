const express = require('express');
const cors = require('cors');
const authRouter = require('../lib/auth-router');
const marketRouter = require('../lib/market-router');
const { checkDatabaseConnection } = require('../lib/auth-database');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const frontendOrigin = 'https://www.ngxlab.xyz';
app.set('trust proxy', 1);
app.use(cors({
  origin: frontendOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Priority']
}));
app.use(express.json({ limit: '10kb' }));

app.get('/api', async (req, res) => {
  try {
    await checkDatabaseConnection();
    return res.status(200).json({
      status: 'online',
      database: 'connected',
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Database health check failed:', error);
    return res.status(503).json({
      status: 'offline',
      database: 'disconnected',
      timestamp: new Date()
    });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/market', marketRouter);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found'
    }
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON'
      }
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'REQUEST_TOO_LARGE',
        message: 'Request body is too large'
      }
    });
  }

  if (error.statusCode && error.code) {
    return res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message
      }
    });
  }

  console.error('Unhandled API error:', error);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred'
    }
  });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running locally on http://localhost:${PORT}`);
  });
}