import { ExchangeId, Kline, Timeframe } from '../../types';

export class RealtimeMarketStream {
  private ws: WebSocket | null = null;
  private destroyed = false;

  constructor(
    public exchange: ExchangeId,
    public symbol: string,
    public timeframe: Timeframe,
    public callbacks: {
      onCandle: (candle: Kline) => void;
      onTick: (tick: { price: number; high24h: number; low24h: number; change24h: number; volumeUsd: number }) => void;
      onStatus: (status: 'LIVE' | 'RECONNECTING' | 'OFFLINE', latencyMs: number) => void;
      onReconnect?: () => void;
    }
  ) {
    this.connect();
  }

  private connect() {
    if (this.destroyed) return;
    const cleanSym = this.symbol.toLowerCase();
    const url = `wss://fstream.binance.com/ws/${cleanSym}@ticker`;
    try {
      this.ws = new WebSocket(url);
      this.callbacks.onStatus('LIVE', 5);
      this.callbacks.onReconnect?.();
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.c) {
            const price = parseFloat(data.c);
            const high24h = parseFloat(data.h || data.c);
            const low24h = parseFloat(data.l || data.c);
            const change24h = parseFloat(data.P || '0');
            const volumeUsd = parseFloat(data.q || '0');
            this.callbacks.onTick({ price, high24h, low24h, change24h, volumeUsd });
          }
        } catch {}
      };
    } catch {
      this.callbacks.onStatus('RECONNECTING', 0);
    }
  }

  public destroy() {
    this.destroyed = true;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
