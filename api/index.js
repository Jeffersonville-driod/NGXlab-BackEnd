const app = require('../backend/api');

module.exports = (req, res) => {
  const requestUrl = new URL(req.url, 'http://vercel.local');
  const originalPath = typeof req.query.__path === 'string'
    ? req.query.__path
    : '/api';

  requestUrl.searchParams.delete('__path');
  req.url = `${originalPath}${requestUrl.search}`;

  return app(req, res);
};
