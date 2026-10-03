import { Kline, Timeframe } from '../../types';
import { fetchDirectKlines } from '../../utils/directExchangeClient';

export async function fetchBybitFuturesHistory(
  symbol: string,
  timeframe: Timeframe,
  limit = 1000,
  endTime?: number
): Promise<Kline[]> {
  try {
    return await fetchDirectKlines('bybit', 'futures', symbol, timeframe, limit);
  } catch {
    return [];
  }
}

export async function fetchBybitFuturesStats(symbol: string): Promise<{
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volumeUsd: number;
  fundingRate: number | null;
  openInterestUsd: number | null;
}> {
  return { price: 0, change24h: 0, high24h: 0, low24h: 0, volumeUsd: 0, fundingRate: null, openInterestUsd: null };
}
