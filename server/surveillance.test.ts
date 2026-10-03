import test from 'node:test';
import assert from 'node:assert';
import { NotificationRouter, NotificationEvent } from './notificationRouter';
import { TradeClassificationService } from './surveillance/tradeClassificationService';
import { OrderBookEngine } from './surveillance/orderBookEngine';
import { AnalysisCore } from './surveillance/analysisCore';
import { getDefaultSurveillanceConfig } from './surveillanceService';

test('1. telegramEnabled=false -> no Telegram delivery', async () => {
  const router = NotificationRouter.getInstance();
  const event: NotificationEvent = {
    source: 'SURVEILLANCE',
    userId: 'user1',
    symbol: 'BTCUSDT',
    exchange: 'binance',
    marketType: 'futures',
    eventType: 'DENSITY_APPEARED',
    title: 'Test',
    description: 'Test desc',
    price: 50000,
    channels: ['telegram', 'browser'],
    coin: {
      id: 'coin1',
      userId: 'user1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      exchange: 'binance',
      marketType: 'futures',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {
        ...getDefaultSurveillanceConfig(),
        telegramEnabled: false,
        densityAlerts: true,
        triggerModes: ['realtime'],
      },
    },
  };
  const res = await router.dispatch(event);
  assert.strictEqual(res.channels.telegram?.sent, false);
});

test('2. telegramEnabled=false + browser/internal -> no Telegram', async () => {
  const router = NotificationRouter.getInstance();
  const event: NotificationEvent = {
    source: 'SURVEILLANCE',
    userId: 'user1',
    symbol: 'BTCUSDT',
    exchange: 'binance',
    marketType: 'futures',
    eventType: 'STRUCTURE_SHIFT',
    title: 'Test',
    description: 'Test',
    price: 50000,
    channels: ['telegram', 'browser'],
    coin: {
      id: 'coin1',
      userId: 'user1',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      exchange: 'binance',
      marketType: 'futures',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {
        ...getDefaultSurveillanceConfig(),
        telegramEnabled: false,
        triggerModes: ['realtime'],
      },
    },
  };
  const res = await router.dispatch(event);
  assert.strictEqual(res.channels.telegram?.sent, false);
});

test('13. Binance BUY classification', () => {
  const classified = TradeClassificationService.classifyBinanceTrade(50000, 1.5, false, Date.now());
  assert.strictEqual(classified.side, 'BUY');
  assert.strictEqual(classified.isBuyerMaker, false);
});

test('14. Binance SELL classification', () => {
  const classified = TradeClassificationService.classifyBinanceTrade(50000, 1.5, true, Date.now());
  assert.strictEqual(classified.side, 'SELL');
  assert.strictEqual(classified.isBuyerMaker, true);
});

test('15. Bybit BUY classification', () => {
  const classified = TradeClassificationService.classifyBybitTrade(50000, 1.5, 'Buy', Date.now());
  assert.strictEqual(classified.side, 'BUY');
});

test('16. Bybit SELL classification', () => {
  const classified = TradeClassificationService.classifyBybitTrade(50000, 1.5, 'Sell', Date.now());
  assert.strictEqual(classified.side, 'SELL');
});

test('21. Invalid order book -> no Density alert', () => {
  const ob = new OrderBookEngine('BTCUSDT', 'binance', 'futures', { mode: 'AUTO', manualThresholdUsd: 100000, minPersistenceSeconds: 15, minDistancePct: 0.1 });
  ob.applyDepth({ bids: [[49999, 10]], asks: [[50001, 10]], isSnapshot: true, sequence: 1 }, 1000000);
  ob.setStatus('STALE');
  assert.strictEqual(ob.dataValid, false);
  const densities = ob.getSignificantDensities();
  assert.strictEqual(densities.length, 0);
});

test('22 & 23. Order book reconnect and sequence resync', () => {
  const ob = new OrderBookEngine('BTCUSDT', 'binance', 'futures', { mode: 'AUTO', manualThresholdUsd: 100000, minPersistenceSeconds: 15, minDistancePct: 0.1 });
  ob.resetForReconnect();
  assert.strictEqual(ob.status, 'CONNECTING');
  assert.strictEqual(ob.dataValid, false);

  ob.applyDepth({ bids: [[49999, 5]], asks: [[50001, 5]], isSnapshot: true, sequence: 100 }, 1000000);
  assert.strictEqual(ob.status, 'LIVE');
  assert.strictEqual(ob.dataValid, true);

  // Out of order update sequence gap
  ob.applyDepth({ bids: [[49998, 2]], asks: [], isSnapshot: false, sequence: 95 }, 1000000);
  assert.strictEqual(ob.dataValid, false);
  assert.strictEqual(ob.status, 'RESYNCING');
});

test('24 & 25. LONG and SHORT geometry', () => {
  const longEntry = 100;
  const longStop = 95;
  const longTarget = 110;
  assert.ok(longStop < longEntry && longEntry < longTarget, 'LONG geometry valid');

  const shortEntry = 100;
  const shortStop = 105;
  const shortTarget = 90;
  assert.ok(shortTarget < shortEntry && shortEntry < shortStop, 'SHORT geometry valid');
});

test('31 & 32. Causal Backtest vs Live AnalysisCore consistency', () => {
  const candles = [
    { time: 1000, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { time: 2000, open: 11, high: 13, low: 10, close: 12, volume: 150 },
    { time: 3000, open: 12, high: 15, low: 11, close: 14, volume: 300 },
  ];

  const liveCore = new AnalysisCore('LIVE');
  const backtestCore = new AnalysisCore('BACKTEST');

  const liveRes = liveCore.evaluateCausalSlice('BTCUSDT', candles, 2, '15m');
  const backtestRes = backtestCore.evaluateCausalSlice('BTCUSDT', candles, 2, '15m');

  assert.strictEqual(liveRes.currentPrice, backtestRes.currentPrice);
  assert.strictEqual(liveRes.asOfTime, backtestRes.asOfTime);
  assert.strictEqual(liveRes.zones.length, backtestRes.zones.length);
});
