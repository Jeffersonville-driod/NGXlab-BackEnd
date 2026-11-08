const express = require('express');
const cors = require('cors');
const authRouter = require('../lib/auth-router');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
const frontendOrigin = 'https://www.ngxlab.xyz';
app.set('trust proxy', 1);
const authCors = cors({
  origin: (origin, callback) => callback(null, origin === frontendOrigin),
  credentials: true,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
});

app.use('/api/auth', authCors);
app.use(express.json({ limit: '10kb' }));

// Main base API endpoint
app.get('/api', (req, res) => {
  res.status(200).json({
    message: "API workspace initialized successfully from scratch!",
    status: "online",
    timestamp: new Date()
  });
});

app.use('/api/auth', authRouter);

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