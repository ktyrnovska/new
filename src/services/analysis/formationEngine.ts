import { Kline, DetectedFormation } from '../../types';
import { detectFormations as utilDetectFormations } from '../../utils/patternRecognition';

export type ChartFormation = DetectedFormation;

export function detectFormations(candles: Kline[], currentPrice: number): ChartFormation[] {
  try {
    return utilDetectFormations(candles, 'BTCUSDT');
  } catch {
    return [];
  }
}
