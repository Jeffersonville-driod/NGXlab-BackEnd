const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { getAuthCollections } = require('./auth-database');

const router = express.Router();
const scrypt = promisify(crypto.scrypt);
const frontendOrigin = 'https://www.ngxlab.com';
const sessionCookieName = 'ngxlab_session';
const sessionTtlMs = 14 * 24 * 60 * 60 * 1000;
const sessionTtlSeconds = sessionTtlMs / 1000;
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
  const { users, sessions } = await getAuthCollections();
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
