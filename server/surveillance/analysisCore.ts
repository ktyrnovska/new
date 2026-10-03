import { Kline, Timeframe } from '../../src/types';
import { LevelsAndFormationsEngine } from './levelsAndFormationsEngine';
import { MultiTimeframeEngine } from './multiTimeframeEngine';
import { LevelZone, DetectedPattern, TimeframeStructure } from './types';

export interface CausalAnalysisContext {
  symbol: string;
  currentPrice: number;
  candles: Kline[];
  timeframe: Timeframe;
  asOfIndex: number;
}

export interface CausalAnalysisResult {
  symbol: string;
  asOfTime: number;
  currentPrice: number;
  zones: LevelZone[];
  patterns: DetectedPattern[];
  structures: Record<Timeframe, TimeframeStructure>;
}

/**
 * Shared AnalysisCore (#17)
 * Guarantees identical causal logic between LiveAnalysisPipeline and BacktestAnalysisPipeline.
 * Strictly operates on candles[0 ... asOfIndex] with ZERO future-candle leakage.
 */
export class AnalysisCore {
  private levelsEngine: LevelsAndFormationsEngine;
  private mtfEngine: MultiTimeframeEngine;

  constructor(public readonly mode: 'LIVE' | 'BACKTEST' = 'LIVE') {
    this.levelsEngine = new LevelsAndFormationsEngine(mode);
    this.mtfEngine = new MultiTimeframeEngine();
  }

  /**
   * Evaluates historical slice causal snapshot at given bar index T
   */
  public evaluateCausalSlice(
    symbol: string,
    allCandles: Kline[],
    asOfIndex: number,
    timeframe: Timeframe = '15m'
  ): CausalAnalysisResult {
    // Strictly isolate past and current candles up to asOfIndex
    const safeIndex = Math.max(0, Math.min(asOfIndex, allCandles.length - 1));
    const historicalSlice = allCandles.slice(0, safeIndex + 1);
    const currentCandle = historicalSlice[historicalSlice.length - 1];
    const currentPrice = currentCandle.close;
    const asOfTime = currentCandle.time;

    // 1. Causal S/R Zones (evaluates swings with zero look-ahead bias)
    const zones = this.levelsEngine.findSupportResistanceZones(
      [],
      [],
      historicalSlice,
      { mode: this.mode, asOfTime }
    );

    // 2. Causal Formations detection
    const patterns = this.levelsEngine.detectFormations(historicalSlice, currentPrice, symbol);

    // 3. Multi-timeframe structures
    for (const tf of ['1d', '4h', '1h', '15m', '5m', '1m'] as Timeframe[]) {
      this.mtfEngine.setCandles(tf, historicalSlice);
    }
    const structures = this.mtfEngine.getMultiTimeframeStructures(currentPrice);

    return {
      symbol,
      asOfTime,
      currentPrice,
      zones,
      patterns,
      structures,
    };
  }
}

export class LiveAnalysisPipeline {
  private core = new AnalysisCore('LIVE');

  public run(symbol: string, candles: Kline[], timeframe: Timeframe = '15m'): CausalAnalysisResult {
    return this.core.evaluateCausalSlice(symbol, candles, candles.length - 1, timeframe);
  }
}

export class BacktestAnalysisPipeline {
  private core = new AnalysisCore('BACKTEST');

  public runAtBar(
    symbol: string,
    allCandles: Kline[],
    barIndex: number,
    timeframe: Timeframe = '15m'
  ): CausalAnalysisResult {
    // Strictly forbids looking past barIndex
    return this.core.evaluateCausalSlice(symbol, allCandles, barIndex, timeframe);
  }
}
