const { MongoClient } = require('mongodb');

let clientPromise;
let indexesPromise;
let connectionLogged = false;

async function getAuthCollections() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DB;

  if (!uri || !databaseName) {
    const error = new Error('MongoDB authentication storage is not configured');
    error.statusCode = 503;
    error.code = 'AUTH_STORAGE_NOT_CONFIGURED';
    throw error;
  }

  if (!clientPromise) {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000
    });

    clientPromise = client.connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }

  const client = await clientPromise;
  const database = client.db(databaseName);
  const users = database.collection('users');
  const sessions = database.collection('sessions');
  const passwordResetTokens = database.collection('passwordResetTokens');
  const authRateLimits = database.collection('authRateLimits');

  if (!indexesPromise) {
    indexesPromise = Promise.all([
      users.createIndex({ email: 1 }, { unique: true }),
      users.createIndex({ googleSub: 1 }, { unique: true, sparse: true }),
      sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      passwordResetTokens.createIndex({ tokenHash: 1 }, { unique: true }),
      passwordResetTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      passwordResetTokens.createIndex({ userId: 1 }),
      authRateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]).catch((error) => {
      indexesPromise = undefined;
      throw error;
    });
  }

  await indexesPromise;
  if (!connectionLogged) {
    console.log('Connected to database');
    connectionLogged = true;
  }

  return { users, sessions, passwordResetTokens, authRateLimits };
}

async function checkDatabaseConnection() {
  await getAuthCollections();
  const client = await clientPromise;
  await client.db(process.env.MONGODB_DB).command({ ping: 1 });
}

module.exports = { checkDatabaseConnection, getAuthCollections };
