/**
 * PumpPortal WebSocket client
 * wss://pumpportal.fun/api/data
 *
 * Provides real-time pump.fun token and trade events.
 */

export interface PumpToken {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  image_uri?: string;
  marketCapSol?: number;
  usd_market_cap?: number;
  market_cap?: number;
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  initialBuy?: number;
  solAmount?: number;
  pool?: string;
  txType?: string;
  signature?: string;
  traderPublicKey?: string;
}

export interface PumpTrade {
  signature: string;
  mint: string;
  sol_amount: number;
  token_amount: number;
  is_buy: boolean;
  user: string;
  timestamp: number;
  username?: string;
  profile_image?: string;
  token_name?: string;
  token_symbol?: string;
  market_cap?: number;
  usd_market_cap?: number;
}

export type PumpPortalMessage = PumpToken | PumpTrade;

type MessageHandler = (msg: PumpPortalMessage) => void;

let socket: WebSocket | null = null;
let handlers = new Map<string, Set<MessageHandler>>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

function getSocket(): WebSocket {
  if (socket && socket.readyState === WebSocket.OPEN) return socket;

  socket = new WebSocket(PUMPPORTAL_WS);

  socket.onopen = () => {
    console.log('[PumpPortal] Connected');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Re-subscribe existing subscriptions
    handlers.forEach((_, method) => {
      socket!.send(JSON.stringify({ method }));
    });
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handlers.forEach((set) => {
        set.forEach((fn) => fn(data));
      });
    } catch {}
  };

  socket.onclose = () => {
    console.log('[PumpPortal] Disconnected — reconnecting in 3s');
    reconnectTimer = setTimeout(() => { socket = null; getSocket(); }, 3000);
  };

  socket.onerror = () => {
    socket?.close();
  };

  return socket;
}

export function subscribe(method: string, handler: MessageHandler): () => void {
  const ws = getSocket();

  if (!handlers.has(method)) handlers.set(method, new Set());
  handlers.get(method)!.add(handler);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method }));
  }

  return () => {
    handlers.get(method)?.delete(handler);
    if (handlers.get(method)?.size === 0) handlers.delete(method);
  };
}

export function subscribeNewToken(handler: MessageHandler): () => void {
  return subscribe('subscribeNewToken', handler);
}

export function subscribeTokenTrade(mint: string, handler: (trade: PumpTrade) => void): () => void {
  const ws = getSocket();

  const key = `subscribeTokenTrade:${mint}`;
  if (!handlers.has(key)) handlers.set(key, new Set());
  handlers.get(key)!.add(handler as MessageHandler);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
  } else {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }, { once: true });
  }

  return () => {
    handlers.get(key)?.delete(handler as MessageHandler);
    if (handlers.get(key)?.size === 0) handlers.delete(key);
  };
}

/** Token icon: resolve IPFS/Arweave URIs to HTTP URLs */
export function resolveImage(uri?: string): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('https://') || uri.startsWith('http://')) return uri;
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return uri;
}
