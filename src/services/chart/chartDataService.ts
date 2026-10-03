import { Kline } from '../../types';

export class ChartDataStore {
  private candles: Kline[] = [];

  public setCandles(candles: Kline[]) {
    this.candles = [...candles].sort((a, b) => a.time - b.time);
  }

  public getCandles(): Kline[] {
    return this.candles;
  }

  public getFirstCandle(): Kline | undefined {
    return this.candles[0];
  }

  public getLastCandle(): Kline | undefined {
    return this.candles[this.candles.length - 1];
  }

  public prependHistory(older: Kline[]): number {
    const sortedOlder = [...older].sort((a, b) => a.time - b.time);
    const existingTimes = new Set(this.candles.map(c => c.time));
    const newItems = sortedOlder.filter(c => !existingTimes.has(c.time));
    if (newItems.length > 0) {
      this.candles = [...newItems, ...this.candles];
    }
    return newItems.length;
  }

  public updateLiveCandle(candle: Kline): { isNewCandle: boolean; updatedCandle: Kline } {
    const last = this.candles[this.candles.length - 1];
    if (!last || candle.time > last.time) {
      this.candles.push(candle);
      return { isNewCandle: true, updatedCandle: candle };
    } else {
      this.candles[this.candles.length - 1] = candle;
      return { isNewCandle: false, updatedCandle: candle };
    }
  }
}
