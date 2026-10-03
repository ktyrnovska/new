import fs from 'fs';
import path from 'path';
import { ExchangeId, MarketType, SurveillanceCoin, Timeframe } from '../src/types';
import { getEffectiveTelegramConfig, maskToken, sendTelegramMessage } from './telegramService';

export type NotificationChannel = 'telegram' | 'browser' | 'internal';

export type NotificationSource =
  | 'PRICE_ALERT'
  | 'SURVEILLANCE'
  | 'SCREENER'
  | 'TRADING_FLOW'
  | 'ORDERBOOK';

export interface NotificationEvent {
  source: NotificationSource;
  userId?: string;
  coinId?: string;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  eventType: string;
  eventIdentity?: string;
  direction?: 'BULLISH' | 'BEARISH' | 'LONG' | 'SHORT' | 'BUY' | 'SELL';
  title: string;
  description: string;
  price: number;
  timeframe?: Timeframe;
  severity?: 'info' | 'warning' | 'critical' | 'IMPORTANT';
  channels?: NotificationChannel[];
  telegramHtml?: string;
  htmlMessage?: string; // Backward compatibility alias
  metadata?: Record<string, any>;
  createdAt?: number;
  coin?: SurveillanceCoin;
  triggerMode?: 'realtime' | 'bar_close' | 'bar_close_1h' | 'bar_close_15m' | 'manual';
  customCooldownMs?: number;
  forceNotify?: boolean;
}

export interface NotificationHistoryRecord {
  id: string;
  traceId: string;
  userId: string;
  eventId: string;
  coinId?: string;
  symbol: string;
  exchange: ExchangeId;
  marketType: MarketType;
  eventType: string;
  channel: string;
  title: string;
  description: string;
  price: number;
  timeframe?: Timeframe;
  severity: string;
  status: 'sent' | 'failed' | 'skipped' | 'deduplicated' | 'cooldown';
  error?: string;
  retryCount: number;
  attemptedAt: number;
  sentAt?: number;
  createdAt: number;
  metadata?: Record<string, any>;
}

export interface DispatchResult {
  success: boolean;
  eventId: string;
  traceId: string;
  status: 'sent' | 'failed' | 'skipped' | 'deduplicated' | 'cooldown';
  channels: {
    telegram?: { sent: boolean; error?: string; skipped?: boolean };
    browser?: { sent: boolean };
    internal?: { sent: boolean };
  };
  error?: string;
  remainingCooldownSeconds?: number;
}

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'notification_history.json');
const MAX_HISTORY_RECORDS = 500;

function roundPriceForIdentity(price: number): string {
  if (!price || isNaN(price)) return '0';
  if (price >= 1000) return (Math.round(price * 10) / 10).toFixed(1);
  if (price >= 1) return (Math.round(price * 100) / 100).toFixed(2);
  if (price >= 0.001) return (Math.round(price * 10000) / 10000).toFixed(4);
  return (Math.round(price * 1000000) / 1000000).toFixed(6);
}

export class NotificationRouter {
  private static instance: NotificationRouter | null = null;

  // Deduplication tracker: eventKey -> timestamp
  private recentDetections = new Map<string, number>();

  // Cooldown tracker: eventKey -> timestamp of last successful dispatch
  private lastDispatchTimestamps = new Map<string, number>();

  // Client buffer for browser notification polling/streaming: userId -> records
  private clientNotificationBuffer = new Map<string, NotificationHistoryRecord[]>();

  // In-memory history cache
  private historyCache: NotificationHistoryRecord[] = [];
  private isHistoryLoaded = false;

  // Default cooldowns per eventType in ms (#7)
  private readonly defaultCooldowns: Record<string, number> = {
    // Price Alerts
    PRICE_ALERT: 15 * 60 * 1000,
    // Order Book & Densities
    DENSITY_APPEARED: 10 * 60 * 1000,
    DENSITY_PERSISTENT: 20 * 60 * 1000,
    DENSITY_REPLENISHED: 15 * 60 * 1000,
    DENSITY_REMOVED: 15 * 60 * 1000,
    DENSITY_SPOOF_RISK: 15 * 60 * 1000,
    // Setups & Third Touch
    THIRD_TOUCH_APPROACHING: 15 * 60 * 1000,
    THIRD_TOUCH_ACTIVE: 10 * 60 * 1000,
    SUPPORT_RETEST_WATCH: 15 * 60 * 1000,
    SUPPORT_RETEST_CONFIRMED: 20 * 60 * 1000,
    RESISTANCE_RETEST_CONFIRMED: 20 * 60 * 1000,
    FORMATION_SETUP_CONFIRMED: 25 * 60 * 1000,
    SETUP: 20 * 60 * 1000,
    // Structure & OI
    STRUCTURE_SHIFT: 20 * 60 * 1000,
    BOS: 20 * 60 * 1000,
    CHOCH: 20 * 60 * 1000,
    OI_ANOMALY: 15 * 60 * 1000,
    FORMATION_DETECTED: 30 * 60 * 1000,
    BREAKOUT_REALTIME: 10 * 60 * 1000,
    BREAKOUT_CONFIRMED: 20 * 60 * 1000,
    IMPULSE: 10 * 60 * 1000,
    SURVEILLANCE_LEVEL: 15 * 60 * 1000,
    LEVEL_CROSS_4H: 20 * 60 * 1000,
    LEVEL_CROSS_1H: 15 * 60 * 1000,
    LEVEL_CROSS_15M: 10 * 60 * 1000,
    MOMENTUM: 15 * 60 * 1000,
    CHANNEL_BREAKOUT: 20 * 60 * 1000,
    FIBONACCI: 20 * 60 * 1000,
  };

  public static getInstance(): NotificationRouter {
    if (!NotificationRouter.instance) {
      NotificationRouter.instance = new NotificationRouter();
    }
    return NotificationRouter.instance;
  }

  constructor() {
    this.loadPersistedHistory();
    // Periodically clean up old timestamps every 10 minutes
    setInterval(() => this.cleanupOldTrackers(), 10 * 60 * 1000);
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      } catch (e) {
        console.error('[NotificationRouter] Failed to create data dir:', e);
      }
    }
  }

  private loadPersistedHistory() {
    if (this.isHistoryLoaded) return;
    try {
      this.ensureDataDir();
      if (fs.existsSync(HISTORY_FILE)) {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.historyCache = list.slice(0, MAX_HISTORY_RECORDS);
        }
      }
    } catch (e) {
      console.error('[NotificationRouter] Error reading notification history:', e);
      this.historyCache = [];
    }
    this.isHistoryLoaded = true;
  }

  private savePersistedHistory() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(
        HISTORY_FILE,
        JSON.stringify(this.historyCache.slice(0, MAX_HISTORY_RECORDS), null, 2),
        'utf-8'
      );
    } catch (e) {
      console.error('[NotificationRouter] Error saving notification history:', e);
    }
  }

  private cleanupOldTrackers() {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    for (const [key, ts] of this.lastDispatchTimestamps.entries()) {
      if (now - ts > maxAge) this.lastDispatchTimestamps.delete(key);
    }
    for (const [key, ts] of this.recentDetections.entries()) {
      if (now - ts > maxAge) this.recentDetections.delete(key);
    }
  }

  /**
   * Deterministic Event Identity Generator (#7)
   * Prevents micro-price fluctuations from generating endless duplicate spam.
   */
  public generateEventIdentity(event: NotificationEvent): string {
    const uid = (event.userId || 'guest').trim();
    const sym = event.symbol.toUpperCase().replace('/', '').trim();
    const ex = event.exchange.toLowerCase();
    const mkt = event.marketType.toLowerCase();
    const type = event.eventType.toUpperCase();

    if (event.eventIdentity) {
      return `${event.source}:${uid}:${sym}:${ex}:${mkt}:${type}:${event.eventIdentity.trim().replace(/[\s:]+/g, '_')}`;
    }

    switch (type) {
      case 'PRICE_ALERT': {
        const alertId = event.metadata?.alertId || roundPriceForIdentity(event.price);
        return `PRICE_ALERT:${uid}:${sym}:${ex}:${mkt}:${alertId}`;
      }
      case 'BOS':
      case 'CHOCH': {
        const tf = event.timeframe || '15m';
        const dir = event.direction || 'BULLISH';
        const rounded = roundPriceForIdentity(event.price);
        return `SURVEILLANCE:${uid}:${sym}:${ex}:${mkt}:${type}:${tf}:${dir}:${rounded}`;
      }
      case 'THIRD_TOUCH_APPROACHING':
      case 'THIRD_TOUCH_ACTIVE': {
        const levelId = event.metadata?.levelId || roundPriceForIdentity(event.price);
        const touch = event.metadata?.touchCount || 3;
        return `SURVEILLANCE:${uid}:${sym}:${ex}:${mkt}:THIRD_TOUCH:${levelId}:${touch}`;
      }
      case 'OI_ANOMALY': {
        // Group by 15-minute time bucket to prevent duplicate alerts within same window
        const timeBucket = Math.floor(Date.now() / (15 * 60 * 1000));
        return `SURVEILLANCE:${uid}:${sym}:${ex}:${mkt}:OI:${timeBucket}`;
      }
      case 'DENSITY_APPEARED':
      case 'DENSITY_PERSISTENT': {
        const side = event.direction || (event.metadata?.side ? String(event.metadata.side).toUpperCase() : 'BID');
        const rounded = roundPriceForIdentity(event.price);
        return `ORDERBOOK:${uid}:${sym}:${ex}:${mkt}:${type}:${side}:${rounded}`;
      }
      case 'SETUP': {
        const setupType = event.metadata?.setupType || 'BREAKOUT';
        const dir = event.direction || 'LONG';
        const tf = event.timeframe || '15m';
        return `SURVEILLANCE:${uid}:${sym}:${ex}:${mkt}:SETUP:${setupType}:${dir}:${tf}`;
      }
      case 'SURVEILLANCE_LEVEL': {
        const levelId = event.metadata?.levelId || roundPriceForIdentity(event.price);
        return `SURVEILLANCE:${uid}:${sym}:${ex}:${mkt}:SURV_LEVEL:${levelId}`;
      }
      default: {
        const rounded = roundPriceForIdentity(event.price);
        const tf = event.timeframe || '1h';
        return `${event.source}:${uid}:${sym}:${ex}:${mkt}:${type}:${tf}:${rounded}`;
      }
    }
  }

  /**
   * Pre-dispatch validation and policy gate (#6)
   * IMPORTANT: Checks deduplication, cooldown, and toggles WITHOUT locking the cooldown!
   */
  public canDispatch(event: NotificationEvent): {
    canDispatch: boolean;
    reason?: string;
    eventKey: string;
    remainingCooldownSeconds?: number;
  } {
    const eventKey = this.generateEventIdentity(event);
    const now = Date.now();

    // 1. Coin-level configuration toggles
    if (event.coin) {
      const { coin } = event;
      if (!coin.isActive) {
        return { canDispatch: false, reason: 'coin_inactive', eventKey };
      }

      if (coin.config?.telegramEnabled === false && (!event.channels || event.channels.includes('telegram'))) {
        // If telegram is explicitly disabled on coin and that was the primary channel
        if (!event.channels || (event.channels.length === 1 && event.channels[0] === 'telegram')) {
          return { canDispatch: false, reason: 'telegram_disabled_for_coin', eventKey };
        }
      }

      // Trigger mode check
      if (event.triggerMode === 'realtime') {
        const modes = coin.config?.triggerModes || (coin.config?.triggerMode ? [coin.config.triggerMode] : ['bar_close']);
        if (!modes.includes('realtime')) {
          return { canDispatch: false, reason: 'realtime_mode_disabled', eventKey };
        }
      }

      // Category-specific alert toggles
      const evUpper = event.eventType.toUpperCase();
      if (evUpper === 'OI_ANOMALY' && coin.config?.oiAlerts === false) {
        return { canDispatch: false, reason: 'oi_alerts_disabled', eventKey };
      }
      if (evUpper.startsWith('DENSITY') && coin.config?.densityAlerts === false) {
        return { canDispatch: false, reason: 'density_alerts_disabled', eventKey };
      }
      if (evUpper.startsWith('THIRD_TOUCH') && coin.config?.thirdTouchAlerts === false) {
        return { canDispatch: false, reason: 'third_touch_alerts_disabled', eventKey };
      }
      if (evUpper.startsWith('SETUP') && coin.config?.setupsEnabled === false) {
        return { canDispatch: false, reason: 'setups_disabled', eventKey };
      }
      if ((evUpper === 'BOS' || evUpper === 'CHOCH' || evUpper.startsWith('STRUCT')) && coin.config?.structureEnabled === false) {
        return { canDispatch: false, reason: 'structure_disabled', eventKey };
      }
      if (evUpper.startsWith('LEVEL') && coin.config?.levelsEnabled === false) {
        return { canDispatch: false, reason: 'levels_disabled', eventKey };
      }
      if (evUpper.startsWith('MOMENTUM') && coin.config?.momentumEnabled === false) {
        return { canDispatch: false, reason: 'momentum_disabled', eventKey };
      }
    }

    if (event.forceNotify) {
      return { canDispatch: true, eventKey };
    }

    // 2. Short-term Deduplication check (within 45s, identical tick events are suppressed)
    const lastDetection = this.recentDetections.get(eventKey) || 0;
    if (now - lastDetection < 45 * 1000) {
      return { canDispatch: false, reason: 'deduplicated', eventKey };
    }

    // 3. Cooldown check
    const lastDispatch = this.lastDispatchTimestamps.get(eventKey) || 0;
    const cooldownDuration = this.getCooldownDuration(event);
    const elapsed = now - lastDispatch;

    if (elapsed < cooldownDuration) {
      const remainingSeconds = Math.ceil((cooldownDuration - elapsed) / 1000);
      return {
        canDispatch: false,
        reason: 'cooldown_active',
        remainingCooldownSeconds: remainingSeconds,
        eventKey,
      };
    }

    return { canDispatch: true, eventKey };
  }

  public getCooldownDuration(event: NotificationEvent): number {
    if (typeof event.customCooldownMs === 'number' && event.customCooldownMs > 0) {
      return event.customCooldownMs;
    }
    if (event.coin?.config?.cooldownMinutes && event.coin.config.cooldownMinutes > 0) {
      return event.coin.config.cooldownMinutes * 60 * 1000;
    }
    return this.defaultCooldowns[event.eventType.toUpperCase()] || 15 * 60 * 1000;
  }

  /**
   * Records successful dispatch and activates cooldown (#6)
   */
  public recordDispatchSuccess(
    event: NotificationEvent,
    traceId: string,
    channels: { telegramSent: boolean; browserSent: boolean }
  ): NotificationHistoryRecord {
    const now = Date.now();
    const eventKey = this.generateEventIdentity(event);

    this.lastDispatchTimestamps.set(eventKey, now);
    this.recentDetections.set(eventKey, now);

    if (event.coin) {
      event.coin.lastNotifiedAt = new Date(now).toISOString();
    }

    const record: NotificationHistoryRecord = {
      id: `nh_${now}_${Math.random().toString(36).substring(2, 7)}`,
      traceId,
      userId: event.userId || 'guest',
      eventId: eventKey,
      coinId: event.coinId || event.coin?.id,
      symbol: event.symbol,
      exchange: event.exchange,
      marketType: event.marketType,
      eventType: event.eventType,
      channel: channels.telegramSent ? 'telegram' : 'browser',
      title: event.title,
      description: event.description,
      price: event.price,
      timeframe: event.timeframe,
      severity: String(event.severity || 'info'),
      status: 'sent',
      retryCount: 0,
      attemptedAt: now,
      sentAt: now,
      createdAt: event.createdAt || now,
      metadata: event.metadata,
    };

    this.historyCache.unshift(record);
    this.savePersistedHistory();
    this.pushClientBuffer(event.userId, record);

    console.log(`[Trace:${traceId}] [SUCCESS] Delivered notification for #${event.symbol} (${event.eventType}) to user ${event.userId || 'guest'}`);
    return record;
  }

  /**
   * Records dispatch failure without locking cooldown unless error is terminal (#6 & #12)
   */
  public recordDispatchFailure(
    event: NotificationEvent,
    traceId: string,
    error: string,
    isTerminal: boolean,
    retryCount: number
  ): NotificationHistoryRecord {
    const now = Date.now();
    const eventKey = this.generateEventIdentity(event);

    if (isTerminal) {
      // Lock cooldown for terminal errors to prevent infinite spam
      this.lastDispatchTimestamps.set(eventKey, now);
    }

    const record: NotificationHistoryRecord = {
      id: `nh_fail_${now}_${Math.random().toString(36).substring(2, 7)}`,
      traceId,
      userId: event.userId || 'guest',
      eventId: eventKey,
      coinId: event.coinId || event.coin?.id,
      symbol: event.symbol,
      exchange: event.exchange,
      marketType: event.marketType,
      eventType: event.eventType,
      channel: 'telegram',
      title: event.title,
      description: event.description,
      price: event.price,
      timeframe: event.timeframe,
      severity: String(event.severity || 'warning'),
      status: 'failed',
      error,
      retryCount,
      attemptedAt: now,
      createdAt: event.createdAt || now,
      metadata: event.metadata,
    };

    this.historyCache.unshift(record);
    this.savePersistedHistory();

    console.error(`[Trace:${traceId}] [FAIL] Notification failed for #${event.symbol} (${event.eventType}): ${error}. Terminal: ${isTerminal}, Retries: ${retryCount}`);
    return record;
  }

  /**
   * Central Dispatch Entry Point (#6)
   */
  public async dispatch(event: NotificationEvent): Promise<DispatchResult> {
    const traceId = Math.random().toString(36).substring(2, 8);
    const eventKey = this.generateEventIdentity(event);
    const channels = event.channels || ['telegram', 'browser', 'internal'];

    console.log(`[Trace:${traceId}] [DETECTED] #${event.symbol} event: ${event.eventType} on ${event.exchange.toUpperCase()} (user: ${event.userId || 'guest'})`);

    const check = this.canDispatch(event);
    if (!check.canDispatch) {
      if (check.reason === 'deduplicated') {
        console.log(`[Trace:${traceId}] [DEDUP] Duplicate event suppressed for ${eventKey}`);
        return {
          success: false,
          eventId: eventKey,
          traceId,
          status: 'deduplicated',
          channels: {},
          error: 'Подія щойно була оброблена (deduplication)',
        };
      }
      if (check.reason === 'cooldown_active') {
        console.log(`[Trace:${traceId}] [COOLDOWN] Cooldown active for ${eventKey} (${check.remainingCooldownSeconds}s remaining)`);
        return {
          success: false,
          eventId: eventKey,
          traceId,
          status: 'cooldown',
          channels: {},
          error: `Cooldown активний: зачекайте ${check.remainingCooldownSeconds}с`,
          remainingCooldownSeconds: check.remainingCooldownSeconds,
        };
      }
      return {
        success: false,
        eventId: eventKey,
        traceId,
        status: 'skipped',
        channels: {},
        error: `Event rejected: ${check.reason}`,
      };
    }

    console.log(`[Trace:${traceId}] [DISPATCH] Dispatching #${event.symbol} (${event.eventType}) to channels: ${channels.join(', ')}`);

    let telegramSent = false;
    let telegramError: string | undefined;
    let telegramSkipped = false;

    // 1. Dispatch Telegram if requested
    if (channels.includes('telegram')) {
      const tgConfig = getEffectiveTelegramConfig(event.userId);

      if (!tgConfig.botToken || !tgConfig.chatId) {
        telegramSkipped = true;
        telegramError = 'Telegram credentials not configured for user';
        console.log(`[Trace:${traceId}] [TELEGRAM] Skipped: Telegram not configured for user ${event.userId || 'guest'}`);
      } else {
        const messageHtml = event.telegramHtml || event.htmlMessage || this.formatFallbackTelegramMessage(event);

        const deliveryResult = await this.deliverTelegramWithRetry(
          messageHtml,
          tgConfig.botToken,
          tgConfig.chatId,
          traceId
        );

        telegramSent = deliveryResult.success;
        telegramError = deliveryResult.error;
      }
    }

    // 2. Dispatch Browser & In-App Notification (#8)
    let browserSent = false;
    if (channels.includes('browser') || channels.includes('internal')) {
      browserSent = true;
      console.log(`[Trace:${traceId}] [BROWSER] Registered browser/in-app notification event for #${event.symbol}`);
    }

    const overallSuccess = telegramSent || (telegramSkipped && browserSent);

    if (overallSuccess) {
      this.recordDispatchSuccess(event, traceId, { telegramSent, browserSent });
      return {
        success: true,
        eventId: eventKey,
        traceId,
        status: 'sent',
        channels: {
          telegram: { sent: telegramSent, error: telegramError, skipped: telegramSkipped },
          browser: { sent: browserSent },
          internal: { sent: true },
        },
      };
    } else {
      const isTerminal = this.isTerminalTelegramError(telegramError || '');
      this.recordDispatchFailure(event, traceId, telegramError || 'Помилка надсилання сповіщення', isTerminal, 3);
      return {
        success: false,
        eventId: eventKey,
        traceId,
        status: 'failed',
        channels: {
          telegram: { sent: false, error: telegramError },
          browser: { sent: browserSent },
          internal: { sent: true },
        },
        error: telegramError,
      };
    }
  }

  /**
   * Telegram Delivery with Exponential Backoff for Transient Failures (#12)
   */
  private async deliverTelegramWithRetry(
    htmlText: string,
    botToken: string,
    chatId: string,
    traceId: string
  ): Promise<{ success: boolean; error?: string }> {
    const maxRetries = 2; // Initial attempt + 2 retries = 3 attempts total
    const backoffs = [1500, 4000];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Trace:${traceId}] [TELEGRAM] Attempt ${attempt + 1}/${maxRetries + 1} (token: ${maskToken(botToken)}, chat: ${chatId})...`);
        const result = await sendTelegramMessage(htmlText, {
          botToken,
          chatId,
        });

        if (result.success) {
          return { success: true };
        }

        const err = result.error || 'Unknown error';
        if (this.isTerminalTelegramError(err)) {
          console.warn(`[Trace:${traceId}] [TELEGRAM] Terminal error detected (${err}), aborting retries.`);
          return { success: false, error: err };
        }

        if (attempt < maxRetries) {
          const delay = backoffs[attempt] || 3000;
          console.warn(`[Trace:${traceId}] [TELEGRAM] Transient failure: ${err}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          return { success: false, error: err };
        }
      } catch (err: any) {
        const msg = err?.message || 'Network error';
        if (attempt < maxRetries) {
          const delay = backoffs[attempt] || 3000;
          console.warn(`[Trace:${traceId}] [TELEGRAM] Network error: ${msg}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          return { success: false, error: msg };
        }
      }
    }

    return { success: false, error: 'Maximum retries exceeded' };
  }

  public isTerminalTelegramError(error: string): boolean {
    const err = error.toLowerCase();
    return (
      err.includes('blocked by the user') ||
      err.includes('chat not found') ||
      err.includes('unauthorized') ||
      err.includes('invalid token') ||
      err.includes('невірний bot token') ||
      err.includes("can't send messages to the bot") ||
      err.includes('user is deactivated') ||
      err.includes('not a member')
    );
  }

  private formatFallbackTelegramMessage(event: NotificationEvent): string {
    const sym = event.symbol.toUpperCase();
    const ex = event.exchange.toUpperCase();
    const mkt = event.marketType.toUpperCase();
    const timeStr = new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' });

    return `🚨 <b>SIGNALHOOK ALERT</b>\n\n` +
      `🪙 <b>#${sym}</b> (${ex} ${mkt})\n` +
      `📌 <b>${event.title}</b>\n` +
      `💵 <b>Ціна:</b> $${event.price}\n` +
      `📝 ${event.description}\n` +
      (event.timeframe ? `⏱ <b>Timeframe:</b> ${event.timeframe.toUpperCase()}\n` : '') +
      `\n⏰ <i>${timeStr} (Київ)</i>`;
  }

  private pushClientBuffer(userId: string | undefined, record: NotificationHistoryRecord) {
    const uid = userId || 'guest';
    const current = this.clientNotificationBuffer.get(uid) || [];
    current.push(record);
    if (current.length > 50) current.shift();
    this.clientNotificationBuffer.set(uid, current);
  }

  public pollClientNotifications(userId?: string, since = 0): NotificationHistoryRecord[] {
    const uid = userId || 'guest';
    const buffered = this.clientNotificationBuffer.get(uid) || [];
    const filtered = buffered.filter((r) => r.attemptedAt > since);
    return filtered;
  }

  public getHistory(userId?: string, limit = 100): NotificationHistoryRecord[] {
    this.loadPersistedHistory();
    if (!userId || userId === 'all') {
      return this.historyCache.slice(0, limit);
    }
    return this.historyCache
      .filter((r) => r.userId === userId || r.userId === 'guest')
      .slice(0, limit);
  }

  public clearHistory(): void {
    this.historyCache = [];
    this.savePersistedHistory();
  }

  public resetCooldowns(): void {
    this.lastDispatchTimestamps.clear();
    this.recentDetections.clear();
  }

  // Compatibility helpers for StateMachineAndAlerts
  public buildScopedKey(options: {
    source?: string;
    userId?: string;
    coinId?: string;
    symbol: string;
    exchange: string;
    marketType: string;
    eventType: string;
    eventIdentity?: string;
  }): string {
    const src = options.source || 'SURVEILLANCE';
    const uid = options.userId || 'guest';
    const sym = options.symbol.toUpperCase().replace('/', '');
    const ex = options.exchange.toLowerCase();
    const mkt = options.marketType.toLowerCase();
    const type = options.eventType.toUpperCase();
    const ident = (options.eventIdentity || '').trim().replace(/[\s:]+/g, '_');
    return `${src}:${uid}:${sym}:${ex}:${mkt}:${type}:${ident}`;
  }

  public shouldNotify(options: {
    source?: any;
    userId?: string;
    coinId?: string;
    symbol: string;
    exchange: any;
    marketType: any;
    eventType: string;
    eventIdentity?: string;
    customCooldownMs?: number;
  }): { allowed: boolean; remainingCooldownMs?: number } {
    const eventKey = this.buildScopedKey(options);
    const now = Date.now();
    const last = this.lastDispatchTimestamps.get(eventKey) || 0;
    const cooldown = options.customCooldownMs || this.defaultCooldowns[options.eventType.toUpperCase()] || 15 * 60 * 1000;
    const elapsed = now - last;
    if (elapsed < cooldown) {
      return { allowed: false, remainingCooldownMs: cooldown - elapsed };
    }
    return { allowed: true };
  }

  public recordAlertSent(scopedKey: string, timestamp = Date.now()): void {
    this.lastDispatchTimestamps.set(scopedKey, timestamp);
    this.recentDetections.set(scopedKey, timestamp);
  }

  public getLastAlertTime(scopedKey: string): number {
    return this.lastDispatchTimestamps.get(scopedKey) || 0;
  }
}

export const notificationRouter = NotificationRouter.getInstance();
