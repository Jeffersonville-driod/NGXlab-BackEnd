const crypto = require('node:crypto');
const { getAuthCollections } = require('./auth-database');

function getSessionToken(req) {
  const cookieHeader = req.get('cookie') || '';
  const sessionCookie = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('ngxlab_session='));

  return sessionCookie ? sessionCookie.slice('ngxlab_session='.length) : null;
}

async function requireSession(req, res, next) {
  const token = getSessionToken(req);
  if (!token || !/^[\w-]{43}$/.test(token)) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'A valid signed-in session is required'
      }
    });
  }

  try {
    const { sessions, users } = await getAuthCollections();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await sessions.findOne({
      tokenHash,
      expiresAt: { $gt: new Date() }
    });
    if (!session) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'A valid signed-in session is required'
        }
      });
    }

    const user = await users.findOne({ _id: session.userId });
    if (!user) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'A valid signed-in session is required'
        }
      });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireSession };
