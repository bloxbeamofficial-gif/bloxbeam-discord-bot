#!/usr/bin/env node
// THREAD-BASED DISCORD BOT - Replaces channel-based system
// - No 50-channel limit
// - Each customer has private my-orders-{userId} channel with their order threads
// - Threads auto-DELETE when order is completed (not just archived)
// - Customers can't see each other

import { Client, GatewayIntentBits, ChannelType, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ThreadAutoArchiveDuration, PermissionFlagsBits } from 'discord.js';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const SERVER_ID = process.env.DISCORD_SERVER_ID;
const BACKEND_URL = process.env.BACKEND_URL || 'https://bloxbeam-backend.vercel.app';
const WEBHOOK_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || DISCORD_BOT_TOKEN;

// Role IDs from .env (use existing server roles instead of creating new ones)
const STAFF_ROLE_ID = process.env.DISCORD_STAFF_ROLE_ID;    // Owner role
const CUSTOMER_ROLE_ID = process.env.DISCORD_CUSTOMER_ROLE_ID; // Client role
const CLAIM_HERE_CHANNEL_ID = process.env.DISCORD_CLAIM_HERE_CHANNEL_ID; // Existing claim-here channel

// Validate required env vars
if (!DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN not set in .env.local');
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error('❌ DISCORD_CLIENT_ID not set in .env.local');
  process.exit(1);
}

if (!SERVER_ID) {
  console.error('❌ DISCORD_SERVER_ID not set in .env.local');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store active threads for keep-alive pings
const activeOrderThreads = new Map();

// Store order data temporarily
const activeOrders = new Map();

// Lock to prevent duplicate thread creation
const threadCreationLocks = new Set();

// STAFF_ROLE_ID and CUSTOMER_ROLE_ID are loaded from env vars above

// Helper: delay function for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: retry with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.message?.includes('rate limit') || error.code === 429;
      if (isRateLimit && attempt < maxRetries) {
        const waitTime = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⏳ Rate limited, waiting ${waitTime}ms before retry ${attempt}/${maxRetries}...`);
        await delay(waitTime);
      } else if (attempt === maxRetries) {
        throw error;
      }
    }
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getProductName(order, orderId = null) {
  if (order?.productSummary) return order.productSummary;
  if (order?.orderItems?.length > 0) {
    const names = order.orderItems.map(item => item.product?.name || item.productName).filter(Boolean);
    if (names.length > 0) return names.join(', ');
  }
  if (order?.product && order.product !== 'Unknown') return order.product;
  if (orderId && activeOrders.has(orderId)) {
    const cached = activeOrders.get(orderId);
    if (cached?.product) return cached.product;
  }
  return 'Unknown Product';
}

function getCustomerEmail(order, orderId = null) {
  if (order?.customerEmail) return order.customerEmail;
  if (order?.user?.email) return order.user.email;
  if (order?.email) return order.email;
  if (orderId && activeOrders.has(orderId)) {
    const cached = activeOrders.get(orderId);
    if (cached?.email) return cached.email;
  }
  return 'Not provided';
}

/**
 * Start keep-alive for a thread (prevents auto-archive)
 */
function startKeepAlive(thread, orderId) {
  if (activeOrderThreads.has(orderId)) {
    clearInterval(activeOrderThreads.get(orderId).interval);
  }
  
  const interval = setInterval(async () => {
    try {
      if (thread.archived || thread.locked) {
        clearInterval(interval);
        activeOrderThreads.delete(orderId);
        return;
      }
      const msg = await thread.send('⏳').catch(() => null);
      if (msg) await msg.delete().catch(() => {});
    } catch (e) {
      clearInterval(interval);
      activeOrderThreads.delete(orderId);
    }
  }, 60000);
  
  activeOrderThreads.set(orderId, { thread, interval });
}

function stopKeepAlive(orderId) {
  if (activeOrderThreads.has(orderId)) {
    clearInterval(activeOrderThreads.get(orderId).interval);
    activeOrderThreads.delete(orderId);
  }
}

// ============================================================
// SLASH COMMANDS
// ============================================================

const commands = [
  {
    name: 'complete',
    description: 'Mark an order as completed (auto-deletes threads)',
    default_member_permissions: '0', // Staff only - requires ManageMessages permission
    options: [{
      type: 3,
      name: 'order_id',
      description: 'The order ID to mark as completed',
      required: true
    }]
  },
  {
    name: 'order-status',
    description: 'Check the status of an order',
    default_member_permissions: '0', // Staff only
    options: [{
      type: 3,
      name: 'order_id',
      description: 'The order ID to check',
      required: true
    }]
  },
  {
    name: 'notify-customer',
    description: 'Send a message to customer\'s private order thread',
    default_member_permissions: '0', // Staff only
    options: [
      {
        type: 3,
        name: 'order_id',
        description: 'The order ID',
        required: true
      },
      {
        type: 3,
        name: 'message',
        description: 'Message to send to customer',
        required: true
      }
    ]
  },
  {
    name: 'send-server-link',
    description: 'Send a private server link to customer',
    default_member_permissions: '0', // Staff only
    options: [
      {
        type: 3,
        name: 'order_id',
        description: 'The order ID',
        required: true
      },
      {
        type: 3,
        name: 'link',
        description: 'Private server link',
        required: true
      }
    ]
  }
];

// ============================================================
// BOT READY - Setup categories and permissions
// ============================================================

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  try {
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) {
      console.error('❌ Bot is not in the specified server');
      return;
    }
    
    const botUserId = client.user.id;
    
    // Register slash commands
    const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
    console.log('📝 Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, SERVER_ID), { body: commands });
    console.log('✅ Slash commands registered!');
    
    // Use existing server roles from env vars (no role creation)
    const staffRole = STAFF_ROLE_ID ? guild.roles.cache.get(STAFF_ROLE_ID) : null;
    const customerRole = CUSTOMER_ROLE_ID ? guild.roles.cache.get(CUSTOMER_ROLE_ID) : null;
    if (staffRole) {
      console.log(`✅ Staff role: ${staffRole.name} (${staffRole.id})`);
    } else {
      console.warn('⚠️ DISCORD_STAFF_ROLE_ID not set or role not found — staff features disabled');
    }
    if (customerRole) {
      console.log(`✅ Customer role: ${customerRole.name} (${customerRole.id})`);
    } else {
      console.warn('⚠️ DISCORD_CUSTOMER_ROLE_ID not set or role not found — auto-assign disabled');
    }
    
    // =================================================
    // CLAIM-HERE CHANNEL (use existing channel from env)
    // =================================================
    let claimHereChannel = CLAIM_HERE_CHANNEL_ID 
      ? guild.channels.cache.get(CLAIM_HERE_CHANNEL_ID) 
      : guild.channels.cache.find(ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText);
    
    if (claimHereChannel) {
      // Ensure bot has correct permissions on the existing channel
      await claimHereChannel.permissionOverwrites.edit(botUserId, {
        ViewChannel: true,
        SendMessages: true,
        ManageChannels: true,
        ManageThreads: true,
        CreatePrivateThreads: true,
        ReadMessageHistory: true,
        ManageMessages: true
      }).catch(e => console.warn('⚠️ Could not update bot permissions on claim-here:', e.message));
      if (staffRole) {
        await claimHereChannel.permissionOverwrites.edit(staffRole.id, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          SendMessagesInThreads: true,
          ManageThreads: true
        }).catch(e => console.warn('⚠️ Could not update staff permissions on claim-here:', e.message));
      }
      console.log(`✅ Using existing claim-here channel: #${claimHereChannel.name} (${claimHereChannel.id})`);
    } else {
      console.error('❌ claim-here channel not found! Set DISCORD_CLAIM_HERE_CHANNEL_ID in .env');
    }
    
    // =================================================
    // DASHBOARD CATEGORY (staff analytics)
    // =================================================
    let dashboardCategory = guild.channels.cache.find(
      ch => ch.name === 'Dashboard' && ch.type === ChannelType.GuildCategory
    );
    
    if (!dashboardCategory) {
      dashboardCategory = await guild.channels.create({
        name: 'Dashboard',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: SERVER_ID, deny: [PermissionFlagsBits.ViewChannel] },
          { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
          { id: customerRole.id, deny: [PermissionFlagsBits.ViewChannel] }
        ]
      });
      console.log('✅ Created Dashboard category');
    }
    
    // =================================================
    // ORDER-SAVED CHANNEL (logs completed orders)
    // =================================================
    let orderSavedChannel = guild.channels.cache.find(
      ch => ch.name === 'order-saved' && ch.type === ChannelType.GuildText
    );
    
    if (!orderSavedChannel) {
      orderSavedChannel = await guild.channels.create({
        name: 'order-saved',
        type: ChannelType.GuildText,
        parent: dashboardCategory.id,
        topic: '📋 Completed order logs - All delivered orders are saved here',
        permissionOverwrites: [
          { id: SERVER_ID, deny: [PermissionFlagsBits.ViewChannel] },
          { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
          { id: customerRole.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ]
      });
      console.log('✅ Created order-saved channel');
    }
    
    // =================================================
    // new-orders CHANNEL (pings staff for new orders)
    // =================================================
    let staffNotifyChannel = guild.channels.cache.find(
      ch => ch.name === 'new-orders' && ch.type === ChannelType.GuildText
    );
    
    if (!staffNotifyChannel) {
      staffNotifyChannel = await guild.channels.create({
        name: 'new-orders',
        type: ChannelType.GuildText,
        parent: dashboardCategory.id,
        topic: '🔔 New order notifications - Staff get pinged here for new orders',
        permissionOverwrites: [
          { id: SERVER_ID, deny: [PermissionFlagsBits.ViewChannel] },
          { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
          { id: customerRole.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ]
      });
      console.log('✅ Created new-orders channel');
    }
    
    console.log('🎉 SETUP COMPLETE!');
    console.log('📊 STAFF: Added directly to customer threads in #claim-here');
    console.log('👤 CUSTOMER: Private threads in #claim-here channel');
    
    // =================================================
    // CLEANUP: Delete empty threads (no order embeds)
    // =================================================
    try {
      const claimHereChannel = CLAIM_HERE_CHANNEL_ID
        ? guild.channels.cache.get(CLAIM_HERE_CHANNEL_ID)
        : guild.channels.cache.find(ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText);
      
      if (claimHereChannel) {
        console.log('🧹 Scanning for empty threads to clean up...');
        const activeThreads = await claimHereChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
        const archivedThreads = await claimHereChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
        
        const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
        let deletedCount = 0;
        
        for (const thread of allThreads) {
          try {
            // Fetch messages to check if thread has order embeds
            const messages = await thread.messages.fetch({ limit: 10 });
            const hasOrderEmbed = messages.some(m => 
              m.embeds?.length > 0 && 
              (m.embeds[0]?.title?.includes('Order Details') || 
               m.embeds[0]?.title?.includes('How Delivery Works'))
            );
            
            if (!hasOrderEmbed) {
              console.log(`🗑️ Deleting empty thread: ${thread.name}`);
              await thread.delete().catch(() => {});
              deletedCount++;
            }
          } catch (e) {
            // Skip threads we can't access
          }
        }
        
        if (deletedCount > 0) {
          console.log(`✅ Cleaned up ${deletedCount} empty thread(s)`);
        } else {
          console.log('✅ No empty threads found');
        }
      }
    } catch (cleanupErr) {
      console.warn('⚠️ Thread cleanup error:', cleanupErr.message);
    }
    
  } catch (error) {
    console.error('❌ Setup error:', error);
  }
});

// ============================================================
// NEW MEMBER JOINS - Create threads for pending orders + send DM with links
// ============================================================

client.on('guildMemberAdd', async (member) => {
  try {
    console.log(`👋 New member: ${member.user.tag} (ID: ${member.id})`);
    
    const guild = member.guild;
    const customerRole = CUSTOMER_ROLE_ID ? guild.roles.cache.get(CUSTOMER_ROLE_ID) : null;
    
    // Assign Customer/Client role
    if (customerRole) {
      await member.roles.add(customerRole);
    }
    
    // Don't check for old orders - new orders will trigger their own DM via webhook
    // When a customer joins, we just assign the Customer role and wait for new orders
    console.log(`✅ Customer role assigned to ${member.user.tag}`);
    
  } catch (error) {
    console.error('❌ guildMemberAdd error:', error.message);
  }
});

// ============================================================
// CREATE CUSTOMER ORDER THREAD
// ============================================================

async function createCustomerOrderThread(guild, member, order) {
  const userId = member.id;
  const botUserId = guild.client.user.id;
  const orderId = order.orderId || order.id;
  
  // Debug logging to verify order data
  console.log(`📦 Creating customer thread with order data:`, {
    orderId,
    email: order.email || order.customerEmail,
    total: order.total || order.totalPaid,
    discountAmount: order.discountAmount || order.discount,
    discountCode: order.discountCode || order.promoCode,
    affiliateCode: order.affiliateCode,
    orderItemsCount: order.orderItems?.length || 0,
    productSummary: order.productSummary
  });
  
  console.log(`📝 Creating thread for order ${orderId}...`);
  
  const staffRole = STAFF_ROLE_ID ? guild.roles.cache.get(STAFF_ROLE_ID) : null;
  
  // Find claim-here channel
  let claimHereChannel = CLAIM_HERE_CHANNEL_ID
    ? guild.channels.cache.get(CLAIM_HERE_CHANNEL_ID)
    : guild.channels.cache.find(ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText);
  
  if (!claimHereChannel) {
    console.error('❌ claim-here channel not found! Set DISCORD_CLAIM_HERE_CHANNEL_ID in .env');
    return null;
  }
  
  // Check if thread already exists
  const orderSuffix = orderId.slice(-6).toUpperCase();
  
  // Prevent duplicate thread creation with a lock
  const lockKey = `${userId}-${orderId}`;
  if (threadCreationLocks.has(lockKey)) {
    console.log(`⚠️ Thread creation already in progress for ${orderId}, skipping...`);
    return null;
  }
  threadCreationLocks.add(lockKey);
  
  try {
    const activeThreads = await claimHereChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
    const archivedThreads = await claimHereChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
  
  const existingThread = [...activeThreads.threads.values(), ...archivedThreads.threads.values()]
    .find(t => t.name.includes(orderSuffix));
  
  // Delete existing empty thread if found
  if (existingThread) {
    console.log(`🗑️ Found existing thread for ${orderId}, deleting it to create fresh one...`);
    await existingThread.delete().catch(e => console.warn(`⚠️ Could not delete old thread:`, e.message));
  }
  
  // Create PRIVATE order thread (only customer + staff can see it)
  const orderThread = await claimHereChannel.threads.create({
    name: `📦 Order-${orderSuffix}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false, // Only added members can see
    reason: `Order thread for ${orderId}`
  });
  
  // Add customer to thread
  await orderThread.members.add(userId).catch(e => console.warn(`⚠️ Could not add customer to thread:`, e.message));
  console.log(`✅ Added customer ${userId} to thread`);
  
  // Add all staff members to the thread so they get notifications
  // Use role.members instead of fetching all guild members to avoid rate limits
  if (staffRole) {
    const staffMembers = staffRole.members;
    console.log(`👥 Adding ${staffMembers.size} staff member(s) to customer thread...`);
    for (const [, staffMember] of staffMembers) {
      await delay(100); // Small delay between adds to avoid rate limits
      await orderThread.members.add(staffMember.id).catch(e => console.warn(`⚠️ Could not add ${staffMember.user.tag}:`, e.message));
    }
    console.log(`✅ Staff members added to thread`);
  }
  
  // Build order details
  const products = order.orderItems || order.products || [];
  let itemsList = products.length > 0
    ? products.map(p => {
        const qty = Number(p.quantity || 1);
        const price = Number(p.price || 0);
        const name = p.product?.name || p.name || 'Product';
        return `• **${name}** (x${qty}) - $${price.toFixed(2)}`;
      }).join('\n')
    : order.productSummary || 'Unknown';
  
  const formattedDate = order.createdAt 
    ? new Date(order.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : 'Unknown';
  
  // Instruction embed
  const instructionEmbed = new EmbedBuilder()
    .setTitle('🎮 How Delivery Works')
    .setDescription('Welcome to your private order thread! Here\'s what happens next:')
    .setColor(0x5865F2)
    .addFields(
      { name: '⏳ Step 1: Wait for Staff', value: 'A staff member will join this thread shortly to assist with your delivery.', inline: false },
      { name: '🔗 Step 2: Private Server Link', value: 'You\'ll receive a Roblox private server link in this thread.', inline: false },
      { name: '🎁 Step 3: Join & Claim', value: 'Click the link, join the server, and claim your items!', inline: false },
      { name: '⭐ Step 4: Leave a Review', value: 'After delivery, we\'d love your feedback on our website!', inline: false },
      { name: '💬 Questions?', value: 'Feel free to ask anything in this thread - staff will respond ASAP!', inline: false }
    )
    .setFooter({ text: 'This thread is private - only you and staff can see it' })
    .setTimestamp();
  
  // Get optional fields
  const customerEmail = order.email || order.customerEmail || order.user?.email || 'Not provided';
  const discountCode = order.discountCode || order.promoCode || order.couponCode || null;
  const discountPercent = order.discountPercent || order.promoDiscount || null;
  const discountType = order.discountType || order.promoType || null;
  const discountAmount = Number(order.discountAmount || order.discount || 0);
  const totalPaid = Number(order.total || order.totalPaid || 0);
  const affiliateCode = order.affiliateCode || null;
  const affiliateName = order.affiliateName || null;
  const affiliateDiscount = order.affiliateDiscount || null;
  
  // Calculate original price (total + discount)
  const originalPrice = totalPaid + discountAmount;
  
  // Order details embed
  const orderFields = [
    { name: '📋 Order ID', value: `\`${orderId}\``, inline: true },
    { name: '📅 Date', value: formattedDate, inline: true },
    { name: '⏱️ Status', value: order.status || 'PROCESSING', inline: true },
    { name: '🎮 Roblox', value: `\`${order.robloxUsername || 'Not linked'}\``, inline: true },
    { name: '📧 Email', value: `\`${customerEmail}\``, inline: true },
    { name: '🛒 Items', value: itemsList, inline: false },
  ];
  
  // Show Original Price if there was a discount
  if (discountAmount > 0) {
    orderFields.push({ name: '💵 Original Price', value: `~~$${originalPrice.toFixed(2)}~~`, inline: true });
  }
  
  // Always show Total Paid
  orderFields.push({ name: '💰 Total Paid', value: `**$${totalPaid.toFixed(2)}**`, inline: true });
  
  // Add savings if there was a discount
  if (discountAmount > 0) {
    orderFields.push({ name: '🎉 You Saved', value: `**$${discountAmount.toFixed(2)}**`, inline: true });
  }
  
  // Add promo code with percentage if used
  if (discountCode) {
    let promoDisplay = `\`${discountCode}\``;
    if (discountPercent) {
      promoDisplay += ` (${discountPercent}% OFF)`;
    } else if (discountType === 'fixed' && discountAmount > 0) {
      promoDisplay += ` ($${discountAmount.toFixed(2)} OFF)`;
    }
    orderFields.push({ name: '🎟️ Promo Code Used', value: promoDisplay, inline: true });
  }
  
  // Add affiliate code if used
  if (affiliateCode || affiliateName) {
    let affiliateDisplay = `\`${affiliateCode}\``;
    if (affiliateDiscount) {
      affiliateDisplay += ` (${affiliateDiscount}% OFF)`;
    }
    if (affiliateName) {
      affiliateDisplay += ` - Referred by: ${affiliateName}`;
    }
    orderFields.push({ name: '👥 Referred By', value: affiliateDisplay, inline: true });
  }
  
  const orderEmbed = new EmbedBuilder()
    .setTitle('📦 Order Details')
    .setDescription('Here\'s a summary of your BloxBeam order:')
    .setColor(0x3DFF88)
    .addFields(orderFields)
    .setFooter({ text: 'Thank you for shopping with BloxBeam! 💚' })
    .setTimestamp();
  
  await orderThread.send({ embeds: [instructionEmbed] });
  await orderThread.send({ embeds: [orderEmbed] });
  
  // Ping customer and staff so they see the thread
  await orderThread.send(`<@${userId}> 👋 Your order thread is ready! <@&${staffRole?.id}> 🔔 New order!`);
  
  // Save thread ID and URL to backend for permanent record
  const threadUrl = `https://discord.com/channels/${guild.id}/${orderThread.id}`;
  await axios.patch(`${BACKEND_URL}/api/orders/${orderId}`, {
    discordThreadId: orderThread.id,
    discordThreadUrl: threadUrl
  }, {
    headers: { 'X-Webhook-Secret': WEBHOOK_SECRET }
  }).catch(e => console.warn(`⚠️ Could not save thread URL to backend:`, e.message));
  console.log(`💾 Saved thread URL: ${threadUrl}`);
  
  // Start keep-alive
  startKeepAlive(orderThread, orderId);
  
  console.log(`✅ Created order thread: Order-${orderSuffix}`);
  
  // Release the lock
  threadCreationLocks.delete(lockKey);
  
  return orderThread;
  } catch (error) {
    // Release lock on error
    threadCreationLocks.delete(lockKey);
    throw error;
  }
}

// ============================================================
// COMPLETE ORDER - DELETE THREADS
// ============================================================

async function completeOrder(guild, orderId, completedBy) {
  console.log(`✅ Completing order ${orderId} - DELETING threads...`);
  
  const orderSuffix6 = orderId.slice(-6).toUpperCase();
  let deletedCount = 0;
  
  // Stop keep-alive
  stopKeepAlive(orderId);
  
  // Find or create order-saved channel for logging
  let orderSavedChannel = guild.channels.cache.find(
    ch => ch.name === 'order-saved' && ch.type === ChannelType.GuildText
  );
  
  if (!orderSavedChannel) {
    const dashboardCategory = guild.channels.cache.find(
      ch => ch.name === 'Dashboard' && ch.type === ChannelType.GuildCategory
    );
    const staffRole = STAFF_ROLE_ID ? guild.roles.cache.get(STAFF_ROLE_ID) : null;
    const botUserId = guild.client.user.id;
    
    orderSavedChannel = await guild.channels.create({
      name: 'order-saved',
      type: ChannelType.GuildText,
      parent: dashboardCategory?.id,
      topic: '📋 Completed order logs',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: staffRole?.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
      ].filter(p => p.id)
    });
  }
  
  // =================================================
  // FIND order threads in claim-here channel
  // =================================================
  const claimHereChannel = guild.channels.cache.find(
    ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText
  );
  
  if (claimHereChannel) {
    try {
      const activeThreads = await claimHereChannel.threads.fetchActive();
      const archivedThreads = await claimHereChannel.threads.fetchArchived();
      
      const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
      const orderThreads = allThreads.filter(t => t.name.includes(orderSuffix6));
      
      for (const thread of orderThreads) {
        try {
          // Fetch thread messages to get order details
          const messages = await thread.messages.fetch({ limit: 10 });
          const orderEmbed = messages.find(m => m.embeds?.[0]?.title?.includes('Order Details'))?.embeds?.[0];
          
          // Get thread URL for permanent record
          const threadUrl = `https://discord.com/channels/${guild.id}/${thread.id}`;
          
          // Log to order-saved channel
          const logEmbed = {
            title: '✅ Order Delivered & Archived',
            description: 'This order has been successfully completed and the thread is now archived.',
            color: 0x00FF00,
            fields: [
              { name: '📦 Order ID', value: `\`${orderId}\``, inline: true },
              { name: '👨‍💼 Delivered By', value: `<@${completedBy}>`, inline: true },
              { name: '📅 Completed', value: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), inline: true },
              { name: '🔗 Thread Archive', value: `[View archived thread](${threadUrl})`, inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'BloxBeam Order Log • Thread archived for records' }
          };
          
          // Add ALL order details from the embed if found
          if (orderEmbed) {
            for (const field of orderEmbed.fields || []) {
              // Skip duplicate Order ID field
              if (field.name.includes('Order ID')) continue;
              logEmbed.fields.push({ name: field.name, value: field.value, inline: field.inline });
            }
          }
          
          await orderSavedChannel.send({ embeds: [logEmbed] });
          console.log(`📋 Logged order ${orderId} to order-saved`);
          
          // Send completion message to customer thread
          await thread.send({
            embeds: [{
              title: '🎉 ORDER DELIVERED!',
              description: 'Your items have been successfully delivered to your Roblox account!',
              color: 0x00FF00,
              fields: [
                { name: '📦 Order ID', value: `\`${orderId}\``, inline: true },
                { name: '👨‍💼 Delivered By', value: `<@${completedBy}>`, inline: true },
                { name: '📅 Completed', value: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), inline: true },
                { name: '⭐ Leave a Review', value: 'We\'d love to hear your feedback! Leave us a review on our website or Discord.', inline: false },
                { name: '🔄 Order Again?', value: 'Visit [bloxbeam.com](https://bloxbeam.com) for more items!', inline: false },
                { name: '📁 Thread Status', value: 'This thread will be archived shortly. You can still view it in your thread history.', inline: false }
              ],
              footer: { text: 'Thank you for shopping with BloxBeam! 💚' },
              timestamp: new Date().toISOString()
            }]
          });
          
          // DM the customer that their order is delivered
          try {
            const threadMembers = await thread.members.fetch();
            // Find customer (not staff, not bot)
            for (const [memberId, threadMember] of threadMembers) {
              if (memberId === guild.client.user.id) continue; // Skip bot
              const guildMember = await guild.members.fetch(memberId).catch(() => null);
              if (!guildMember) continue;
              if (STAFF_ROLE_ID && guildMember.roles.cache.has(STAFF_ROLE_ID)) continue; // Skip staff
              
              // This is the customer - send DM
              await guildMember.user.send({
                embeds: [{
                  title: '🎉 ORDER DELIVERED!',
                  description: 'Your items have been successfully delivered to your Roblox account!',
                  color: 0x00FF00,
                  fields: [
                    { name: '📦 Order ID', value: `\`${orderId}\``, inline: true },
                    { name: '👨‍💼 Delivered By', value: `<@${completedBy}>`, inline: true },
                    { name: '📅 Completed', value: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), inline: true },
                    { name: '⭐ Leave a Review', value: 'We\'d love to hear your feedback! Leave us a review on our website or Discord.', inline: false },
                    { name: '🔄 Order Again?', value: 'Visit [bloxbeam.com](https://bloxbeam.com) for more items!', inline: false }
                  ],
                  footer: { text: 'Thank you for shopping with BloxBeam! 💚' },
                  timestamp: new Date().toISOString()
                }]
              });
              console.log(`✅ Sent delivery confirmation DM to ${guildMember.user.tag}`);
              break; // Only DM first customer found
            }
          } catch (dmErr) {
            console.warn(`⚠️ Could not DM customer:`, dmErr.message);
          }
          
          // Archive and lock thread (don't delete - keep for history)
          setTimeout(async () => {
            try {
              await thread.setLocked(true);
              await thread.setArchived(true);
              console.log(`🔒 Archived and locked thread: ${thread.name}`);
            } catch (e) {
              console.warn(`⚠️ Could not archive thread:`, e.message);
            }
          }, 10000); // Archive after 10 seconds
          
          deletedCount++;
        } catch (e) {
          console.warn(`⚠️ Could not process thread ${thread.name}:`, e.message);
        }
      }
    } catch (e) {
      console.warn(`⚠️ Error with threads:`, e.message);
    }
  }
  
  return deletedCount;
}

// ============================================================
// HANDLE SLASH COMMANDS
// ============================================================

client.on('interactionCreate', async (interaction) => {
  // Handle button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('complete_order_')) {
      // Check if user has staff role for button clicks too
      const member = interaction.member;
      const hasStaffRole = member && member.roles && member.roles.cache.has(STAFF_ROLE_ID);
      if (!hasStaffRole) {
        await interaction.reply({ content: '❌ Only staff members can complete orders.', ephemeral: true }).catch(() => {});
        return;
      }
      const orderId = interaction.customId.replace('complete_order_', '');
      await handleCompleteOrder(interaction, orderId);
    }
    return;
  }
  
  if (!interaction.isChatInputCommand()) return;
  
  const { commandName } = interaction;
  
  // Staff-only commands - check for Staff role
  const staffCommands = ['complete', 'order-status', 'notify-customer', 'send-server-link'];
  if (staffCommands.includes(commandName)) {
    const member = interaction.member;
    const hasStaffRole = member && member.roles && member.roles.cache.has(STAFF_ROLE_ID);
    if (!hasStaffRole) {
      await interaction.reply({ 
        content: '❌ This command is only available to staff members.', 
        ephemeral: true 
      }).catch(() => {});
      return;
    }
  }
  
  try {
    if (commandName === 'complete') {
      const orderId = interaction.options.getString('order_id');
      await handleCompleteOrder(interaction, orderId);
    } else if (commandName === 'order-status') {
      await handleStatusCommand(interaction);
    } else if (commandName === 'notify-customer') {
      await handleNotifyCustomer(interaction);
    } else if (commandName === 'send-server-link') {
      await handleSendServerLink(interaction);
    }
  } catch (error) {
    console.error('❌ Command error:', error);
    await interaction.reply({ content: '❌ An error occurred', ephemeral: true }).catch(() => {});
  }
});

async function handleCompleteOrder(interaction, orderId) {
  await interaction.deferReply({ ephemeral: true });
  
  try {
    console.log(`⏳ Completing order ${orderId}...`);
    
    // Update backend
    const updateResponse = await axios.patch(
      `${BACKEND_URL}/api/orders/${orderId}`,
      {
        status: 'DELIVERED',
        deliveryStep: 'COMPLETE',
        completedAt: new Date().toISOString(),
        completedBy: String(interaction.user.id)
      },
      {
        headers: { 'X-Webhook-Secret': WEBHOOK_SECRET }
      }
    );
    
    const order = updateResponse.data;
    console.log(`✅ Order ${orderId} marked as complete`);
    
    // Unlock delivery page
    await axios.post(`${BACKEND_URL}/api/orders/${orderId}/delivery-state`, {
      action: 'DELIVERY_COMPLETED',
      step: 'COMPLETED'
    }, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET }
    }).catch(() => {});
    
    // DELETE all threads for this order (this also sends the delivery DM to customer)
    const guild = client.guilds.cache.get(SERVER_ID);
    const deletedCount = await completeOrder(guild, orderId, interaction.user.id);
    
    // Reply to staff
    await interaction.editReply({
      embeds: [{
        title: '✅ Order Completed',
        description: `Order **${orderId}** has been delivered.\n\n**${deletedCount}** thread(s) will be deleted.`,
        color: 0x00FF00,
        footer: { text: `Completed by ${interaction.user.tag}` }
      }]
    });
    
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.response?.data?.error || error.message || 'Unknown error';
    console.error('❌ Complete order error:', errorMsg, error.response?.data);
    await interaction.editReply({
      content: `❌ Failed to complete order: ${errorMsg}`
    });
  }
}

async function handleStatusCommand(interaction) {
  const orderId = interaction.options.getString('order_id');
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const response = await axios.get(`${BACKEND_URL}/api/orders/${orderId}`);
    const order = response.data;
    
    const embed = new EmbedBuilder()
      .setColor(order.status === 'DELIVERED' ? 0x00FF00 : 0xFFAA00)
      .setTitle(`Order Status: ${orderId}`)
      .addFields(
        { name: 'Status', value: order.status || 'PENDING', inline: true },
        { name: 'Roblox', value: order.robloxUsername || 'Not set', inline: true },
        { name: 'Discord', value: order.discordId ? 'Linked' : 'Not linked', inline: true }
      )
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ content: `❌ Order not found: ${orderId}` });
  }
}

// ============================================================
// NOTIFY CUSTOMER - Send message to customer's private thread
// ============================================================

async function handleNotifyCustomer(interaction) {
  const orderId = interaction.options.getString('order_id');
  const message = interaction.options.getString('message');
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const guild = client.guilds.cache.get(SERVER_ID);
    const orderSuffix6 = orderId.slice(-6).toUpperCase();
    
    // Find claim-here channel
    const claimHereChannel = guild.channels.cache.find(
      ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText
    );
    
    if (!claimHereChannel) {
      return await interaction.editReply({ content: '❌ claim-here channel not found' });
    }
    
    let sent = false;
    
    try {
      const activeThreads = await claimHereChannel.threads.fetchActive();
      const archivedThreads = await claimHereChannel.threads.fetchArchived();
      
      const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
      const orderThread = allThreads.find(t => t.name.includes(orderSuffix6));
      
      if (orderThread) {
        // Unarchive if needed
        if (orderThread.archived) {
          await orderThread.setArchived(false);
        }
        
        // Send message as embed
        await orderThread.send({
          embeds: [{
            title: '📨 Message from Staff',
            description: message,
            color: 0x5865F2,
            footer: { text: `From: ${interaction.user.tag}` },
            timestamp: new Date().toISOString()
          }]
        });
        
        sent = true;
        
        await interaction.editReply({
          embeds: [{
            title: '✅ Message Sent',
            description: `Your message was sent to the customer's order thread.`,
            color: 0x00FF00,
            fields: [
              { name: 'Order', value: orderId, inline: true },
              { name: 'Message', value: message.substring(0, 100) + (message.length > 100 ? '...' : ''), inline: false }
            ]
          }]
        });
      }
    } catch (e) {
      console.warn(`⚠️ Error searching threads:`, e.message);
    }
    
    if (!sent) {
      await interaction.editReply({ content: `❌ Could not find order thread for ${orderId}` });
    }
    
  } catch (error) {
    console.error('❌ Notify customer error:', error.message);
    await interaction.editReply({ content: `❌ Error: ${error.message}` });
  }
}

// ============================================================
// SEND SERVER LINK - Send private server link to customer
// ============================================================

async function handleSendServerLink(interaction) {
  const orderId = interaction.options.getString('order_id');
  const link = interaction.options.getString('link');
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    const guild = client.guilds.cache.get(SERVER_ID);
    const orderSuffix6 = orderId.slice(-6).toUpperCase();
    
    // Find claim-here channel
    const claimHereChannel = guild.channels.cache.find(
      ch => ch.name === 'claim-here' && ch.type === ChannelType.GuildText
    );
    
    if (!claimHereChannel) {
      return await interaction.editReply({ content: '❌ claim-here channel not found' });
    }
    
    let sent = false;
    
    try {
      const activeThreads = await claimHereChannel.threads.fetchActive();
      const archivedThreads = await claimHereChannel.threads.fetchArchived();
      
      const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
      const orderThread = allThreads.find(t => t.name.includes(orderSuffix6));
      
      if (orderThread) {
        // Unarchive if needed
        if (orderThread.archived) {
          await orderThread.setArchived(false);
        }
        
        // Send server link with prominent formatting
        await orderThread.send({
          embeds: [{
            title: '🎮 PRIVATE SERVER LINK',
            description: '**Click the link below to join the private server and receive your items!**',
            color: 0x3DFF88,
            fields: [
              { name: '🔗 Server Link', value: link },
              { name: '📝 Instructions', value: '1. Click the link above\n2. Join the private server\n3. Meet our staff member\n4. Claim your items!' }
            ],
            footer: { text: `Sent by: ${interaction.user.tag}` },
            timestamp: new Date().toISOString()
          }]
        });
        
        sent = true;
        
        await interaction.editReply({
          embeds: [{
            title: '✅ Server Link Sent',
            description: `Private server link has been sent to the customer.`,
            color: 0x00FF00,
            fields: [
              { name: 'Order', value: orderId, inline: true },
              { name: 'Link', value: link.substring(0, 50) + '...', inline: false }
            ]
          }]
        });
      }
    } catch (e) {
      console.warn(`⚠️ Error searching threads:`, e.message);
    }
    
    if (!sent) {
      await interaction.editReply({ content: `❌ Could not find order thread for ${orderId}` });
    }
    
  } catch (error) {
    console.error('❌ Send server link error:', error.message);
    await interaction.editReply({ content: `❌ Error: ${error.message}` });
  }
}

// ============================================================
// WEBHOOK SERVER
// ============================================================

const app = express();
app.use(express.json());

app.post('/webhook/create-ticket', async (req, res) => {
  try {
    // Verify webhook secret
    const webhookSecret = req.headers['x-webhook-secret'];
    const expectedSecret = process.env.INTERNAL_WEBHOOK_SECRET || process.env.DISCORD_BOT_TOKEN;
    if (!webhookSecret || webhookSecret !== expectedSecret) {
      console.warn('⚠️ Unauthorized webhook request rejected');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('🎯 Webhook received:', JSON.stringify(req.body, null, 2));
    
    const { user_id, order_id, email, product, roblox_username, stripe_payment_id, order_items, total_paid, discount_amount, original_price, order_date, promo_code, affiliate_code } = req.body;
    
    if (!user_id || !order_id) {
      return res.status(400).json({ error: 'Missing user_id or order_id' });
    }
    
    // Parse promo_code - can be string or object {code, discount, type}
    const promoCodeStr = typeof promo_code === 'object' ? promo_code?.code : promo_code;
    const promoDiscount = typeof promo_code === 'object' ? promo_code?.discount : null;
    const promoType = typeof promo_code === 'object' ? promo_code?.type : null;
    // Parse affiliate_code - can be string or object {code, username, discount}
    const affiliateCodeStr = typeof affiliate_code === 'object' ? affiliate_code?.code : affiliate_code;
    const affiliateName = typeof affiliate_code === 'object' ? affiliate_code?.username : null;
    const affiliateDiscount = typeof affiliate_code === 'object' ? affiliate_code?.discount : null;
    
    // Store order
    activeOrders.set(order_id, { user_id, email, product, roblox_username, discountCode: promoCodeStr, promoDiscount, promoType, affiliateCode: affiliateCodeStr, affiliateName, affiliateDiscount });
    
    // Save Discord ID to database
    await axios.patch(`${BACKEND_URL}/api/orders/${order_id}`, {
      discordId: String(user_id)
    }, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET }
    }).catch(() => {});
    
    const guild = client.guilds.cache.get(SERVER_ID);
    if (!guild) throw new Error('Bot is not in server');
    
    // Check if user is in server
    const member = await guild.members.fetch(user_id).catch(() => null);
    
    let customerThreadId = null;
    if (member) {
      // User is in server - create their order thread (staff are added automatically)
      const orderData = {
        orderId: order_id,
        email,
        productSummary: product,
        orderItems: order_items,
        total: total_paid,
        robloxUsername: roblox_username,
        discountCode: promoCodeStr,
        discountPercent: promoDiscount,
        discountType: promoType,
        discountAmount: discount_amount || 0,
        affiliateCode: affiliateCodeStr,
        affiliateName: affiliateName,
        affiliateDiscount: affiliateDiscount,
        stripePaymentId: stripe_payment_id,
        originalPrice: original_price || 0,
        status: 'PROCESSING',
        createdAt: order_date ? new Date(order_date) : new Date()
      };
      
      const customerThread = await createCustomerOrderThread(guild, member, orderData);
      customerThreadId = customerThread?.id;
      console.log(`✅ Created customer thread - staff automatically added`);
      // DM customer with thread link and full order details (only if in server)
      try {
        const threadUrl = `https://discord.com/channels/${SERVER_ID}/${customerThreadId}`;
        
        // Build items list with quantities
        let itemsList = product || 'Unknown';
        if (order_items && Array.isArray(order_items) && order_items.length > 0) {
          itemsList = order_items.map(p => {
            const qty = Number(p.quantity || 1);
            const price = Number(p.price || 0);
            const name = p.product?.name || p.name || 'Product';
            return `• **${name}** (x${qty}) - $${price.toFixed(2)}`;
          }).join('\n');
        }
        
        // Format date
        const formattedDate = order_date 
          ? new Date(order_date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
          : new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        
        // Build DM fields (same as order thread)
        const dmFields = [
          { name: '📋 Order ID', value: `\`${order_id}\``, inline: true },
          { name: '📅 Date', value: formattedDate, inline: true },
          { name: '⏱️ Status', value: 'PROCESSING', inline: true },
          { name: '🎮 Roblox', value: `\`${roblox_username || 'Not linked'}\``, inline: true },
          { name: '📧 Email', value: `\`${email || 'Not provided'}\``, inline: true },
          { name: '🛒 Items', value: itemsList, inline: false },
        ];
        
        // Add pricing details
        const totalPaid = Number(total_paid || 0);
        const discountAmt = Number(discount_amount || 0);
        const origPrice = Number(original_price || totalPaid + discountAmt);
        
        if (discountAmt > 0) {
          dmFields.push({ name: '💵 Original Price', value: `~~$${origPrice.toFixed(2)}~~`, inline: true });
        }
        dmFields.push({ name: '💰 Total Paid', value: `**$${totalPaid.toFixed(2)}**`, inline: true });
        
        if (discountAmt > 0) {
          dmFields.push({ name: '🎉 You Saved', value: `**$${discountAmt.toFixed(2)}**`, inline: true });
        }
        
        // Add promo code if used
        if (promoCodeStr) {
          let promoDisplay = `\`${promoCodeStr}\``;
          if (promoDiscount) {
            promoDisplay += ` (${promoDiscount}% OFF)`;
          }
          dmFields.push({ name: '🎟️ Promo Code', value: promoDisplay, inline: true });
        }
        
        // Add affiliate if used
        if (affiliateCodeStr) {
          let affDisplay = `\`${affiliateCodeStr}\``;
          if (affiliateDiscount) {
            affDisplay += ` (${affiliateDiscount}% OFF)`;
          }
          if (affiliateName) {
            affDisplay += ` - ${affiliateName}`;
          }
          dmFields.push({ name: '👥 Referred By', value: affDisplay, inline: true });
        }
        
        // Add thread link
        dmFields.push({ name: '🧵 Your Order Thread', value: `[Click here to open your thread](${threadUrl})`, inline: false });
        
        const dmEmbed = new EmbedBuilder()
          .setTitle('🎉 Order Confirmed!')
          .setColor(0x3DFF88)
          .setDescription('Thank you for your BloxBeam purchase!\n\n🧵 **Your private order thread is ready!**\nClick the link below to access your thread where staff will assist with delivery.')
          .addFields(dmFields)
          .setFooter({ text: 'BloxBeam • Your items will be delivered soon! 💚' })
          .setTimestamp();
        
        await member.user.send({ embeds: [dmEmbed] });
        console.log(`✅ DM sent to ${member.user.tag} with thread link`);
      } catch (e) {
        console.warn('⚠️ Could not DM user:', e.message);
      }
    } else {
      // User not in server yet - DM will be sent when they join
      console.log(`⏳ User ${user_id} not in server yet, thread + DM will happen when they join`);
    }
    
    // =================================================
    // NOTIFY STAFF - Channel ping + DM all staff
    // =================================================
    try {
      const staffRole = STAFF_ROLE_ID ? guild.roles.cache.get(STAFF_ROLE_ID) : null;
      
      // Build staff notification fields
      const staffNotifyFields = [
        { name: '📦 Order ID', value: `\`${order_id}\``, inline: true },
        { name: '💰 Total', value: `**$${Number(total_paid || 0).toFixed(2)}**`, inline: true },
      ];
      
      // Add promo code with % if used
      if (promoCodeStr) {
        let promoDisplay = `\`${promoCodeStr}\``;
        if (promoDiscount) {
          promoDisplay += ` (${promoDiscount}% OFF)`;
        }
        staffNotifyFields.push({ name: '🎟️ Promo Code', value: promoDisplay, inline: true });
      }
      
      // Add affiliate code with % if used
      if (affiliateCodeStr) {
        let affDisplay = `\`${affiliateCodeStr}\``;
        if (affiliateDiscount) {
          affDisplay += ` (${affiliateDiscount}% OFF)`;
        }
        staffNotifyFields.push({ name: '👥 Affiliate', value: affDisplay, inline: true });
      }
      
      // Add thread link
      staffNotifyFields.push({ 
        name: '🧵 Order Thread', 
        value: customerThreadId ? `<#${customerThreadId}>` : 'Pending (customer not in server)', 
        inline: false 
      });
      
      const staffNotifyEmbed = new EmbedBuilder()
        .setTitle('🔔 NEW ORDER!')
        .setColor(0xFF9900)
        .setDescription('A new order has been placed and needs delivery!')
        .addFields(staffNotifyFields)
        .setFooter({ text: 'Please deliver this order ASAP!' })
        .setTimestamp();
      
      // Find new-orders channel
      let staffNotifyChannel = guild.channels.cache.find(
        ch => ch.name === 'new-orders' && ch.type === ChannelType.GuildText
      );
      
      // Send to new-orders channel with ping
      if (staffNotifyChannel) {
        await staffNotifyChannel.send({
          content: `<@&${staffRole?.id}> 🚨 **New order incoming!**`,
          embeds: [staffNotifyEmbed]
        });
        console.log('✅ Sent notification to new-orders channel');
      }
      
      // DM all staff members - use role.members to avoid rate limits
      if (staffRole) {
        const staffMembers = staffRole.members;
        
        for (const [, staffMember] of staffMembers) {
          try {
            await delay(200); // Small delay between DMs to avoid rate limits
            await staffMember.user.send({ embeds: [staffNotifyEmbed] });
            console.log(`✅ DM sent to staff: ${staffMember.user.tag}`);
          } catch (dmErr) {
            console.warn(`⚠️ Could not DM staff ${staffMember.user.tag}:`, dmErr.message);
          }
        }
      }
    } catch (notifyErr) {
      console.warn('⚠️ Could not notify staff:', notifyErr.message);
    }
    
    res.json({
      success: true,
      customerThreadId
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Webhook server running on port ${PORT}`);
});

// Login
client.login(DISCORD_BOT_TOKEN);
