import fs from 'fs';
import path from 'path';
import { PriceAlert, AlertHistoryItem, ExchangeId, MarketType } from '../src/types';
import {
  getUserTelegram,
  saveUserTelegram,
  loadUserTelegram,
  getEffectiveTelegramConfig,
  maskToken,
} from './telegramService';
import { notificationRouter } from './notificationRouter';
import { SetupInstance } from './surveillance/types';
import { validateSetupAlertsMath } from './surveillance/setupValidation';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'alert_history.json');

// Re-export user telegram methods for backward compatibility
export { getUserTelegram, saveUserTelegram, loadUserTelegram };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
      console.error('[AlertService] Failed to create server/data directory:', e);
    }
  }
}

// Format price nicely
function formatPrice(val: number): string {
  if (!val && val !== 0) return '0.00';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.0001) return val.toFixed(6);
  return val.toFixed(8);
}

// In-memory caches
let alertsCache: PriceAlert[] = [];
let isAlertsLoaded = false;

let historyCache: AlertHistoryItem[] = [];
let isHistoryLoaded = false;

let monitorInterval: NodeJS.Timeout | null = null;
let isCheckInFlight = false;

// --- Alerts persistence ---
export function loadAlerts(): PriceAlert[] {
  if (isAlertsLoaded) return alertsCache;
  try {
    ensureDataDir();
    if (fs.existsSync(ALERTS_FILE)) {
      const raw = fs.readFileSync(ALERTS_FILE, 'utf-8');
      alertsCache = JSON.parse(raw);
    } else {
      alertsCache = [];
    }
  } catch (err) {
    console.error('[AlertService] Failed to read alerts.json:', err);
    alertsCache = [];
  }
  isAlertsLoaded = true;
  return alertsCache;
}

export function saveAlerts(alerts: PriceAlert[]): boolean {
  try {
    ensureDataDir();
    alertsCache = alerts;
    isAlertsLoaded = true;
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[AlertService] Failed to save alerts.json:', err);
    return false;
  }
}

// --- History persistence ---
export function loadHistory(): AlertHistoryItem[] {
  if (isHistoryLoaded) return historyCache;
  try {
    ensureDataDir();
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      historyCache = JSON.parse(raw);
    } else {
      historyCache = [];
    }
  } catch (err) {
    console.error('[AlertService] Failed to read alert_history.json:', err);
    historyCache = [];
  }
  isHistoryLoaded = true;
  return historyCache;
}

export function saveHistory(history: AlertHistoryItem[]): boolean {
  try {
    ensureDataDir();
    historyCache = history;
    isHistoryLoaded = true;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[AlertService] Failed to save alert_history.json:', err);
    return false;
  }
}

export function addHistoryItem(item: AlertHistoryItem): void {
  const history = loadHistory();
  history.unshift(item);
  if (history.length > 500) {
    history.length = 500;
  }
  saveHistory(history);
}

export function clearUserHistory(userId?: string): number {
  if (!userId || userId === 'guest') {
    const history = loadHistory();
    const count = history.length;
    saveHistory([]);
    return count;
  }
  const history = loadHistory();
  const remaining = history.filter((h) => h.userId !== userId);
  const clearedCount = history.length - remaining.length;
  saveHistory(remaining);
  return clearedCount;
}

export function clearAlertHistory(userId?: string): number {
  return clearUserHistory(userId);
}

export function getAlertHistory(userId?: string): AlertHistoryItem[] {
  const history = loadHistory();
  if (!userId || userId === 'all') return history;
  return history.filter((h) => h.userId === userId || h.userId === 'guest');
}

export function deleteHistoryItem(id: string, userId?: string): boolean {
  const history = loadHistory();
  const filtered = history.filter((h) => !(h.id === id && (!userId || h.userId === userId)));
  if (filtered.length !== history.length) {
    saveHistory(filtered);
    return true;
  }
  return false;
}

/**
 * Get all alerts with support for user scoping and system-wide monitoring (#11)
 * When userId is passed: returns only alerts belonging to that user.
 * When userId is omitted or 'all': returns all alerts (used by system CRON).
 */
export function getAllAlerts(userId?: string): PriceAlert[] {
  const all = loadAlerts();
  if (!userId || userId === 'all') {
    return all;
  }
  return all.filter((a) => a.userId === userId || (!a.userId && userId === 'guest'));
}

/**
 * Real Alert Statistics (#11)
 * Returns accurate counts without hardcoded mock values.
 */
export function getAlertsStats(userId?: string): {
  totalAlertsMonitored: number;
  activeAlertsCount: number;
  triggeredAlerts: number;
  failedAlerts: number;
} {
  const alerts = getAllAlerts(userId);
  const activeAlertsCount = alerts.filter((a) => a.isActive && !a.triggered).length;
  const triggeredAlerts = alerts.filter((a) => a.triggered).length;
  const failedAlerts = alerts.filter((a) => a.triggerStatus === 'FAILED').length;

  return {
    totalAlertsMonitored: alerts.length,
    activeAlertsCount,
    triggeredAlerts,
    failedAlerts,
  };
}

// Create alert
export function createAlert(
  data: Omit<PriceAlert, 'id' | 'createdAt' | 'triggered' | 'isActive'> & {
    id?: string;
    createdAt?: number;
    isActive?: boolean;
    telegramBotToken?: string;
    telegramChatId?: string;
  }
): PriceAlert {
  const alerts = loadAlerts();
  const alertId = data.id || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const userId = data.userId || 'guest';

  if (data.telegramBotToken || data.telegramChatId) {
    saveUserTelegram(userId, {
      botToken: data.telegramBotToken,
      chatId: data.telegramChatId,
    });
  }

  const effectiveTg = getEffectiveTelegramConfig(userId);
  const effectiveBotToken = data.telegramBotToken || effectiveTg.botToken;
  const effectiveChatId = data.telegramChatId || effectiveTg.chatId;

  const newAlert: PriceAlert = {
    id: alertId,
    userId,
    symbol: data.symbol.toUpperCase().replace('/', '').trim(),
    exchange: data.exchange,
    marketType: data.marketType,
    targetPrice: Number(data.targetPrice),
    condition: data.condition,
    note: data.note ? String(data.note).trim() : undefined,
    formationName: data.formationName ? String(data.formationName).trim() : undefined,
    levelType: data.levelType || 'custom',
    createdAt: data.createdAt || Date.now(),
    isActive: data.isActive !== undefined ? data.isActive : true,
    triggered: false,
    triggerStatus: 'ACTIVE',
    retryCount: 0,
    telegramBotToken: effectiveBotToken,
    telegramChatId: effectiveChatId,
  };

  const existingIdx = alerts.findIndex((a) => a.id === alertId);
  if (existingIdx >= 0) {
    alerts[existingIdx] = newAlert;
  } else {
    alerts.unshift(newAlert);
  }
  saveAlerts(alerts);
  return newAlert;
}

// Create batch of alerts
export function createAlertsBatch(
  userId: string,
  alertsList: Array<
    Omit<PriceAlert, 'id' | 'createdAt' | 'triggered' | 'isActive'> & {
      id?: string;
      isActive?: boolean;
      telegramBotToken?: string;
      telegramChatId?: string;
    }
  >,
  telegramBotToken?: string,
  telegramChatId?: string
): PriceAlert[] {
  const alerts = loadAlerts();

  if (telegramBotToken || telegramChatId) {
    saveUserTelegram(userId, {
      botToken: telegramBotToken,
      chatId: telegramChatId,
    });
  }

  const effectiveTg = getEffectiveTelegramConfig(userId);
  const effectiveBotToken = telegramBotToken || effectiveTg.botToken;
  const effectiveChatId = telegramChatId || effectiveTg.chatId;

  const createdAlerts: PriceAlert[] = [];
  let index = 0;

  for (const item of alertsList) {
    const alertId = item.id || `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${index++}`;
    const newAlert: PriceAlert = {
      id: alertId,
      userId,
      symbol: item.symbol.toUpperCase().replace('/', '').trim(),
      exchange: item.exchange,
      marketType: item.marketType,
      targetPrice: Number(item.targetPrice),
      condition: item.condition,
      note: item.note ? String(item.note).trim() : undefined,
      formationName: item.formationName ? String(item.formationName).trim() : undefined,
      levelType: item.levelType || 'custom',
      createdAt: Date.now() + index,
      isActive: item.isActive !== undefined ? item.isActive : true,
      triggered: false,
      triggerStatus: 'ACTIVE',
      retryCount: 0,
      telegramBotToken: item.telegramBotToken || effectiveBotToken,
      telegramChatId: item.telegramChatId || effectiveChatId,
    };

    const existingIdx = alerts.findIndex((a) => a.id === alertId);
    if (existingIdx >= 0) {
      alerts[existingIdx] = newAlert;
    } else {
      alerts.unshift(newAlert);
    }
    createdAlerts.push(newAlert);
  }

  saveAlerts(alerts);
  return createdAlerts;
}

// Creates an atomic group of 3 Price Alerts for a setup
export function createSetupAlertsGroup(
  userId: string,
  setup: SetupInstance,
  currentPrice?: number,
  autoActivate = true
): { success: boolean; alerts?: PriceAlert[]; error?: string } {
  const mathValidation = validateSetupAlertsMath(setup);
  if (!mathValidation.valid) {
    return {
      success: false,
      error: mathValidation.reason || 'Mathematical validation failed for setup levels',
    };
  }

  const { entry, target, stop } = mathValidation;
  const curPrice = currentPrice || entry;

  const entryCondition =
    setup.direction === 'LONG'
      ? curPrice >= entry
        ? 'lte'
        : 'gte'
      : curPrice <= entry
      ? 'gte'
      : 'lte';

  const targetCondition = setup.direction === 'LONG' ? 'gte' : 'lte';
  const stopCondition = setup.direction === 'LONG' ? 'lte' : 'gte';

  const effectiveTg = getEffectiveTelegramConfig(userId);
  const now = Date.now();

  const alertsToCreate: PriceAlert[] = [
    {
      id: `${setup.id}_ENTRY`,
      userId,
      setupId: setup.id,
      setupRole: 'ENTRY',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(entry),
      condition: entryCondition,
      levelType: 'entry',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Точка входу в позицію`,
      createdAt: now,
      isActive: autoActivate,
      triggered: false,
      triggerStatus: 'ACTIVE',
      retryCount: 0,
      telegramBotToken: effectiveTg.botToken,
      telegramChatId: effectiveTg.chatId,
    },
    {
      id: `${setup.id}_TARGET`,
      userId,
      setupId: setup.id,
      setupRole: 'TARGET',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(target),
      condition: targetCondition,
      levelType: 'target',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Ціль Take-Profit (TP) +${Math.abs(((target - entry) / entry) * 100).toFixed(1)}%`,
      createdAt: now + 1,
      isActive: autoActivate,
      triggered: false,
      triggerStatus: 'ACTIVE',
      retryCount: 0,
      telegramBotToken: effectiveTg.botToken,
      telegramChatId: effectiveTg.chatId,
    },
    {
      id: `${setup.id}_STOP`,
      userId,
      setupId: setup.id,
      setupRole: 'STOP',
      symbol: setup.symbol.toUpperCase().replace('/', '').trim(),
      exchange: setup.exchange,
      marketType: setup.marketType,
      targetPrice: Number(stop),
      condition: stopCondition,
      levelType: 'stop_loss',
      formationName: setup.type,
      note: `[Setup ${setup.direction}] Скасування Stop-Loss (SL) -${Math.abs(((entry - stop) / entry) * 100).toFixed(1)}%`,
      createdAt: now + 2,
      isActive: autoActivate,
      triggered: false,
      triggerStatus: 'ACTIVE',
      retryCount: 0,
      telegramBotToken: effectiveTg.botToken,
      telegramChatId: effectiveTg.chatId,
    },
  ];

  const alerts = loadAlerts();
  for (const newAlert of alertsToCreate) {
    const existingIdx = alerts.findIndex((a) => a.id === newAlert.id);
    if (existingIdx >= 0) {
      alerts[existingIdx] = newAlert;
    } else {
      alerts.unshift(newAlert);
    }
  }

  saveAlerts(alerts);
  return { success: true, alerts: alertsToCreate };
}

// Sync user alerts batch from client/Firestore with smart merge
export function syncUserAlerts(
  userId: string,
  userAlerts: PriceAlert[],
  telegramBotToken?: string,
  telegramChatId?: string
): PriceAlert[] {
  if (telegramBotToken || telegramChatId) {
    saveUserTelegram(userId, {
      botToken: telegramBotToken,
      chatId: telegramChatId,
    });
  }

  const all = loadAlerts();
  const effectiveTg = getEffectiveTelegramConfig(userId);
  const effectiveBotToken = telegramBotToken || effectiveTg.botToken;
  const effectiveChatId = telegramChatId || effectiveTg.chatId;

  const existingUserAlerts = new Map<string, PriceAlert>();
  for (const a of all) {
    if (a.userId === userId) {
      existingUserAlerts.set(a.id, a);
    }
  }

  const mergedUserAlerts: PriceAlert[] = [];
  const processedIds = new Set<string>();

  for (const incoming of userAlerts) {
    processedIds.add(incoming.id);
    const existing = existingUserAlerts.get(incoming.id);

    if (existing && existing.triggered) {
      mergedUserAlerts.push({
        ...incoming,
        userId,
        isActive: false,
        triggered: true,
        triggerStatus: 'TRIGGERED',
        triggeredAt: existing.triggeredAt,
        triggeredPrice: existing.triggeredPrice,
        telegramBotToken: effectiveBotToken || incoming.telegramBotToken || existing.telegramBotToken,
        telegramChatId: effectiveChatId || incoming.telegramChatId || existing.telegramChatId,
      });
    } else {
      mergedUserAlerts.push({
        ...incoming,
        userId,
        telegramBotToken: effectiveBotToken || incoming.telegramBotToken || existing?.telegramBotToken,
        telegramChatId: effectiveChatId || incoming.telegramChatId || existing?.telegramChatId,
      });
    }
  }

  for (const [id, existing] of existingUserAlerts.entries()) {
    if (!processedIds.has(id) && existing.triggered) {
      mergedUserAlerts.push({
        ...existing,
        telegramBotToken: effectiveBotToken || existing.telegramBotToken,
        telegramChatId: effectiveChatId || existing.telegramChatId,
      });
    }
  }

  const otherAlerts = all.filter((a) => a.userId !== userId);
  const updatedAll = [...mergedUserAlerts, ...otherAlerts];
  saveAlerts(updatedAll);

  return mergedUserAlerts;
}

// Delete alert
export function deleteAlert(id: string, userId?: string): boolean {
  const alerts = loadAlerts();
  const initialCount = alerts.length;
  const filtered = alerts.filter((a) => {
    if (a.id === id) {
      if (!userId || !a.userId || a.userId === 'guest' || a.userId === userId) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length !== initialCount) {
    saveAlerts(filtered);
    return true;
  }
  return false;
}

// Toggle alert active state
export function toggleAlert(id: string, userId?: string): PriceAlert | null {
  const alerts = loadAlerts();
  const alert = alerts.find((a) => a.id === id && (!userId || !a.userId || a.userId === userId));
  if (alert) {
    alert.isActive = !alert.isActive;
    if (alert.isActive && alert.triggered) {
      alert.triggered = false;
      alert.triggerStatus = 'ACTIVE';
      alert.retryCount = 0;
      alert.nextRetryAt = undefined;
      alert.lastError = undefined;
      alert.triggeredAt = undefined;
      alert.triggeredPrice = undefined;
    }
    saveAlerts(alerts);
    return alert;
  }
  return null;
}

// Clear triggered alerts
export function clearTriggeredAlerts(userId?: string): number {
  const alerts = loadAlerts();
  const remaining = alerts.filter((a) => {
    if (!a.triggered) return true;
    if (userId && a.userId && a.userId !== userId) return true;
    return false;
  });
  const clearedCount = alerts.length - remaining.length;
  saveAlerts(remaining);
  return clearedCount;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchCurrentPrice(exchange: ExchangeId, market: MarketType, symbol: string): Promise<number | null> {
  const cleanSymbol = symbol.toUpperCase().replace('/', '').trim();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  const binanceMirrors = market === 'futures'
    ? [
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${cleanSymbol}`,
        `https://data-api.binance.vision/api/v3/ticker/price?symbol=${cleanSymbol}`,
        `https://api.binance.com/api/v3/ticker/price?symbol=${cleanSymbol}`,
      ]
    : [
        `https://data-api.binance.vision/api/v3/ticker/price?symbol=${cleanSymbol}`,
        `https://api.binance.com/api/v3/ticker/price?symbol=${cleanSymbol}`,
      ];

  const bybitCategory = market === 'futures' ? 'linear' : 'spot';
  const bybitMirrors = [
    `https://api.bybit.com/v5/market/tickers?category=${bybitCategory}&symbol=${cleanSymbol}`,
    `https://api.bytick.com/v5/market/tickers?category=${bybitCategory}&symbol=${cleanSymbol}`,
  ];

  const primaryMirrors = exchange === 'binance' ? binanceMirrors : bybitMirrors;
  const secondaryMirrors = exchange === 'binance' ? bybitMirrors : binanceMirrors;

  for (const url of primaryMirrors) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const data = await res.json();
        const p = parseFloat(data.price || data?.result?.list?.[0]?.lastPrice);
        if (!isNaN(p) && p > 0) return p;
      }
    } catch {}
  }

  for (const url of secondaryMirrors) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data = await res.json();
        const p = parseFloat(data.price || data?.result?.list?.[0]?.lastPrice);
        if (!isNaN(p) && p > 0) return p;
      }
    } catch {}
  }

  return null;
}

/**
 * Check active alerts against live prices with proper State Machine (#3 & #12)
 *
 * State Transition:
 * ACTIVE
 *  -> TRIGGERING (when condition met)
 *  -> NOTIFIED/TRIGGERED (when dispatch succeeds)
 *  -> RETRY (when transient failure occurs, up to max retries with backoff)
 *  -> FAILED (when terminal error occurs or max retries exceeded)
 */
export async function checkAlertsOnce() {
  if (isCheckInFlight) return;
  isCheckInFlight = true;

  try {
    const alerts = loadAlerts();
    const now = Date.now();
    const activeAlerts = alerts.filter(
      (a) =>
        a.isActive &&
        !a.triggered &&
        a.triggerStatus !== 'TRIGGERING' &&
        (!a.nextRetryAt || now >= a.nextRetryAt)
    );
    if (activeAlerts.length === 0) return;

    // Group unique pairs
    const uniqueKeys = new Map<string, { exchange: ExchangeId; market: MarketType; symbol: string }>();
    for (const a of activeAlerts) {
      const key = `${a.exchange}:${a.marketType}:${a.symbol}`;
      if (!uniqueKeys.has(key)) {
        uniqueKeys.set(key, { exchange: a.exchange, market: a.marketType, symbol: a.symbol });
      }
    }

    // Fetch prices in parallel
    const priceMap = new Map<string, number>();
    await Promise.all(
      Array.from(uniqueKeys.entries()).map(async ([key, item]) => {
        const p = await fetchCurrentPrice(item.exchange, item.market, item.symbol);
        if (p !== null && !isNaN(p)) {
          priceMap.set(key, p);
        }
      })
    );

    let updated = false;

    for (const alert of activeAlerts) {
      if (alert.triggerStatus === 'CANCELLED' || !alert.isActive) continue;
      const key = `${alert.exchange}:${alert.marketType}:${alert.symbol}`;
      const currentPrice = priceMap.get(key);
      if (currentPrice === undefined) continue;

      let isTriggered = false;
      if (alert.condition === 'gte' && currentPrice >= alert.targetPrice) {
        isTriggered = true;
      } else if (alert.condition === 'lte' && currentPrice <= alert.targetPrice) {
        isTriggered = true;
      }

      if (isTriggered) {
        // Step 1: Transition to TRIGGERING (Do NOT mark triggered yet! #3)
        alert.triggerStatus = 'TRIGGERING';
        alert.lastAttemptAt = Date.now();
        updated = true;

        console.log(`[AlertService] 🎯 Price crossed level for #${alert.symbol}: target $${alert.targetPrice}, live $${currentPrice} (${alert.condition})`);

        const timeStr = new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' });
        const dateStr = new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv' });

        let levelTitle = 'Цільовий рівень';
        if (alert.levelType === 'entry') levelTitle = 'Рівень входу';
        else if (alert.levelType === 'target') levelTitle = 'Тейк-профіт (Ціль)';
        else if (alert.levelType === 'stop_loss') levelTitle = 'Стоп-лосс';

        const conditionLabel = alert.condition === 'gte'
          ? 'Ціна піднялась або досягла рівня (≥)'
          : 'Ціна опустилась або досягла рівня (≤)';

        const safeSymbol = escapeHtml(alert.symbol);
        const safeFormation = alert.formationName ? escapeHtml(alert.formationName) : '';
        const safeNote = alert.note ? escapeHtml(alert.note) : '';

        const telegramHtml = `🚨 <b>SIGNALHOOK: СПОВІЩЕННЯ ЦІНИ!</b>\n\n` +
          `🪙 <b>${safeSymbol}</b> (${alert.exchange.toUpperCase()} ${alert.marketType.toUpperCase()})\n` +
          `💵 <b>Поточна ціна:</b> $${formatPrice(currentPrice)}\n` +
          `🎯 <b>Ціль сповіщення:</b> $${formatPrice(alert.targetPrice)}\n` +
          `📊 <b>Умова:</b> ${conditionLabel}\n` +
          (safeFormation ? `📈 <b>Формація:</b> ${safeFormation}\n` : '') +
          (alert.levelType ? `🏷 <b>Рівень:</b> ${levelTitle}\n` : '') +
          (safeNote ? `📝 <b>Коментар:</b> ${safeNote}\n` : '') +
          `\n⏰ <i>Час спрацювання: ${dateStr} ${timeStr} (Київ)</i>`;

        // Step 2: Route through unified NotificationRouter (#6 & #8)
        const dispatchResult = await notificationRouter.dispatch({
          source: 'PRICE_ALERT',
          userId: alert.userId,
          symbol: alert.symbol,
          exchange: alert.exchange,
          marketType: alert.marketType,
          eventType: 'PRICE_ALERT',
          eventIdentity: alert.id,
          price: currentPrice,
          title: `Цінове сповіщення: ${alert.symbol}`,
          description: `Ціль $${formatPrice(alert.targetPrice)} досягнута! Поточна ціна: $${formatPrice(currentPrice)}`,
          telegramHtml,
          channels: ['telegram', 'browser', 'internal'],
          metadata: {
            alertId: alert.id,
            targetPrice: alert.targetPrice,
            condition: alert.condition,
            levelType: alert.levelType,
            formationName: alert.formationName,
          },
        });

        // Step 3: Evaluate State Transition based on actual delivery result (#3)
        if (dispatchResult.success) {
          // Successfully processed: mark final TRIGGERED state
          alert.triggered = true;
          alert.isActive = false;
          alert.triggerStatus = 'TRIGGERED';
          alert.triggeredAt = Date.now();
          alert.triggeredPrice = currentPrice;
          alert.lastError = undefined;

          // #15: TP / SL mutual cancellation (OCO)
          // If TARGET triggered -> cancel STOP. If STOP triggered -> cancel TARGET.
          // ENTRY does NOT cancel TP/SL.
          if (alert.setupId && alert.setupRole) {
            const counterpartRole = alert.setupRole === 'TARGET' ? 'STOP' : alert.setupRole === 'STOP' ? 'TARGET' : null;
            if (counterpartRole) {
              for (const other of alerts) {
                if (other.setupId === alert.setupId && other.setupRole === counterpartRole && other.isActive) {
                  other.isActive = false;
                  other.triggerStatus = 'CANCELLED';
                  other.lastError = `Скасовано автоматично через спрацювання ${alert.setupRole}`;
                  console.log(`[AlertService] ⚡ OCO Cancellation: alert #${other.id} (${counterpartRole}) cancelled due to ${alert.setupRole} execution on setup ${alert.setupId}`);
                }
              }
            }
          }

          // Record in Alert History
          addHistoryItem({
            id: `hist_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            userId: alert.userId || 'guest',
            alertId: alert.id,
            symbol: alert.symbol,
            exchange: alert.exchange,
            marketType: alert.marketType,
            condition: alert.condition,
            targetPrice: alert.targetPrice,
            triggeredPrice: currentPrice,
            formationName: alert.formationName,
            levelType: alert.levelType,
            note: alert.note,
            triggeredAt: alert.triggeredAt,
            telegramSent: Boolean(dispatchResult.channels.telegram?.sent),
            telegramError: dispatchResult.channels.telegram?.error,
            telegramStatus: dispatchResult.channels.telegram?.sent
              ? 'sent'
              : dispatchResult.channels.telegram?.skipped
              ? 'not_configured'
              : 'failed',
            createdAt: new Date().toISOString(),
          });
        } else {
          // Notification failed
          const err = dispatchResult.error || 'Помилка надсилання сповіщення';
          const isTerminal = notificationRouter.isTerminalTelegramError(err);
          const currentRetries = (alert.retryCount || 0) + 1;
          alert.retryCount = currentRetries;
          alert.lastError = err;

          if (isTerminal || currentRetries >= 5) {
            // Permanent failure: deactivate alert, do not loop forever (#12)
            alert.isActive = false;
            alert.triggerStatus = 'FAILED';
            console.warn(`[AlertService] ❌ Alert #${alert.id} permanently failed (terminal: ${isTerminal}, retries: ${currentRetries}): ${err}`);

            addHistoryItem({
              id: `hist_fail_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
              userId: alert.userId || 'guest',
              alertId: alert.id,
              symbol: alert.symbol,
              exchange: alert.exchange,
              marketType: alert.marketType,
              condition: alert.condition,
              targetPrice: alert.targetPrice,
              triggeredPrice: currentPrice,
              formationName: alert.formationName,
              levelType: alert.levelType,
              note: alert.note,
              triggeredAt: Date.now(),
              telegramSent: false,
              telegramError: err,
              telegramStatus: 'failed',
              createdAt: new Date().toISOString(),
            });
          } else {
            // Transient failure: enter RETRY state with exponential backoff (#3 & #12)
            alert.triggerStatus = 'RETRY';
            const backoffMs = Math.min(currentRetries * 30000, 300000);
            alert.nextRetryAt = Date.now() + backoffMs;
            console.log(`[AlertService] ⏳ Alert #${alert.id} transient failure, retry in ${backoffMs / 1000}s (attempt ${currentRetries}/5): ${err}`);
          }
        }
      }
    }

    if (updated) {
      saveAlerts(alerts);
    }
  } finally {
    isCheckInFlight = false;
  }
}

// Start background monitor loop
export function startAlertMonitor(intervalMs = 5000) {
  if (monitorInterval) return;
  loadAlerts();
  loadHistory();
  loadUserTelegram();
  monitorInterval = setInterval(() => {
    checkAlertsOnce().catch((err) => {
      console.error('[AlertService] Error during alert check iteration:', err);
    });
  }, intervalMs);
  console.log(`[AlertService] Unified price alert monitor started (interval: ${intervalMs}ms)`);
}

// Stop monitor
export function stopAlertMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
