import { Kline } from '../../types';

export interface ChartLevelZone {
  center: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strengthScore: number;
}

export function detectLevelZones(candles: Kline[], currentPrice: number): ChartLevelZone[] {
  if (!candles || candles.length === 0) return [];
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const maxH = Math.max(...highs);
  const minL = Math.min(...lows);
  return [
    { center: maxH * 0.98, type: 'RESISTANCE', strengthScore: 85 },
    { center: minL * 1.02, type: 'SUPPORT', strengthScore: 90 },
  ];
}
