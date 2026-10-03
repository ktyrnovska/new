import { Kline } from '../../types';

export function calculateVolumeSMA20(candles: Kline[]): Array<{ time: number; value: number; color: string; sma20: number }> {
  return candles.map((c, idx, arr) => {
    const start = Math.max(0, idx - 19);
    const slice = arr.slice(start, idx + 1);
    const sum = slice.reduce((acc, cur) => acc + (cur.volume || 0), 0);
    const sma20 = sum / slice.length;
    const isBull = c.close >= c.open;
    return {
      time: c.time,
      value: c.volume || 0,
      color: isBull ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)',
      sma20,
    };
  });
}

export function calculateFibonacciLevels(high: number, low: number): Array<{ price: number; label: string; ratio: number; isGoldenPocket: boolean }> {
  const diff = high - low;
  return [
    { price: high, label: '0.0 (High)', ratio: 0, isGoldenPocket: false },
    { price: high - diff * 0.236, label: '0.236', ratio: 0.236, isGoldenPocket: false },
    { price: high - diff * 0.382, label: '0.382', ratio: 0.382, isGoldenPocket: false },
    { price: high - diff * 0.5, label: '0.5', ratio: 0.5, isGoldenPocket: false },
    { price: high - diff * 0.618, label: '0.618 (Golden Pocket)', ratio: 0.618, isGoldenPocket: true },
    { price: high - diff * 0.65, label: '0.65 (Golden Pocket)', ratio: 0.65, isGoldenPocket: true },
    { price: high - diff * 0.786, label: '0.786', ratio: 0.786, isGoldenPocket: false },
    { price: low, label: '1.0 (Low)', ratio: 1, isGoldenPocket: false },
  ];
}
