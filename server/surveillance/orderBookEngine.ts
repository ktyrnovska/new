import { ExchangeId, MarketType } from '../../src/types';
import { RawDepthDelta } from './exchangeStream';
import { DensityItem, OrderBookLevel, OrderBookState, OrderBookStatus } from './types';

export interface DensityConfig {
  mode: 'AUTO' | 'MANUAL' | 'HYBRID';
  manualThresholdUsd: number;
  minPersistenceSeconds: number;
  minDistancePct: number;
}

interface DensityStats {
  firstSeenAt: number;
  lastSeenAt: number;
  samples: number;
  presentSamples: number;
  sizeSumUsd: number;
  maxSizeUsd: number;
  lastSizeUsd: number;
  lastSizeChangeAt: number;
  cancellations: number;
  replenishments: number;
  nearestApproachPct: number;
  lastReplenishedAt?: number;
}

export class OrderBookEngine {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private activeDensities = new Map<string, DensityItem>();
  private densityHistory: DensityItem[] = [];
  private densityStats = new Map<string, DensityStats>();

  public bestBid = 0;
  public bestAsk = 0;
  public spread = 0;
  public spreadPct = 0;
  public lastUpdateId = 0;
  public lastReceivedAt = 0;
  public dataValid = false;
  public sequenceGap = false;
  public status: OrderBookStatus = 'CONNECTING';

  // Event queues for density lifecycles (#7)
  private newlyAppearedDensities: DensityItem[] = [];
  private newlyReplenishedDensities: DensityItem[] = [];
  private newlyRemovedDensities: DensityItem[] = [];

  constructor(
    public readonly symbol: string,
    public readonly exchange: ExchangeId,
    public readonly marketType: MarketType,
    private config: DensityConfig = {
      mode: 'AUTO',
      manualThresholdUsd: 500000,
      minPersistenceSeconds: 15,
      minDistancePct: 0.1,
    }
  ) {}

  public updateConfig(newConfig: Partial<DensityConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  public getConfig(): DensityConfig {
    return { ...this.config };
  }

  public setStatus(newStatus: OrderBookStatus) {
    this.status = newStatus;
    if (newStatus !== 'LIVE') {
      this.dataValid = false;
    }
  }

  /**
   * Resets the order book on reconnect (#5)
   */
  public resetForReconnect() {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = 0;
    this.dataValid = false;
    this.sequenceGap = false;
    this.status = 'CONNECTING';
    this.newlyAppearedDensities = [];
    this.newlyReplenishedDensities = [];
    this.newlyRemovedDensities = [];
  }

  /**
   * Applies incoming order book depth delta or snapshot (#5)
   */
  public applyDepth(delta: RawDepthDelta, volume24hUsd = 0) {
    const now = Date.now();
    this.lastReceivedAt = now;
    const seq = delta.sequence || now;

    // Sequence gap detection
    if (!delta.isSnapshot) {
      if (this.status === 'CONNECTING' || this.status === 'RESYNCING') {
        // Delta received before initial snapshot: reject until snapshot arrives
        this.dataValid = false;
        return;
      }
      if (this.lastUpdateId > 0 && delta.sequence && seq <= this.lastUpdateId) {
        this.sequenceGap = true;
        this.dataValid = false;
        this.status = 'RESYNCING';
        return;
      }
    }

    this.sequenceGap = false;
    this.lastUpdateId = seq;

    if (delta.isSnapshot) {
      this.bids.clear();
      this.asks.clear();
      this.dataValid = true;
      this.status = 'LIVE';
    }

    for (const [price, qty] of delta.bids) {
      if (qty <= 0) this.bids.delete(price);
      else this.bids.set(price, qty);
    }
    for (const [price, qty] of delta.asks) {
      if (qty <= 0) this.asks.delete(price);
      else this.asks.set(price, qty);
    }

    this.bestBid = this.bids.size ? Math.max(0, ...this.bids.keys()) : 0;
    this.bestAsk = this.asks.size ? Math.min(...this.asks.keys()) : 0;

    if (this.bestBid > 0 && this.bestAsk > 0 && this.bestAsk >= this.bestBid) {
      this.spread = this.bestAsk - this.bestBid;
      this.spreadPct = (this.spread / this.bestBid) * 100;
      this.dataValid = true;
      this.status = 'LIVE';
    }

    // Evaluate densities strictly when order book data is valid
    if (this.dataValid) {
      this.evaluateDensities(volume24hUsd);
    }
  }

  public getSortedBids(limit = 30): OrderBookLevel[] {
    return Array.from(this.bids.keys())
      .sort((a, b) => b - a)
      .slice(0, limit)
      .map((price) => ({
        price,
        quantity: this.bids.get(price) || 0,
        notionalUsd: price * (this.bids.get(price) || 0),
      }));
  }

  public getSortedAsks(limit = 30): OrderBookLevel[] {
    return Array.from(this.asks.keys())
      .sort((a, b) => a - b)
      .slice(0, limit)
      .map((price) => ({
        price,
        quantity: this.asks.get(price) || 0,
        notionalUsd: price * (this.asks.get(price) || 0),
      }));
  }

  public getState(): OrderBookState {
    if (this.lastReceivedAt > 0 && Date.now() - this.lastReceivedAt > 5000) {
      this.status = 'STALE';
      this.dataValid = false;
    }
    return {
      symbol: this.symbol,
      exchange: this.exchange,
      marketType: this.marketType,
      bids: this.getSortedBids(20),
      asks: this.getSortedAsks(20),
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      spread: this.spread,
      spreadPct: Number(this.spreadPct.toFixed(4)),
      lastUpdateId: this.lastUpdateId,
      sequence: this.lastUpdateId,
      timestamp: this.lastReceivedAt || Date.now(),
      status: this.status,
      lastReceivedAt: this.lastReceivedAt,
    };
  }

  /**
   * Unified Adaptive Threshold Calculation (#6)
   * AUTO: dynamically derived from visible book order size distribution (P90 * 2) and turnover baseline.
   * MANUAL: strictly uses configured manualThresholdUsd.
   * HYBRID: combines adaptive threshold with manual floor/ceiling.
   */
  public calculateAdaptiveThreshold(volume24hUsd = 0): number {
    const manual = this.config.manualThresholdUsd || 500000;
    if (this.config.mode === 'MANUAL') {
      return manual;
    }

    const all = [
      ...Array.from(this.bids, ([p, q]) => p * q),
      ...Array.from(this.asks, ([p, q]) => p * q),
    ];

    let autoVal: number;
    if (!all.length) {
      autoVal = manual;
    } else {
      all.sort((a, b) => a - b);
      const p90 = all[Math.min(all.length - 1, Math.floor(all.length * 0.90))] || 50000;
      const turnoverBaseline = volume24hUsd > 0 ? Math.max(50000, volume24hUsd * 0.0003) : 100000;
      autoVal = Math.max(turnoverBaseline, p90 * 2);
    }

    if (this.config.mode === 'HYBRID') {
      return Math.max(manual, autoVal);
    }

    return autoVal;
  }

  public pollNewlyAppearedDensities(): DensityItem[] {
    if (!this.dataValid) return [];
    const items = [...this.newlyAppearedDensities];
    this.newlyAppearedDensities = [];
    return items;
  }

  public pollNewlyReplenishedDensities(): DensityItem[] {
    if (!this.dataValid) return [];
    const items = [...this.newlyReplenishedDensities];
    this.newlyReplenishedDensities = [];
    return items;
  }

  public pollNewlyRemovedDensities(): DensityItem[] {
    if (!this.dataValid) return [];
    const items = [...this.newlyRemovedDensities];
    this.newlyRemovedDensities = [];
    return items;
  }

  /**
   * Single-cycle density evaluation (#6 & #7)
   */
  private evaluateDensities(volume24hUsd = 0) {
    const now = Date.now();
    const mid = (this.bestBid + this.bestAsk) / 2 || this.bestBid || this.bestAsk || 1;
    // Exactly ONE threshold per evaluation cycle (#6)
    const threshold = this.calculateAdaptiveThreshold(volume24hUsd);
    const seen = new Set<string>();

    const minBidInBook = this.bids.size > 0 ? Math.min(...this.bids.keys()) : 0;
    const maxAskInBook = this.asks.size > 0 ? Math.max(...this.asks.keys()) : Infinity;

    const scan = (book: Map<number, number>, side: 'BID' | 'ASK') => {
      for (const [price, qty] of book.entries()) {
        const notional = price * qty;
        if (notional < threshold) continue;
        const id = `${side.toLowerCase()}_${price}`;
        seen.add(id);
        const dist = Math.abs((price - mid) / mid) * 100;
        this.updateOrAddDensity(id, side, price, qty, notional, dist, now, threshold);
      }
    };

    scan(this.bids, 'BID');
    scan(this.asks, 'ASK');

    // Detect removed densities (#7)
    for (const [id, item] of this.activeDensities.entries()) {
      if (seen.has(id)) continue;

      // Check if order stepped out of visible top book window vs actual cancellation
      const isOutsideVisibleWindow =
        (item.side === 'BID' && item.price < minBidInBook) ||
        (item.side === 'ASK' && item.price > maxAskInBook);

      if (isOutsideVisibleWindow) {
        // Kept in memory without falsely recording cancellation
        if (now - item.lastSeenAt > 600000) {
          this.activeDensities.delete(id);
        }
        continue;
      }

      // Order was inside visible book and disappeared: true cancellation/fill (#7)
      const stats = this.densityStats.get(id);
      if (stats) stats.cancellations += 1;
      const age = Math.max(0.1, (now - item.firstSeenAt) / 1000);
      const disappearedNearPrice = item.distancePct <= 0.25;
      const cancellationRate = stats ? stats.cancellations / Math.max(1, stats.samples) : 1;
      item.cancellationRate = Number(cancellationRate.toFixed(3));

      if (disappearedNearPrice && age < 60 && cancellationRate > 0.15) {
        item.classification = 'POSSIBLE_SPOOF';
      } else if (age < this.config.minPersistenceSeconds) {
        item.classification = 'TRANSIENT_LIQUIDITY';
      }

      item.qualityScore = this.calculateQuality(item, stats);
      this.densityHistory.unshift(item);
      if (this.densityHistory.length > 100) this.densityHistory.pop();

      // Record true removal if notional was substantial
      if (item.notionalUsd >= threshold) {
        this.newlyRemovedDensities.push({ ...item });
      }

      this.activeDensities.delete(id);
    }
  }

  private updateOrAddDensity(
    id: string,
    side: 'BID' | 'ASK',
    price: number,
    qty: number,
    notional: number,
    distPct: number,
    now: number,
    threshold: number
  ) {
    let stats = this.densityStats.get(id);
    const isBrandNew = !stats;

    if (!stats) {
      stats = {
        firstSeenAt: now,
        lastSeenAt: now,
        samples: 0,
        presentSamples: 0,
        sizeSumUsd: 0,
        maxSizeUsd: notional,
        lastSizeUsd: notional,
        lastSizeChangeAt: now,
        cancellations: 0,
        replenishments: 0,
        nearestApproachPct: distPct,
      };
      this.densityStats.set(id, stats);
    }

    stats.samples += 1;
    stats.presentSamples += 1;
    stats.lastSeenAt = now;
    stats.sizeSumUsd += notional;
    stats.maxSizeUsd = Math.max(stats.maxSizeUsd, notional);
    stats.nearestApproachPct = Math.min(stats.nearestApproachPct, distPct);

    // Replenishment detection: volume increased by >= 30% above prior level (#7)
    let isReplenished = false;
    if (notional >= stats.lastSizeUsd * 1.30 && stats.lastSizeUsd > 0) {
      stats.replenishments += 1;
      const lastReplenish = stats.lastReplenishedAt || 0;
      if (now - lastReplenish >= 60000) {
        stats.lastReplenishedAt = now;
        isReplenished = true;
      }
    }

    if (Math.abs(notional - stats.lastSizeUsd) / Math.max(stats.lastSizeUsd, 1) > 0.1) {
      stats.lastSizeChangeAt = now;
    }
    stats.lastSizeUsd = notional;

    const existing = this.activeDensities.get(id);
    if (existing) {
      existing.quantity = qty;
      existing.notionalUsd = notional;
      existing.distancePct = Number(distPct.toFixed(3));
      existing.lastSeenAt = now;
      existing.ageSeconds = Math.floor((now - existing.firstSeenAt) / 1000);
      existing.maxSizeUsd = Math.max(existing.maxSizeUsd, notional);
      existing.averageSizeUsd = stats.sizeSumUsd / Math.max(1, stats.presentSamples);
      existing.persistenceRatio = stats.presentSamples / Math.max(1, stats.samples);
      existing.persistenceSamples = stats.presentSamples;
      existing.cancellationRate = stats.cancellations / Math.max(1, stats.samples);
      existing.replenishmentRate = stats.replenishments / Math.max(1, stats.samples);
      existing.lastSizeChangeAt = stats.lastSizeChangeAt;

      if (
        existing.ageSeconds >= this.config.minPersistenceSeconds &&
        existing.persistenceRatio >= 0.65
      ) {
        existing.classification = 'PERSISTENT_LIQUIDITY';
      }

      existing.qualityScore = this.calculateQuality(existing, stats);

      if (isReplenished && notional >= threshold) {
        this.newlyReplenishedDensities.push({ ...existing });
      }
    } else {
      const item: DensityItem = {
        id,
        price,
        side,
        quantity: qty,
        notionalUsd: notional,
        distancePct: Number(distPct.toFixed(3)),
        firstSeenAt: now,
        lastSeenAt: now,
        ageSeconds: 0,
        maxSizeUsd: notional,
        averageSizeUsd: notional,
        persistenceRatio: 1,
        classification: 'STANDARD',
        persistenceSamples: 1,
        cancellationRate: 0,
        replenishmentRate: 0,
        qualityScore: 20,
        lastSizeChangeAt: now,
      };

      this.activeDensities.set(id, item);

      // Trigger DENSITY_APPEARED based on the unified cycle threshold (#6 & #7)
      if (isBrandNew && notional >= threshold) {
        this.newlyAppearedDensities.push(item);
      }
    }
  }

  private calculateQuality(item: DensityItem, stats?: DensityStats): number {
    if (!stats) return item.qualityScore || 0;
    const persistence = Math.min(25, (item.persistenceRatio || 0) * 25);
    const duration = Math.min(20, (item.ageSeconds / Math.max(1, this.config.minPersistenceSeconds)) * 20);
    const sizeStability = Math.min(
      15,
      item.averageSizeUsd > 0 ? Math.min(1.5, item.notionalUsd / item.averageSizeUsd) * 10 : 0
    );
    const maxDistance = Math.max(this.config.minDistancePct, 0.6);
    const proximity =
      item.distancePct <= this.config.minDistancePct
        ? 15
        : Math.max(0, 15 * (1 - Math.min(1, item.distancePct / maxDistance)));
    const replenishment = Math.min(15, (item.replenishmentRate || 0) * 60);
    const spoofPenalty =
      item.classification === 'POSSIBLE_SPOOF' ? 40 : Math.min(20, (item.cancellationRate || 0) * 50);

    return Math.max(
      0,
      Math.min(100, Math.round(persistence + duration + sizeStability + proximity + replenishment - spoofPenalty))
    );
  }

  public getOrderBookImbalance(levels = 20): number {
    if (!this.dataValid || Date.now() - this.lastReceivedAt > 5000) return 0;
    const bids = this.getSortedBids(levels).reduce((s, l) => s + l.notionalUsd, 0);
    const asks = this.getSortedAsks(levels).reduce((s, l) => s + l.notionalUsd, 0);
    if (bids + asks === 0) return 0;
    return (bids - asks) / (bids + asks);
  }

  public getDensityQualityAtPrice(
    side: 'BID' | 'ASK',
    price: number,
    maxDistancePct = 0.6
  ): DensityItem | undefined {
    return this.getDensities()
      .filter(
        (d) =>
          d.side === side &&
          d.classification !== 'POSSIBLE_SPOOF' &&
          (Math.abs(d.price - price) / Math.max(price, 1)) * 100 <= maxDistancePct
      )
      .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0))[0];
  }

  public getDensities(): DensityItem[] {
    if (!this.dataValid || Date.now() - this.lastReceivedAt > 5000) return [];
    return Array.from(this.activeDensities.values()).sort((a, b) => b.notionalUsd - a.notionalUsd);
  }

  public getSignificantDensities(minNotional = 500000): DensityItem[] {
    return this.getDensities().filter((d) => d.notionalUsd >= minNotional);
  }

  public clear() {
    this.bids.clear();
    this.asks.clear();
    this.activeDensities.clear();
    this.densityStats.clear();
    this.dataValid = false;
    this.sequenceGap = false;
    this.status = 'CONNECTING';
    this.newlyAppearedDensities = [];
    this.newlyReplenishedDensities = [];
    this.newlyRemovedDensities = [];
  }
}
