import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ExchangeId, MarketType } from '../../src/types';
import { OrderBookStatus } from './types';

export interface RawTradeEvent {
  price: number;
  quantity: number;
  side: 'BUY' | 'SELL';
  time: number;
  isBuyerMaker: boolean;
}

export interface RawDepthDelta {
  bids: [number, number][]; // [price, qty]
  asks: [number, number][];
  isSnapshot?: boolean;
  sequence?: number;
}

export class ExchangeStreamClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private isDestroyed = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;

  private reconnectAttempts = 0;
  private readonly backoffSchedule = [1000, 2000, 5000, 10000, 20000, 30000];

  public status: OrderBookStatus = 'CONNECTING';
  public lastDataReceivedAt = 0;

  constructor(
    public readonly symbol: string,
    public readonly exchange: ExchangeId,
    public readonly marketType: MarketType
  ) {
    super();
    this.connect();
    this.startWatchdog();
  }

  private cleanSymbol(): string {
    return this.symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  /**
   * Constructs the correct WebSocket URL according to exchange API documentation.
   * Binance:
   * - Futures combined stream: wss://fstream.binance.com/stream?streams=<s1>/<s2>/<s3>
   * - Spot combined stream: wss://stream.binance.com:9443/stream?streams=<s1>/<s2>/<s3>
   * Bybit:
   * - Futures (Linear): wss://stream.bybit.com/v5/public/linear
   * - Spot: wss://stream.bybit.com/v5/public/spot
   */
  private getWebSocketUrl(): string {
    const sym = this.cleanSymbol();
    if (this.exchange === 'binance') {
      const lower = sym.toLowerCase();
      if (this.marketType === 'futures') {
        return `wss://fstream.binance.com/stream?streams=${lower}@ticker/${lower}@aggTrade/${lower}@depth20@100ms`;
      } else {
        return `wss://stream.binance.com:9443/stream?streams=${lower}@ticker/${lower}@trade/${lower}@depth20@100ms`;
      }
    } else {
      // Bybit v5 public WebSocket endpoints
      if (this.marketType === 'futures') {
        return 'wss://stream.bybit.com/v5/public/linear';
      } else {
        return 'wss://stream.bybit.com/v5/public/spot';
      }
    }
  }

  private setStatus(newStatus: OrderBookStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.emit('status', newStatus);
    }
  }

  public connect() {
    if (this.isDestroyed || this.isConnecting) return;
    this.cleanupSocket();

    const url = this.getWebSocketUrl();
    this.setStatus('CONNECTING');
    this.isConnecting = true;

    try {
      console.log(`[ExchangeStream] Connecting #${this.symbol} to ${this.exchange.toUpperCase()} (${this.marketType}): ${url}`);
      this.ws = new WebSocket(url, {
        handshakeTimeout: 10000,
      });

      this.ws.on('open', () => {
        this.isConnecting = false;
        if (this.isDestroyed) {
          this.cleanupSocket();
          return;
        }
        this.reconnectAttempts = 0;
        this.setStatus('SYNCING');
        this.lastDataReceivedAt = Date.now();
        console.log(`[ExchangeStream] Socket opened successfully for #${this.symbol} on ${this.exchange}`);

        // Bybit requires explicit subscription message
        if (this.exchange === 'bybit') {
          const sym = this.cleanSymbol();
          const subscribeMsg = {
            op: 'subscribe',
            args: [`tickers.${sym}`, `publicTrade.${sym}`, `orderbook.50.${sym}`],
          };
          try {
            this.ws?.send(JSON.stringify(subscribeMsg));
          } catch (err) {
            console.error(`[ExchangeStream] Error subscribing Bybit topics for #${this.symbol}:`, err);
          }

          // Bybit heartbeat ping every 20 seconds
          if (this.pingInterval) clearInterval(this.pingInterval);
          this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              try {
                this.ws.send(JSON.stringify({ op: 'ping' }));
              } catch {}
            }
          }, 20000);
        }

        // Binance keepalive ping every 30s to keep connection warm
        if (this.exchange === 'binance') {
          if (this.pingInterval) clearInterval(this.pingInterval);
          this.pingInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              try {
                this.ws.ping();
              } catch {}
            }
          }, 30000);
        }
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        if (this.isDestroyed) return;
        this.lastDataReceivedAt = Date.now();
        try {
          const str = data.toString();
          const json = JSON.parse(str);
          this.handleIncomingMessage(json);
        } catch (e) {
          // Ignore non-json frames
        }
      });

      this.ws.on('pong', () => {
        this.lastDataReceivedAt = Date.now();
      });

      this.ws.on('error', (err) => {
        this.isConnecting = false;
        if (this.isDestroyed) return;
        console.warn(`[ExchangeStream] Socket error for #${this.symbol} (${this.exchange}):`, err.message);
        this.setStatus('ERROR');
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        const reasonStr = reason ? reason.toString() : 'no reason specified';
        if (this.isDestroyed) {
          console.log(`[ExchangeStream] Clean close for #${this.symbol} on destroy (code: ${code})`);
          return;
        }
        console.warn(`[ExchangeStream] Socket closed for #${this.symbol} (${this.exchange}) [code: ${code}, reason: ${reasonStr}]. Reconnecting...`);
        this.setStatus('STALE');
        this.scheduleReconnect(`close_code_${code}`);
      });
    } catch (e: any) {
      this.isConnecting = false;
      console.error(`[ExchangeStream] Exception during connect for #${this.symbol}:`, e.message);
      this.setStatus('ERROR');
      this.scheduleReconnect('exception_on_connect');
    }
  }

  private handleIncomingMessage(msg: any) {
    if (this.exchange === 'binance') {
      this.handleBinanceMessage(msg);
    } else {
      this.handleBybitMessage(msg);
    }
  }

  /**
   * Correctly parses Binance multiplex/combined streams:
   * Format: { stream: string, data: any }
   * Also supports legacy raw stream payloads for backward compatibility.
   */
  private handleBinanceMessage(msg: any) {
    // Unpack combined stream envelope
    const streamName: string = msg.stream || '';
    const payload = msg.data !== undefined ? msg.data : msg;

    if (!payload || typeof payload !== 'object') return;

    const eventType = payload.e;

    // 1. Ticker Stream (24hrTicker)
    if (eventType === '24hrTicker' || streamName.includes('@ticker') || (payload.s && payload.c !== undefined)) {
      const price = parseFloat(payload.c);
      const high24h = parseFloat(payload.h || 0);
      const low24h = parseFloat(payload.l || 0);
      const volume24hUsd = parseFloat(payload.q || 0);
      if (!isNaN(price) && price > 0) {
        this.emit('price', {
          price,
          high24h,
          low24h,
          volume24hUsd,
          time: payload.E || Date.now(),
        });
      }
    }

    // 2. Trade Stream (trade or aggTrade)
    if (eventType === 'trade' || eventType === 'aggTrade' || streamName.includes('@aggTrade') || streamName.includes('@trade')) {
      const price = parseFloat(payload.p);
      const quantity = parseFloat(payload.q);
      const isBuyerMaker = Boolean(payload.m);
      // If buyer is maker, taker is seller -> aggressive SELL. If buyer is taker -> aggressive BUY.
      const side: 'BUY' | 'SELL' = isBuyerMaker ? 'SELL' : 'BUY';

      if (!isNaN(price) && price > 0 && !isNaN(quantity) && quantity > 0) {
        const tradeEvent: RawTradeEvent = {
          price,
          quantity,
          side,
          time: payload.T || payload.E || Date.now(),
          isBuyerMaker,
        };
        this.emit('trade', tradeEvent);
      }
    }

    // 3. Depth Stream (depth20 or order book update)
    if (payload.bids && payload.asks) {
      this.setStatus('LIVE');
      const bids: [number, number][] = payload.bids.map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]);
      const asks: [number, number][] = payload.asks.map((a: any) => [parseFloat(a[0]), parseFloat(a[1])]);
      this.emit('depth', {
        bids,
        asks,
        isSnapshot: true,
        sequence: payload.lastUpdateId || Date.now(),
      } as RawDepthDelta);
    }
  }

  /**
   * Bybit V5 Public WebSocket message handler
   */
  private handleBybitMessage(msg: any) {
    if (msg.op === 'pong' || msg.ret_msg === 'pong') {
      return;
    }

    const topic = msg.topic || '';

    // Tickers
    if (topic.startsWith('tickers.')) {
      const data = msg.data;
      if (data) {
        const lastPrice = parseFloat(data.lastPrice);
        const high24h = parseFloat(data.highPrice24h || 0);
        const low24h = parseFloat(data.lowPrice24h || 0);
        const volume24hUsd = parseFloat(data.turnover24h || 0);
        if (!isNaN(lastPrice) && lastPrice > 0) {
          this.emit('price', {
            price: lastPrice,
            high24h,
            low24h,
            volume24hUsd,
            time: msg.ts || Date.now(),
          });
        }
      }
    }

    // Public trades
    if (topic.startsWith('publicTrade.')) {
      const tradeList = Array.isArray(msg.data) ? msg.data : [msg.data];
      for (const t of tradeList) {
        if (!t) continue;
        const price = parseFloat(t.p);
        const quantity = parseFloat(t.v);
        const side: 'BUY' | 'SELL' = t.S?.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
        if (!isNaN(price) && price > 0 && !isNaN(quantity) && quantity > 0) {
          this.emit('trade', {
            price,
            quantity,
            side,
            time: t.T || msg.ts || Date.now(),
            isBuyerMaker: side === 'SELL',
          } as RawTradeEvent);
        }
      }
    }

    // Orderbook 50
    if (topic.startsWith('orderbook.')) {
      const type = msg.type; // 'snapshot' or 'delta'
      const data = msg.data;
      if (data && (data.b || data.a)) {
        this.setStatus('LIVE');
        const bids: [number, number][] = (data.b || []).map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]);
        const asks: [number, number][] = (data.a || []).map((a: any) => [parseFloat(a[0]), parseFloat(a[1])]);
        this.emit('depth', {
          bids,
          asks,
          isSnapshot: type === 'snapshot',
          sequence: msg.data?.seq || msg.data?.u || Date.now(),
        } as RawDepthDelta);
      }
    }
  }

  private startWatchdog() {
    this.watchdogTimer = setInterval(() => {
      if (this.isDestroyed) return;
      const now = Date.now();
      const elapsed = now - this.lastDataReceivedAt;

      // Watchdog: If no message for > 15 seconds, consider STALE and trigger reconnect
      if (this.status === 'LIVE' && elapsed > 15000) {
        this.setStatus('STALE');
        console.warn(`[ExchangeStream:Watchdog] No stream data for ${Math.round(elapsed / 1000)}s for #${this.symbol} (${this.exchange}) - triggering reconnect`);
        this.scheduleReconnect('watchdog_stale_data');
      }
    }, 5000);
  }

  private scheduleReconnect(reason = 'unknown') {
    if (this.isDestroyed || this.reconnectTimeout) return;
    const backoffIndex = Math.min(this.reconnectAttempts, this.backoffSchedule.length - 1);
    const delay = this.backoffSchedule[backoffIndex];
    this.reconnectAttempts++;

    console.log(`[ExchangeStream] Scheduling reconnect in ${delay}ms for #${this.symbol} (attempt: ${this.reconnectAttempts}, reason: ${reason})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }

  private cleanupSocket() {
    this.isConnecting = false;
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.terminate();
        }
      } catch (e) {}
      this.ws = null;
    }
  }

  public destroy() {
    this.isDestroyed = true;
    this.isConnecting = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.cleanupSocket();
    this.removeAllListeners();
    console.log(`[ExchangeStream] Destroyed stream client for #${this.symbol} (${this.exchange})`);
  }
}
