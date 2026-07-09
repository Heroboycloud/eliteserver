// Unified Premium Bot with Redis Database and NowPayments API Integration
// Combines elitepay.js commands with testbot.js API invoicing

const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config(); // Fixed: Correct way to load dotenv

console.clear();

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
    BOT_NAME: process.env.BOT_NAME,
    NOWPAYMENTS_API_KEY: process.env.NOWPAYMENTS_API_KEY,
    WEBHOOK_URL: process.env.WEBHOOK_NOW_URL || 'https://curveradarhook.vercel.app/webhook/nowpayments',
    ADMIN_UNIQUE_ID: process.env.ADMIN_UNIQUE_ID,
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
    FREE_CHANNEL_ID:"-1003766079811" ,
    PREMIUM_CHANNEL_ID:"-5552095929",
    PRICING: {
        MONTHLY: { amount: 49.00, currency: 'USD', plan_currency: 'SOL', days: 30, label: 'Monthly', emoji: '📅' },
        YEARLY: { amount: 550.00, currency: 'USD', plan_currency: 'SOL', days: 365, label: 'Yearly', emoji: '📆' },
        LIFETIME: { amount: 5000.00, currency: 'USD', plan_currency: 'SOL', days: 3650, label: 'Lifetime', emoji: '👑' },
        VIP: { amount: 6000.00, currency: 'USD', plan_currency: 'SOL', days: 3650, label: 'VIP Lifetime', emoji: '💎' }
    },
    
    PAYMENT_TIMEOUT: 60 * 60 * 1000, // 1 hour
};

// Validate required config
if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.NOWPAYMENTS_API_KEY || !CONFIG.ADMIN_UNIQUE_ID) {
    console.error('❌ Missing TELEGRAM_TOKEN or NOWPAYMENTS_API_KEY in .env');
    process.exit(1);
}

// ============================================
// LOGGER
// ============================================
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

// ============================================
// REDIS SETUP
// ============================================
let redis;
let redisConnected = false;

try {
    // Fixed: Proper Redis initialization with error handling
    if (process.env.REDIS_URL) {
        redis = new Redis({
            url: process.env.REDIS_URL,
            token: process.env.REDIS_PASSWORD
        });
        redisConnected = true;
        console.log("✅ Connected to Upstash Redis...");
    } else {
        console.error("❌ REDIS_URL not found in environment variables");
        process.exit(1);
    }
} catch (error) {
    console.error(`❌ Failed to connect to Redis: ${error.message}`);
    process.exit(1);
}

// ============================================
// REDIS HELPERS
// ============================================
async function getUser(userId) {
    try {
        const data = await redis.hgetall(`user:${userId}`);
        return Object.keys(data).length ? data : null;
    } catch (error) {
        log(`Redis getUser error: ${error.message}`, 'ERROR');
        return null;
    }
}

async function createUser(userId, username, firstName) {
    try {
        const user = await getUser(userId);
        if (user) return user;

        const userData = {
            userId: String(userId),
            username: username || '',
            firstName: firstName || '',
            joinedAt: String(Date.now()),
            lastActive: String(Date.now()),
            isPremium: '0',
            premiumExpiry: '0',
            premiumTier: '',
            totalSpent: '0'
        };

        await redis.hset(`user:${userId}`, userData);
        await redis.sadd('users', userId);
        log(`👤 User created: ${userId}`);
        return userData;
    } catch (error) {
        log(`Redis createUser error: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function updateUserActivity(userId) {
    try {
        await redis.hset(`user:${userId}`, 'lastActive', String(Date.now()));
    } catch (error) {
        log(`Redis updateUserActivity error: ${error.message}`, 'ERROR');
    }
}

async function getPremiumStatus(userId) {
    try {
        const user = await getUser(userId);
        if (!user) return { isPremium: false, expiresIn: null, tier: null };

        const now = Date.now();
        const expiry = parseInt(user.premiumExpiry);

        if (user.isPremium === '1' && expiry > now) {
            const daysLeft = Math.ceil((expiry - now) / (24 * 60 * 60 * 1000));
            return {
                isPremium: true,
                expiresIn: daysLeft,
                tier: user.premiumTier || 'premium',
                expiryDate: new Date(expiry).toISOString()
            };
        }

        if (user.isPremium === '1' && expiry <= now) {
            await redis.hset(`user:${userId}`, { isPremium: '0', premiumExpiry: '0', premiumTier: '' });
        }

        return { isPremium: false, expiresIn: null, tier: null };
    } catch (error) {
        log(`Redis getPremiumStatus error: ${error.message}`, 'ERROR');
        return { isPremium: false, expiresIn: null, tier: null };
    }
}

async function setPremium(userId, days, tier) {
    try {
        let user = await getUser(userId);
        if (!user) {
            user = await createUser(userId, '', '');
        }

        const now = Date.now();
        let expiry = now + (days * 24 * 60 * 60 * 1000);

        if (user.isPremium === '1') {
            expiry = parseInt(user.premiumExpiry) + (days * 24 * 60 * 60 * 1000);
        }

        await redis.hset(`user:${userId}`, {
            isPremium: '1',
            premiumExpiry: String(expiry),
            premiumTier: tier || 'premium'
        });

        log(`⭐ Premium set for user ${userId}: ${days} days, tier: ${tier}`);
    } catch (error) {
        log(`Redis setPremium error: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function createPayment(userId, planId, amount, invoiceUrl, orderId) {
    try {
        const payment = {
            orderId,
            userId: String(userId),
            planId,
            amount: String(amount),
            currency: 'USD',
            status: 'pending',
            createdAt: String(Date.now()),
            updatedAt: String(Date.now()),
            invoiceUrl,
            confirmed: '0',
            confirmedAt: '0'
        };

        await redis.hset(`payment:${orderId}`, payment);
        await redis.sadd(`user:${userId}:payments`, orderId);
        await redis.sadd('payments:pending', orderId);
        log(`💳 Payment created: ${orderId} for user ${userId}`);
        return payment;
    } catch (error) {
        log(`Redis createPayment error: ${error.message}`, 'ERROR');
        throw error;
    }
}

async function getPayment(orderId) {
    try {
        return await redis.hgetall(`payment:${orderId}`);
    } catch (error) {
        log(`Redis getPayment error: ${error.message}`, 'ERROR');
        return null;
    }
}

async function getPendingPaymentByUser(userId) {
    try {
        const paymentIds = await redis.smembers(`user:${userId}:payments`);
        
        for (const id of paymentIds) {
            const payment = await getPayment(id);
            if (payment && payment.status === 'pending' && payment.confirmed === '0') {
                const now = Date.now();
                if (now - parseInt(payment.createdAt) < CONFIG.PAYMENT_TIMEOUT) {
                    return payment;
                } else {
                    await redis.hset(`payment:${id}`, 'status', 'expired');
                }
            }
        }
        return null;
    } catch (error) {
        log(`Redis getPendingPaymentByUser error: ${error.message}`, 'ERROR');
        return null;
    }
}

async function confirmPayment(orderId) {
    try {
        const payment = await getPayment(orderId);
        if (!payment) return null;

        // Note: This seems to be checking for a 'payment_ids' set that may not exist
        // You might want to implement proper payment confirmation logic
        const paid = await redis.sismember('payment_ids', orderId);
        
        if (paid) {
            const plan = CONFIG.PRICING[payment.planId];
            const user = await getUser(payment.userId);
            
            if (user && plan) {
                await setPremium(payment.userId, plan.days, payment.planId.toLowerCase());
                await redis.hset(`payment:${orderId}`, {
                    status: 'confirmed',
                    confirmed: '1',
                    confirmedAt: String(Date.now())
                });
                await redis.srem('payments:pending', orderId);
                
                const spent = parseInt(user.totalSpent) + plan.amount;
                await redis.hset(`user:${payment.userId}`, 'totalSpent', String(spent));
                
                log(`✅ Payment confirmed: ${orderId} for user ${payment.userId}`);
                return payment;
            }
        }

        log(`⚠️ Payment ${orderId} not found in Redis`, 'WARN');
        return null;
    } catch (error) {
        log(`Redis confirmPayment error: ${error.message}`, 'ERROR');
        return null;
    }
}

async function getStats() {
    try {
        const allUsers = await redis.smembers('users');
        let premiumCount = 0;
        let totalRevenue = 0;

        for (const userId of allUsers) {
            const status = await getPremiumStatus(userId);
            if (status.isPremium) premiumCount++;
            
            const user = await getUser(userId);
            totalRevenue += parseInt(user?.totalSpent) || 0;
        }

        const pendingPayments = await redis.smembers('payments:pending');
        const allPayments = await redis.keys('payment:*');

        return {
            totalUsers: allUsers.length,
            premiumUsers: premiumCount,
            totalRevenue,
            totalPayments: allPayments.length,
            pendingPayments: pendingPayments.length
        };
    } catch (error) {
        log(`Redis getStats error: ${error.message}`, 'ERROR');
        return {
            totalUsers: 0,
            premiumUsers: 0,
            totalRevenue: 0,
            totalPayments: 0,
            pendingPayments: 0
        };
    }
}

// ============================================
// NOWPAYMENTS API
// ============================================
async function createInvoice(userId, chatId, planId) {
    try {
        const plan = CONFIG.PRICING[planId];
        if (!plan) throw new Error('Invalid plan ID');

        const orderId = `pay_${userId}_${Date.now()}`;
        const description = `CurveRadar Premium - ${plan.label}`;

        const payload = {
            price_amount: plan.amount,
            price_currency: plan.currency,
            pay_currency: plan.plan_currency || "SOL",
            order_id: orderId,
            order_description: description,
            ipn_callback_url: CONFIG.WEBHOOK_URL,
            success_url: `https://t.me/${CONFIG.BOT_NAME}?status`,
            cancel_url: `https://t.me/${CONFIG.BOT_NAME}?status`
        };

        log(`Creating invoice: ${orderId} | Plan: ${planId} | Amount: $${plan.amount}`);

        const response = await fetch('https://api.nowpayments.io/v1/invoice', {
            method: 'POST',
            headers: {
                'x-api-key': CONFIG.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`NowPayments error: ${errorData.message || response.statusText}`);
        }

        const data = await response.json();

        if (!data.invoice_url) {
            throw new Error('No invoice URL returned');
        }

        log(`✅ Invoice created: ${orderId}`);

        await createPayment(userId, planId, plan.amount, data.invoice_url, orderId);

        return {
            orderId,
            invoiceUrl: data.invoice_url,
            plan,
            ...data
        };
    } catch (err) {
        log(`Invoice creation failed: ${err.message}`, 'ERROR');
        throw err;
    }
}

// ============================================
// BOT SETUP
// ============================================
//const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { webHook:{ autoDelete: false},polling: false  }); // Changed to polling: true
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
}

// IMPORTANT: No polling, just create the bot
const bot = new TelegramBot(token);
let botMe = null;

bot.getMe().then(me => {
    botMe = me;
    log(`🤖 Bot name: @${me.username}`);
}).catch(error => {
    log(`Failed to get bot info: ${error.message}`, 'ERROR');
});

// ============================================
// BOT COMMANDS
// ============================================

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        await createUser(userId, msg.from.username, msg.from.first_name);
        await updateUserActivity(userId);

        const status = await getPremiumStatus(userId);

        const message = `
🤖 *Welcome to Elitepay Bot!*

I'm here to help your community get access to premium trading features.

💰 *Premium Features Include:*
✅ Bundle detection
✅ Whale tracking alerts
✅ Token security scanning
✅ Developer reputation
✅ Breakout predictions
✅ Instant alerts
✅ Priority support
✅ And more!

📋 *How It Works:*
1️⃣ Users DM me or click /pay
2️⃣ Choose a plan (Monthly/Yearly/Lifetime/VIP)
3️⃣ Complete payment
4️⃣ Get instant access!

💳 *Plans Available:*
📅 Monthly: $49
📆 Yearly: $550 (Save 16%)
👑 Lifetime: $5,000
💎 VIP: $6,000

Get access to advanced trading features.

📊 *Your Status:* ${status.isPremium ? '⭐ PREMIUM' : '🔓 FREE'}
${status.isPremium ? `📅 Expires in: ${status.expiresIn} days` : ''}

📋 *Commands:*
/start - Welcome
/premium - View features
/features - View Advanced features
/pay - Upgrade
/status - Check subscription
/history - Payment history
/help - Help menu
/invite - Give you link to channel

${!status.isPremium ? '\n💳 *Click below to upgrade!*' : ''}
        `;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            ...(status.isPremium ? {} : {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '⭐ UPGRADE', callback_data: 'show_pricing' }],
                        [{ text: '📊 Features', callback_data: 'view_features' }]
                    ]
                }
            })
        });

        log(`👋 User ${userId} started bot`);
    } catch (err) {
        log(`Start command error: ${err.message}`, 'ERROR');
        await bot.sendMessage(chatId, '❌ An error occurred. Please try again later.');
    }
});




// Generate and send invite link
bot.onText(/\/invite/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const status = await getPremiumStatus(userId);
    let CHANNEL_ID= CONFIG.FREE_CHANNEL_ID;
   if(status.isPremium){
    CHANNEL_ID= CONFIG.PREMIUM_CHANNEL_ID;

}
else {
    CHANNEL_ID= CONFIG.FREE_CHANNEL_ID;

}
    try {
        // Create a one-time invite link
        const inviteLink = await bot.createChatInviteLink(CHANNEL_ID, {
            member_limit: 1,        // One-time use
            expire_date: Math.floor(Date.now() / 1000) + 3600 // Expires in 2 min/secs 
        });
        
        await bot.sendMessage(chatId, `
🔗 *Your One-Time Invite Link:*
${inviteLink.invite_link}
⚠️ *Valid  for 1 hour | Can be used once*
        `, { parse_mode: 'Markdown' });
        
        console.log(`✅ Invite sent to ${userId}`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        await bot.sendMessage(chatId, '❌ Failed to generate link. Make sure bot is admin in the channel.');
    }
});







// /pay
bot.onText(/\/pay/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        await updateUserActivity(userId);

        const message = `
💎 *Premium Plans*

Choose your plan:

📅 *Monthly* - $49
├─ 30 days access
├─ All features
└─ Cancel anytime

📆 *Yearly* - $550 (Save 16%)
├─ 365 days access
├─ All features
└─ Best value

👑 *Lifetime* - $5,000
├─ Unlimited access
├─ All features
└─ One-time payment

💎 *VIP Lifetime* - $6,000
├─ Unlimited access
├─ VIP support
├─ Priority features
└─ One-time payment
        `;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📅 Monthly', callback_data: 'plan_MONTHLY' },
                        { text: '📆 Yearly', callback_data: 'plan_YEARLY' }
                    ],
                    [
                        { text: '👑 Lifetime', callback_data: 'plan_LIFETIME' },
                        { text: '💎 VIP', callback_data: 'plan_VIP' }
                    ]
                ]
            }
        });

        log(`User ${userId} requested pricing`);
    } catch (err) {
        log(`Pay command error: ${err.message}`, 'ERROR');
    }
});

// /status
bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const new_link= await bot.createChatInviteLink(CONFIG.PREMIUM_CHANNEL_ID, { member_limit: 1 });
    try {
        await updateUserActivity(userId);
        const status = await getPremiumStatus(userId);
        const user = await getUser(userId);

        if (!user) {
            await bot.sendMessage(chatId, '❌ User not found. Use /start first.');
            return;
        }
        
        await bot.sendMessage(chatId, "⏳ If you just paid... Please wait a few seconds for our server to update your data.. Then type /status again");
        
        const message = `
📊 *Subscription Status*

👤 User: ${msg.from.first_name || userId}

${status.isPremium ? `
⭐ *Status:* PREMIUM ✅
📅 Expires: ${new Date(status.expiryDate).toLocaleDateString()}
📆 Days remaining: ${status.expiresIn}
💳 Tier: ${status.tier}
Group Link to join: ${new_link.invite_link}
` : `
🔓 *Status:* FREE
💳 Upgrade with /pay
`}
        `;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
        log(`Status command error: ${err.message}`, 'ERROR');
    }
});

// /features
bot.onText(/\/features/, async (msg) => {
    try {
        const prem_message = `
💎 *PREMIUM PRICING PLANS*

Choose the plan that fits your trading needs:

📅 *Monthly Plan*
💰 $49/month
🎯 Perfect for trying out premium features

📆 *Yearly Plan* (Save 16%)
💰 $550/year ($45.83/month)
🎯 Best for regular traders

👑 *Lifetime Plan* (Best Value)
💰 $5,000 one-time
🎯 Unlimited access forever

💎 *VIP Lifetime* (Elite)
💰 $6,000 one-time
🎯 VIP support + exclusive features
`;
        await bot.sendMessage(msg.chat.id, prem_message, { parse_mode: 'Markdown' });
    } catch (err) {
        log(`Features command error: ${err.message}`, 'ERROR');
    }
});

// /help
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const message = `
🔧 *Bot Commands*

/start - Welcome
/premium - All Features
/features - Your Preferences
/pay - Choose plan
/status - Subscription
/history - Payment history
/help - This menu

💳 *How to Upgrade:*
1. Click /pay
2. Choose plan
3. Click payment link
4. Complete payment
5. Premium activated!
        `;
        
        const enlight_msg = `
*Premium Tier - $49.99 per month*
Get access to all premium bots and features:

📊 *What you get:*
• Free Bot DMS into your account 🔥
• Instant token alerts ⚡
• Bundle detection 🔍
• Whale tracking 🐋
• Breakout predictions 🚀
• Security scanning 🔒
• Developer reputation 👤
• Migration alerts 🔄
• Watchlist tracking 📋
• Realtime analysis of bots 🖥
• Priority support 💬
• Developer Api support 💻 
• Detection of scam tokens 💸💸💸
• Priority support 💬
• Early access to features 🎯
• Exclusive signals 📈
• Market insights 📊
• Trade recommendations 💡
• Community chats with serious and legit members 

*🚀 VIP Tier - $6000 Lifetime Access*

• All Features in Premium Access 💡
• Access to use all 11 bots in your groups 💪
• Realtime analysis of bots 💻
• Detecting Red Flags in bots 🏴
• Access to get Moderation bot for free to use in groups 🔥
• Multiple Wallets Pumping Detector 🌊
• Developer Api support 💻 
• Access to more Bots on the way
• Direct access to admin
• Exclusive support 💬
• Early access to all features 🎯
• Exclusive and New signals 📈
• Useful Market insights 📊
• Trade recommendations 💡
• Community chats and support
`;
        await bot.sendChatAction(chatId, "typing");
        await bot.sendMessage(chatId, enlight_msg, { parse_mode: 'Markdown' });
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
        log(`Help command error: ${err.message}`, 'ERROR');
    }
});

// /premium
bot.onText(/\/premium/, async (msg) => {
    const chatId = msg.chat.id;

    try {
        const message = `
⭐ *PREMIUM FEATURES*

📊 *What you get:*
• Real-time token alerts ⚡
• Bundle detection 🔍
• Whale tracking 🐋
• Security scanning 🔒
• Breakout predictions 🚀
• Developer reputation 👤
• Priority support 💬
• Early access to features 🎯
• Exclusive signals 📈
• Market insights 📊
• Trade recommendations 💡

💳 *Upgrade with /pay*
        `;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '💳 UPGRADE NOW', callback_data: 'show_pricing' }],
                    [{ text: '📊 View Pricing', callback_data: 'show_pricing' }]
                ]
            }
        });
    } catch (err) {
        log(`Premium command error: ${err.message}`, 'ERROR');
    }
});

// /history
bot.onText(/\/history/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        const paymentIds = await redis.smembers(`user:${userId}:payments`);
        
        if (!paymentIds || paymentIds.length === 0) {
            await bot.sendMessage(chatId, '📭 No payment history found.');
            return;
        }

        let message = '📋 *Payment History*\n\n';
        
        for (const id of paymentIds.slice(-10)) {
            const payment = await getPayment(id);
            if (payment) {
                const date = new Date(parseInt(payment.createdAt)).toLocaleDateString();
                const emoji = payment.status === 'confirmed' ? '✅' : payment.status === 'pending' ? '⏳' : '❌';
                message += `${emoji} $${payment.amount} (${payment.planId})\n${date}\n\n`;
            }
        }

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
        log(`History command error: ${err.message}`, 'ERROR');
    }
});

// /admin
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        if (!CONFIG.ADMIN_IDS.includes(userId)) {
            await bot.sendMessage(chatId, '❌ Admin only command.');
            return;
        }

        const stats = await getStats();

        const message = `
📊 *Admin Dashboard*

📈 Revenue: $${stats.totalRevenue.toLocaleString()}
💳 Payments: ${stats.totalPayments}
👥 Total Users: ${stats.totalUsers}
⭐ Premium: ${stats.premiumUsers}
⏳ Pending: ${stats.pendingPayments}
        `;

        await bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Stats', callback_data: 'admin_stats' }],
                    [{ text: '⏳ Pending', callback_data: 'admin_pending' }]
                ]
            }
        });
    } catch (err) {
        log(`Admin command error: ${err.message}`, 'ERROR');
    }
});

// ============================================
// CALLBACK QUERIES
// ============================================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const action = query.data;

    try {
        await bot.answerCallbackQuery(query.id);
        await updateUserActivity(userId);

        if (action.startsWith('plan_')) {
            const planId = action.replace('plan_', '');
            
            try {
                await bot.sendChatAction(chatId, 'typing');
                const invoice = await createInvoice(userId, chatId, planId);
                const plan = CONFIG.PRICING[planId];

                const message = `
💳 *Payment Details*

Plan: ${plan.emoji} ${plan.label}
Amount: $${plan.amount}
Status: ⏳ PENDING

Payment ID: \`${invoice.orderId}\`

Click below to complete payment:
                `;

                await bot.sendMessage(chatId, message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '💳 PAY NOW', url: invoice.invoiceUrl }],
                            [{ text: '📊 Check Status', callback_data: 'check_status' }],
                            [{ text: '❌ Cancel', callback_data: 'cancel' }]
                        ]
                    }
                });

                log(`User ${userId} selected plan: ${planId}`);
            } catch (err) {
                await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
                log(`Invoice error for user ${userId}: ${err.message}`, 'ERROR');
            }
        } else if (action === 'confirm_payment') {
            const pending = await getPendingPaymentByUser(userId);
            
            if (!pending) {
                await bot.sendMessage(chatId, '❌ No pending payment found.');
                return;
            }

            const confirmed = await confirmPayment(pending.orderId);
            
            if (confirmed) {
                const plan = CONFIG.PRICING[pending.planId];
                const status = await getPremiumStatus(userId);
                
                const message = `
🎉 *PAYMENT CONFIRMED!*

✅ Your premium subscription is now active!

📅 Plan: ${plan.emoji} ${plan.label}
📆 Days: ${plan.days}
⏰ Expires: ${new Date(status.expiryDate).toLocaleDateString()}

🚀 *Premium Features Unlocked!*
• Real-time alerts
• Bundle detection
• Whale tracking
• Security scanning
• And more!

*Thank you for upgrading!* 🙏
                `;

                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                log(`✅ Payment confirmed for user ${userId}: ${pending.orderId}`);
                await bot.sendMessage(CONFIG.ADMIN_UNIQUE_ID, `✅ Payment confirmed for user ${userId}: ${pending.orderId}`);
            } else {
                await bot.sendMessage(chatId, `
❌ *Payment not confirmed*

Payment ID: \`${pending.orderId}\`

Please wait a few moments for payment to be confirmed.
Click /status to check again.
                `, { parse_mode: 'Markdown' });
            }
        } else if (action === 'check_status') {
            const pending = await getPendingPaymentByUser(userId);
            const status = await getPremiumStatus(userId);
            
            if (!pending && status.isPremium) {
                const message = `
✅ *You are PREMIUM!*

📅 Tier: ${status.tier}
⏰ Expires: ${new Date(status.expiryDate).toLocaleDateString()}
📆 Days remaining: ${status.expiresIn}
                `;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else if (pending) {
                const paid = await redis.sismember('payment_ids', pending.orderId);
                const plan = CONFIG.PRICING[pending.planId];
                
                if (paid) {
                    const message = `
✅ *Payment Detected!*

Amount: $${pending.amount}
Status: Processing confirmation...

Click below to activate premium:
                    `;
                    await bot.sendMessage(chatId, message, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Activate Premium', callback_data: 'confirm_payment' }]
                            ]
                        }
                    });
                } else {
                    const message = `
⏳ *Payment Pending*

Amount: $${pending.amount}
Plan: ${plan?.label || 'Unknown'}

If you've already paid, the system will confirm within a few minutes.
                    `;
                    await bot.sendMessage(chatId, message, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🔄 Check Again', callback_data: 'check_status' }],
                                [{ text: '💳 Pay Now', url: pending.invoiceUrl }]
                            ]
                        }
                    });
                }
            } else {
                await bot.sendMessage(chatId, '🔓 You are currently FREE. Use /pay to upgrade.');
            }
        } else if (action === 'show_pricing' || action === 'view_features') {
            const message = `
💎 *PREMIUM PLANS*

Choose your plan:

📅 Monthly - $49
📆 Yearly - $550
👑 Lifetime - $5,000
💎 VIP - $6,000
            `;

            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📅 Monthly', callback_data: 'plan_MONTHLY' },
                            { text: '📆 Yearly', callback_data: 'plan_YEARLY' }
                        ],
                        [
                            { text: '👑 Lifetime', callback_data: 'plan_LIFETIME' },
                            { text: '💎 VIP', callback_data: 'plan_VIP' }
                        ]
                    ]
                }
            });
        } else if (action === 'admin_stats') {
            if (!CONFIG.ADMIN_IDS.includes(userId)) return;
            
            const stats = await getStats();
            const message = `
📊 *Full Statistics*

👥 Total Users: ${stats.totalUsers}
⭐ Premium Users: ${stats.premiumUsers}
💰 Total Revenue: $${stats.totalRevenue.toLocaleString()}
💳 Total Payments: ${stats.totalPayments}
⏳ Pending: ${stats.pendingPayments}
📈 Conversion: ${stats.totalUsers > 0 ? Math.round((stats.premiumUsers / stats.totalUsers) * 100) : 0}%
            `;
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } else if (action === 'cancel') {
            await bot.sendMessage(chatId, '❌ Payment cancelled.');
        }
    } catch (err) {
        log(`Callback error: ${err.message}`, 'ERROR');
        await bot.sendMessage(chatId, '❌ An error occurred. Please try again.');
    }
});

// ============================================
// NEW MEMBERS & GROUP HANDLERS
// ============================================
bot.on('new_chat_members', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const chatName = msg.chat.title || 'Group';

        for (const member of msg.new_chat_members) {
            if (member.is_bot) continue;

            const message = `
👋 *Welcome ${member.first_name} to ${chatName}!*

💎 Join our Premium Community:
• Early token detection ⚡
• Whale tracking alerts 🐋
• Security scanning 🔒
• And much more!

🚀 *Ready to upgrade?*
DM our bot to learn more!
            `;

            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Upgrade Now', callback_data: 'show_pricing' }]
                    ]
                }
            }).catch(() => {});

            log(`👋 New member ${member.first_name} joined ${chatName}`);
        }
    } catch (err) {
        log(`New members error: ${err.message}`, 'ERROR');
    }
});

bot.on('my_chat_member', async (update) => {
    try {
        if (update.new_chat_member.status === 'member' || update.new_chat_member.status === 'administrator') {
            const chatId = update.chat.id;
            const chatName = update.chat.title || 'Group';

            const message = `
🤖 *Elite Payment Bot Added!*

💰 *Premium Features Available:*
✅ Bundle detection
✅ Whale tracking
✅ Token security scanning
✅ Developer reputation
✅ Instant alerts
✅ And more!

📋 *Plans:*
📅 Monthly: $49
📆 Yearly: $550 (Save 16%)
👑 Lifetime: $5,000
💎 VIP: $6,000

💳 *Users can DM the bot to upgrade!*
            `;

            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '💳 Upgrade', callback_data: 'show_pricing' }]
                    ]
                }
            }).catch(() => {});

            log(`✅ Bot added to group: ${chatName}`);
        }
    } catch (err) {
        log(`Bot join error: ${err.message}`, 'ERROR');
    }
});

// ============================================
// ERROR HANDLING
// ============================================
bot.on('polling_error', (error) => {
    log(`Polling error: ${error.message}`, 'ERROR');
    log("⚠️ Could not connect to Telegram API. Check the token or internet service");
});

bot.on('error', (error) => {
    log(`Bot error: ${error.message}`, 'ERROR');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGINT', async () => {
    log('Shutting down bot...');
//    if (redis) await redis.close();
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('Shutting down bot...');
//    if (redis) await redis.close();
    bot.stopPolling();
    process.exit(0);
});

// ============================================
// START
// ============================================
log('✅ Elite Bot started successfully!');
log('📋 Commands: /start, /premium, /pay, /status, /history, /help, /admin');
log('💳 Payment plans: Monthly ($49), Yearly ($550), Lifetime ($5K), VIP ($6K)');
log('🔗 Using Redis database');

module.exports = bot;
