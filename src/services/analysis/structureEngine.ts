import { Kline } from '../../types';

export interface MarketStructureResult {
  trend: 'BULLISH' | 'BEARISH' | 'RANGE';
  swings: Array<{ price: number; time: number; swingType: 'HIGH' | 'LOW' }>;
  lastBreak?: { type: 'BOS' | 'CHOCH'; direction: 'BULLISH' | 'BEARISH'; price: number };
}

export function detectMarketStructure(candles: Kline[]): MarketStructureResult {
  if (!candles || candles.length < 10) return { trend: 'RANGE', swings: [] };
  const swings: Array<{ price: number; time: number; swingType: 'HIGH' | 'LOW' }> = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    if (c.high > candles[i - 1].high && c.high > candles[i + 1].high) {
      swings.push({ price: c.high, time: c.time, swingType: 'HIGH' });
    }
    if (c.low < candles[i - 1].low && c.low < candles[i + 1].low) {
      swings.push({ price: c.low, time: c.time, swingType: 'LOW' });
    }
  }
  return { trend: 'RANGE', swings };
}
