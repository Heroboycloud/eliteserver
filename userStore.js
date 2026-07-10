// userStore.js
// Simple, importable Upstash Redis user/payment store.
// Uses the same data model as bot.js so it's compatible with existing data.
//
// Data model:
//   set   "users"              -> all known user IDs
//   set   "users:paid"         -> user IDs who have paid at least once
//   set   "users:premium"      -> user IDs currently premium
//   hash  "user:{id}"          -> { userId, username, firstName, isPremium,
//                                   premiumTier, premiumExpiry, totalSpent, ... }

const { Redis } = require('@upstash/redis');

// ------------------------------------------------------------------
// Setup — pass config in, or set REDIS_URL / REDIS_PASSWORD env vars.
// ------------------------------------------------------------------
function createStore(config = {}) {
    const url = config.url || process.env.REDIS_URL;
    const token = config.token || process.env.REDIS_PASSWORD;

    if (!url || !token) {
        throw new Error('userStore: missing Redis url/token (pass in config or set REDIS_URL / REDIS_PASSWORD)');
    }

    const redis = new Redis({ url, token });

    // ----------------------------------------------------------------
    // Users
    // ----------------------------------------------------------------

    /** Create a set to hold users, if it doesn't already implicitly exist.
     *  (Redis sets are created on first sadd, so this is just a convenience
     *  no-op unless you want to guarantee the key exists.) */
    async function createUserSet(setName = 'users') {
        // Upstash sets don't need pre-creation, but this keeps the key
        // present even if empty, for tooling that expects it to exist.
        await redis.sadd(setName, '__init__');
        await redis.srem(setName, '__init__');
        return setName;
    }

    /** Add a brand-new user (no-op if the user already exists). */
    async function addUser(userId, { username = '', firstName = '' } = {}) {
        const existing = await getUser(userId);
        if (existing) return existing;

        const userData = {
            userId: String(userId),
            username,
            firstName,
            joinedAt: String(Date.now()),
            lastActive: String(Date.now()),
            isPremium: '0',
            premiumExpiry: '0',
            premiumTier: '',
            totalSpent: '0'
        };

        await redis.hset(`user:${userId}`, userData);
        await redis.sadd('users', String(userId));
        return userData;
    }

    /** Fetch a user's hash, or null if they don't exist. */
    async function getUser(userId) {
        const data = await redis.hgetall(`user:${userId}`);
        return data && Object.keys(data).length ? data : null;
    }

    /** List all known user IDs. */
    async function listUsers() {
        return redis.smembers('users');
    }

    async function userExists(userId) {
        return (await redis.sismember('users', String(userId))) === 1;
    }

    // ----------------------------------------------------------------
    // Paid status (has this user paid, independent of premium expiry)
    // ----------------------------------------------------------------

    /** Mark a user as paid: adds to the "users:paid" set and bumps totalSpent. */
    async function markPaid(userId, amount = 0) {
        if (!(await userExists(userId))) {
            await addUser(userId);
        }
        await redis.sadd('users:paid', String(userId));
        if (amount) {
            const user = await getUser(userId);
            const spent = (parseInt(user?.totalSpent) || 0) + Number(amount);
            await redis.hset(`user:${userId}`, { totalSpent: String(spent) });
        }
        return true;
    }

    /** Check if a user is in the paid set. */
    async function isPaid(userId) {
        return (await redis.sismember('users:paid', String(userId))) === 1;
    }

    /** Remove a user from the paid set (does not touch premium status). */
    async function removePaid(userId) {
        await redis.srem('users:paid', String(userId));
        return true;
    }

    /** List every paid user ID. */
    async function listPaidUsers() {
        return redis.smembers('users:paid');
    }

    // ----------------------------------------------------------------
    // Premium (paid + has an active tier/expiry)
    // ----------------------------------------------------------------

    /**
     * Grant/extend premium for a user at a given tier.
     * @param {string|number} userId
     * @param {number} days     - days of premium to add
     * @param {string} tier     - e.g. 'basic', 'pro', 'vip'
     */
    async function addPremium(userId, days, tier) {
        let user = await getUser(userId);
        if (!user) {
            user = await addUser(userId);
        }

        const now = Date.now();
        const currentExpiry = parseInt(user.premiumExpiry) || 0;
        // Extend from current expiry if still active, otherwise from now.
        const base = user.isPremium === '1' && currentExpiry > now ? currentExpiry : now;
        const expiry = base + days * 24 * 60 * 60 * 1000;

        await redis.hset(`user:${userId}`, {
            isPremium: '1',
            premiumExpiry: String(expiry),
            premiumTier: tier || 'premium'
        });
        await redis.sadd('users:premium', String(userId));
        await redis.sadd('users:paid', String(userId));

        return { userId: String(userId), tier, expiresAt: new Date(expiry).toISOString() };
    }

    /** Check current premium status (auto-expires if past premiumExpiry). */
    async function getPremiumStatus(userId) {
        const user = await getUser(userId);
        if (!user) return { isPremium: false, tier: null, expiresIn: null };

        const now = Date.now();
        const expiry = parseInt(user.premiumExpiry) || 0;

        if (user.isPremium === '1' && expiry > now) {
            const daysLeft = Math.ceil((expiry - now) / (24 * 60 * 60 * 1000));
            return { isPremium: true, tier: user.premiumTier || 'premium', expiresIn: daysLeft };
        }

        // Expired — clean up.
        if (user.isPremium === '1' && expiry <= now) {
            await redis.hset(`user:${userId}`, { isPremium: '0', premiumExpiry: '0', premiumTier: '' });
            await redis.srem('users:premium', String(userId));
        }

        return { isPremium: false, tier: null, expiresIn: null };
    }

    /** Quick boolean premium check. */
    async function isPremium(userId) {
        return (await getPremiumStatus(userId)).isPremium;
    }

    /** Revoke premium immediately (user stays in paid history). */
    async function removePremium(userId) {
        await redis.hset(`user:${userId}`, { isPremium: '0', premiumExpiry: '0', premiumTier: '' });
        await redis.srem('users:premium', String(userId));
        return true;
    }

    /** List every currently-premium user ID (does not auto-expire entries). */
    async function listPremiumUsers() {
        return redis.smembers('users:premium');
    }

    // ----------------------------------------------------------------
    // Stats
    // ----------------------------------------------------------------

    async function getStats() {
        const [allUsers, paidUsers, premiumUsers] = await Promise.all([
            redis.smembers('users'),
            redis.smembers('users:paid'),
            redis.smembers('users:premium')
        ]);
        return {
            totalUsers: allUsers.length,
            paidUsers: paidUsers.length,
            premiumUsers: premiumUsers.length
        };
    }

    return {
        redis, // exposed in case you need raw access
        createUserSet,
        addUser,
        getUser,
        listUsers,
        userExists,
        markPaid,
        isPaid,
        removePaid,
        listPaidUsers,
        addPremium,
        getPremiumStatus,
        isPremium,
        removePremium,
        listPremiumUsers,
        getStats
    };
}

module.exports = { createStore };
