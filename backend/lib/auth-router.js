const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { getAuthCollections } = require('./auth-database');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);
const frontendOrigin = 'https://www.ngxlab.xyz';
const sessionCookieName = 'ngxlab_session';
const sessionTtlMs = 14 * 24 * 60 * 60 * 1000;
const sessionTtlSeconds = sessionTtlMs / 1000;
const passwordResetTtlMs = 30 * 60 * 1000;
const rateLimitWindowMs = 15 * 60 * 1000;
const recoveryRateLimitWindowMs = 60 * 60 * 1000;
const passwordResetUrl = `${frontendOrigin}/reset-password`;
const genericRecoveryMessage = 'If an account exists for that email, a password reset link will be sent.';
const scryptOptions = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
};
let googleClient;
let dummyPasswordHashPromise;

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

function requireFrontendOrigin(req, res, next) {
  if (req.get('Origin') !== frontendOrigin) {
    return res.status(403).json({
      error: {
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'Requests must originate from the NGXLab frontend'
      }
    });
  }

  return next();
}

function getRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
  }

  return body;
}

function validateEmail(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_INPUT', 'A valid email address is required');
  }

  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'INVALID_INPUT', 'A valid email address is required');
  }

  return email;
}

function validateRegistration(body) {
  const input = getRequestBody(body);
  const name = typeof input.name === 'string' ? input.name.trim() : '';

  if (!name || name.length > 100) {
    throw new HttpError(400, 'INVALID_INPUT', 'Name must be between 1 and 100 characters');
  }

  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
    throw new HttpError(400, 'INVALID_INPUT', 'Password must be between 8 and 128 characters');
  }

  return {
    name,
    email: validateEmail(input.email),
    password: input.password
  };
}

function validateLogin(body) {
  const input = getRequestBody(body);

  if (typeof input.password !== 'string' || input.password.length < 1 || input.password.length > 128) {
    throw new HttpError(400, 'INVALID_INPUT', 'Password is required');
  }

  return {
    email: validateEmail(input.email),
    password: input.password
  };
}

function validateForgotPassword(body) {
  const input = getRequestBody(body);
  return { email: validateEmail(input.email) };
}

function validateResetPassword(body) {
  const input = getRequestBody(body);

  if (typeof input.token !== 'string' || !/^[\w-]{20,128}$/.test(input.token)) {
    throw new HttpError(400, 'INVALID_INPUT', 'A valid password reset token is required');
  }

  if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
    throw new HttpError(400, 'INVALID_INPUT', 'Password must be between 8 and 128 characters');
  }

  return { token: input.token, password: input.password };
}

function getResendConfiguration() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const endpoint = process.env.RESEND_API_URL || 'https://api.resend.com/emails';

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new HttpError(503, 'PASSWORD_RECOVERY_NOT_CONFIGURED', 'Password recovery is not available');
  }

  if (!apiKey || !from || endpointUrl.protocol !== 'https:') {
    throw new HttpError(503, 'PASSWORD_RECOVERY_NOT_CONFIGURED', 'Password recovery is not available');
  }

  return { apiKey, from, endpoint: endpointUrl.toString() };
}

async function enforceRateLimit(authRateLimits, req, scope, identity, limit, windowMs) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowMs);
  const key = crypto.createHash('sha256')
    .update(`${scope}:${identity || req.ip || req.socket.remoteAddress || 'unknown'}`)
    .digest('hex');
  const shouldResetWindow = {
    $or: [
      { $eq: [{ $type: '$windowStart' }, 'missing'] },
      { $lte: ['$windowStart', cutoff] }
    ]
  };
  const bucket = await authRateLimits.findOneAndUpdate(
    { _id: key },
    [{
      $set: {
        windowStart: { $cond: [shouldResetWindow, now, '$windowStart'] },
        count: {
          $cond: [
            shouldResetWindow,
            1,
            { $add: [{ $ifNull: ['$count', 0] }, 1] }
          ]
        },
        expiresAt: new Date(now.getTime() + windowMs)
      }
    }],
    { upsert: true, returnDocument: 'after' }
  );

  if (bucket.count > limit) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

async function sendPasswordResetEmail(configuration, user, token) {
  const resetLink = new URL(passwordResetUrl);
  resetLink.searchParams.set('token', token);
  const safeName = escapeHtml(user.name || 'there');
  const safeResetLink = escapeHtml(resetLink.toString());
  const response = await fetch(configuration.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${configuration.apiKey}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      from: configuration.from,
      to: [user.email],
      subject: 'Reset your NGXLab password',
      text: `Hi ${user.name || 'there'},\n\nUse this link within 30 minutes to reset your NGXLab password. The link can only be used once:\n${resetLink}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Hi ${safeName},</p><p>Use this link within 30 minutes to reset your NGXLab password. The link can only be used once:</p><p><a href="${safeResetLink}">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`
    })
  });

  if (!response.ok) {
    const error = new Error('Resend rejected the password reset email');
    error.statusCode = response.status;
    throw error;
  }
}

function logPasswordResetFailure(stage, error) {
  console.error('Password recovery operation failed', {
    stage,
    name: error.name || 'Error',
    code: error.code || error.statusCode || 'unknown'
  });
}

function isDuplicateKeyError(error) {
  return error && error.code === 11000;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64, scryptOptions);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function getDummyPasswordHash() {
  if (!dummyPasswordHashPromise) {
    const salt = Buffer.alloc(16);
    dummyPasswordHashPromise = scrypt('not-a-real-password', salt, 64, scryptOptions)
      .then((derivedKey) => `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
  }

  return dummyPasswordHashPromise;
}

async function verifyPassword(password, passwordHash) {
  const [algorithm, saltHex, keyHex] = passwordHash.split('$');
  if (algorithm !== 'scrypt' || !/^[\da-f]{32}$/.test(saltHex) || !/^[\da-f]{128}$/.test(keyHex)) {
    throw new Error('Stored password hash has an invalid format');
  }

  const expectedKey = Buffer.from(keyHex, 'hex');
  const actualKey = await scrypt(password, Buffer.from(saltHex, 'hex'), expectedKey.length, scryptOptions);
  return crypto.timingSafeEqual(actualKey, expectedKey);
}

function createSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: sessionTtlMs,
    path: '/'
  });
}

async function createSession(userId, sessions, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();

  await sessions.insertOne({
    userId,
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: now,
    expiresAt: new Date(now.getTime() + sessionTtlMs)
  });

  createSessionCookie(res, token);
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email
  };
}

function getGoogleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new HttpError(503, 'GOOGLE_AUTH_NOT_CONFIGURED', 'Google authentication is not configured');
  }

  if (!googleClient) {
    googleClient = new OAuth2Client(clientId);
  }

  return { clientId, client: googleClient };
}

async function attachGoogleIdentity(user, subject, users) {
  if (user.googleSub && user.googleSub !== subject) {
    throw new HttpError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This email is linked to a different Google account');
  }

  if (!user.googleSub) {
    await users.updateOne(
      { _id: user._id, googleSub: { $exists: false } },
      { $set: { googleSub: subject } }
    );
    user = await users.findOne({ _id: user._id });
  }

  if (user.googleSub !== subject) {
    throw new HttpError(409, 'GOOGLE_ACCOUNT_CONFLICT', 'This email is linked to a different Google account');
  }

  return user;
}

async function findOrCreateGoogleUser(profile, users) {
  let user = await users.findOne({ googleSub: profile.subject });
  if (user) {
    return user;
  }

  user = await users.findOne({ email: profile.email });
  if (user) {
    return attachGoogleIdentity(user, profile.subject, users);
  }

  const newUser = {
    name: profile.name,
    email: profile.email,
    googleSub: profile.subject,
    createdAt: new Date()
  };

  try {
    await users.insertOne(newUser);
    return newUser;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    user = await users.findOne({ googleSub: profile.subject });
    if (user) {
      return user;
    }

    user = await users.findOne({ email: profile.email });
    if (user) {
      return attachGoogleIdentity(user, profile.subject, users);
    }

    throw error;
  }
}

router.post('/register', requireFrontendOrigin, asyncHandler(async (req, res) => {
  const registration = validateRegistration(req.body);
  const { users, sessions } = await getAuthCollections();
  const user = {
    name: registration.name,
    email: registration.email,
    passwordHash: await hashPassword(registration.password),
    createdAt: new Date()
  };

  try {
    const result = await users.insertOne(user);
    user._id = result.insertedId;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new HttpError(409, 'EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
    }
    throw error;
  }

  await createSession(user._id, sessions, res);
  return res.status(201).json({ user: publicUser(user) });
}));

router.post('/login', requireFrontendOrigin, asyncHandler(async (req, res) => {
  const credentials = validateLogin(req.body);
  const { users, sessions, authRateLimits } = await getAuthCollections();
  await enforceRateLimit(authRateLimits, req, 'login-ip', null, 30, rateLimitWindowMs);
  await enforceRateLimit(authRateLimits, req, 'login-email', credentials.email, 8, rateLimitWindowMs);
  const user = await users.findOne({ email: credentials.email });
  const passwordHash = user && user.passwordHash
    ? user.passwordHash
    : await getDummyPasswordHash();

  if (!await verifyPassword(credentials.password, passwordHash) || !user || !user.passwordHash) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  await createSession(user._id, sessions, res);
  return res.status(200).json({ user: publicUser(user) });
}));

router.post('/forgot-password', requireFrontendOrigin, asyncHandler(async (req, res) => {
  const { email } = validateForgotPassword(req.body);
  const resendConfiguration = getResendConfiguration();
  const { users, passwordResetTokens, authRateLimits } = await getAuthCollections();

  await enforceRateLimit(authRateLimits, req, 'forgot-password-ip', null, 10, recoveryRateLimitWindowMs);
  await enforceRateLimit(authRateLimits, req, 'forgot-password-email', email, 3, recoveryRateLimitWindowMs);

  const user = await users.findOne({ email }, { projection: { _id: 1, email: 1, name: 1 } });
  if (user) {
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      const now = new Date();

      await passwordResetTokens.deleteMany({ userId: user._id });
      await passwordResetTokens.insertOne({
        userId: user._id,
        tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        createdAt: now,
        expiresAt: new Date(now.getTime() + passwordResetTtlMs)
      });
      await sendPasswordResetEmail(resendConfiguration, user, token);
    } catch (error) {
      logPasswordResetFailure('issue-or-send', error);
    }
  }

  return res.status(200).json({ message: genericRecoveryMessage });
}));

router.post('/reset-password', requireFrontendOrigin, asyncHandler(async (req, res) => {
  const { token, password } = validateResetPassword(req.body);
  const { users, sessions, passwordResetTokens, authRateLimits } = await getAuthCollections();
  await enforceRateLimit(authRateLimits, req, 'reset-password-ip', null, 10, rateLimitWindowMs);

  const now = new Date();
  const resetToken = await passwordResetTokens.findOneAndDelete({
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    expiresAt: { $gt: now }
  });

  if (!resetToken) {
    throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or expired');
  }

  const result = await users.updateOne(
    { _id: resetToken.userId },
    { $set: { passwordHash: await hashPassword(password), passwordUpdatedAt: now } }
  );

  if (result.matchedCount !== 1) {
    throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or expired');
  }

  await sessions.deleteMany({ userId: resetToken.userId });
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    path: '/'
  });

  return res.status(200).json({ message: 'Password has been reset successfully' });
}));

router.post('/google', requireFrontendOrigin, asyncHandler(async (req, res) => {
  const body = getRequestBody(req.body);
  if (typeof body.idToken !== 'string' || body.idToken.length === 0 || body.idToken.length > 8192) {
    throw new HttpError(400, 'INVALID_INPUT', 'A Google ID token is required');
  }

  const { clientId, client } = getGoogleClient();
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: body.idToken,
      audience: clientId
    });
    payload = ticket.getPayload();
  } catch (error) {
    if (error.name === 'GaxiosError') {
      throw error;
    }
    throw new HttpError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Google credential is invalid or expired');
  }

  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    throw new HttpError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Google credential is invalid or expired');
  }

  const { users, sessions } = await getAuthCollections();
  const user = await findOrCreateGoogleUser({
    subject: payload.sub,
    email: validateEmail(payload.email),
    name: typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim().slice(0, 100)
      : payload.email.split('@')[0].slice(0, 100)
  }, users);

  await createSession(user._id, sessions, res);
  return res.status(200).json({ user: publicUser(user) });
}));

module.exports = router;
