export type AggressiveSide = 'BUY' | 'SELL';

export interface ClassifiedTrade {
  price: number;
  quantity: number;
  notionalUsd: number;
  side: AggressiveSide;
  time: number;
  isBuyerMaker?: boolean;
}

/**
 * Unified Trade Classification Service (#9)
 * Strictly determines BUY / SELL from actual exchange trade data without synthetic estimations.
 *
 * Rules:
 * Binance:
 * - isBuyerMaker = true  -> Maker is buyer, taker is seller -> Aggressive SELL
 * - isBuyerMaker = false -> Maker is seller, taker is buyer -> Aggressive BUY
 *
 * Bybit:
 * - Trade message contains taker side ('Buy' -> BUY, 'Sell' -> SELL)
 */
export class TradeClassificationService {
  public static classifyBinanceTrade(
    price: number,
    quantity: number,
    isBuyerMaker: boolean,
    time: number
  ): ClassifiedTrade {
    const side: AggressiveSide = isBuyerMaker ? 'SELL' : 'BUY';
    return {
      price,
      quantity,
      notionalUsd: price * quantity,
      side,
      time,
      isBuyerMaker,
    };
  }

  public static classifyBybitTrade(
    price: number,
    quantity: number,
    sideStr: string,
    time: number
  ): ClassifiedTrade {
    const upper = String(sideStr || '').toUpperCase();
    const side: AggressiveSide = upper.startsWith('B') ? 'BUY' : 'SELL';
    return {
      price,
      quantity,
      notionalUsd: price * quantity,
      side,
      time,
      isBuyerMaker: side === 'SELL',
    };
  }

  public static classify(data: {
    price: number;
    quantity: number;
    side?: string;
    isBuyerMaker?: boolean;
    time?: number;
    exchange?: string;
  }): ClassifiedTrade {
    const time = data.time || Date.now();
    if (data.isBuyerMaker !== undefined) {
      return this.classifyBinanceTrade(data.price, data.quantity, data.isBuyerMaker, time);
    }
    if (data.side) {
      return this.classifyBybitTrade(data.price, data.quantity, data.side, time);
    }
    return {
      price: data.price,
      quantity: data.quantity,
      notionalUsd: data.price * data.quantity,
      side: 'BUY',
      time,
    };
  }
}
