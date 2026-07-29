// FWA contract + node JSON-RPC helpers. Talks to /rpc (proxied to the local eth node).

import { keccak256 } from 'js-sha3';

export const FWA_ADDRESS = '0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c';
export const ETHERSCAN = 'https://etherscan.io';

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const SEL_ENS_RESOLVER = '0x0178b8bf'; // resolver(bytes32)
const SEL_ENS_NAME = '0x691f3431'; // name(bytes32)

// RPC endpoint resolution, so a static hosted build works out of the box:
//   1. ?rpc=<url> query param (persisted to localStorage)
//   2. previously saved localStorage override
//   3. on fwaah.com: /api/rpc — the edge-cached Vercel proxy (shared cache
//      across ALL visitors; upstream key stays server-side)
//   4. REACT_APP_RPC_URL baked in at build time (forks: your node/Alchemy URL)
//   5. /rpc — the dev-server proxy to the local node
function resolveRpcUrl() {
  try {
    const q = new URLSearchParams(window.location.search).get('rpc');
    if (q) {
      localStorage.setItem('fwaah_rpc', q);
      return q;
    }
    const saved = localStorage.getItem('fwaah_rpc');
    if (saved) return saved;
    if (/(^|\.)fwaah\.com$/i.test(window.location.hostname)) return '/api/rpc';
  } catch (_) { /* no window/localStorage (tests) */ }
  if (process.env.REACT_APP_RPC_URL) return process.env.REACT_APP_RPC_URL;
  return '/rpc';
}

export const RPC_URL = resolveRpcUrl();

// Hosted mode: the shared site (fwaah.com, or any remote https RPC like a
// baked-in Alchemy URL) must be gentle on its endpoint, so polls slow down and
// reads get a short-TTL cache. A fork pointed at a local/LAN node stays in
// "at home" mode and hammers away with zero caching. ?hosted=1 forces it.
function detectHosted() {
  try {
    if (new URLSearchParams(window.location.search).get('hosted')) return true;
    if (/(^|\.)fwaah\.com$/i.test(window.location.hostname)) return true;
  } catch (_) { /* no window (tests) */ }
  if (RPC_URL.startsWith('/api/')) return true; // edge-cached shared proxy
  return /^https:\/\//i.test(RPC_URL) && !/localhost|127\.0\.0\.1|192\.168\.|10\.|\.local/i.test(RPC_URL);
}

export const HOSTED = detectHosted();

// Human label for the active RPC — never exposes a LAN IP or an API key path.
export const RPC_LABEL = (() => {
  if (RPC_URL.startsWith('/api/')) return 'shared RPC · edge cached';
  if (RPC_URL === '/rpc') return 'local node';
  try {
    return new URL(RPC_URL, 'http://x').hostname || 'custom RPC';
  } catch (_) {
    return 'custom RPC';
  }
})();

// poll cadence per surface, ms
export const POLL = HOSTED
  ? { node: 12000, ticker: 24000, stats: 60000, logs: 300000, highValue: 300000, account: 30000 }
  : { node: 2000, ticker: 6000, stats: 12000, logs: 60000, highValue: 60000, account: 12000 };

// short-TTL per-call cache, active only in hosted mode
const rpcCache = new Map(); // key -> { expires, result }

function cacheTtl(method) {
  if (!HOSTED) return 0;
  switch (method) {
    case 'eth_getLogs': return 60000;
    case 'eth_call':
    case 'eth_getBalance':
    case 'net_peerCount':
    case 'eth_syncing': return 12000;
    case 'eth_blockNumber':
    case 'eth_getBlockByNumber': return 6000;
    default: return 0; // receipts etc. — never cache
  }
}

function pruneRpcCache() {
  if (rpcCache.size < 500) return;
  const now = Date.now();
  rpcCache.forEach((v, k) => { if (v.expires <= now) rpcCache.delete(k); });
}

// keccak-256 selectors for the FWA view functions we poll
export const SELECTORS = {
  activeListingCount: '0x4681a7c6',
  acquisitionFee: '0x38f5f005',
  totalWeight: '0x96c82e57',
  weightedBackingTotal: '0xd6eb0dbd',
  pendingAcquisitionCount: '0x34b1670f',
  unsettledAcquisitionCount: '0x3d21f274',
  unfulfilledVrfCount: '0xa66e8ae2',
  lastIssuedSequence: '0xc367b0d2',
  nextSequenceToProcess: '0xc4c873e6',
  topListingId: '0xee35bc33',
  topListingPot: '0xba20687b',
  accruedOwnerFees: '0x7b9aa10f',
  acquisitionEscrowTotal: '0x59d973db',
  acquisitionRefundCreditTotal: '0xb5091d48',
  nextListingId: '0xaaccf1ec',
  treeRootWeight: '0x1b9bc525',
  listings: '0xde74e57b',
  tokenURI: '0xc87b56dd', // tokenURI(uint256) — on NFT collections, not on FWA
  // pull-panel reads
  quoteAcquisitionPrice: '0x987df4cd',
  settlementDiscountBps: '0xfb2dd096',
  settlementWindow: '0xb4a7bdf9',
  acquisitions: '0x41111a4a', // acquisitions(uint256)
  acquisitionRefundCredit: '0x39ea5e12', // acquisitionRefundCredit(address)
  // writes (sent through the user's wallet, never by this app)
  acquire: '0x548b0de9', // acquire(uint256,uint256)
  keepNFT: '0x49cfb710',
  acceptDepositorBid: '0x35390e96',
  acceptBidAsTokens: '0x20bd63ba', // acceptBidAsTokens(uint256,uint256)
  withdrawAcquisitionRefund: '0x6e658d1a',
};

// event topic0 hashes
export const TOPICS = {
  AcquisitionRequested: '0xf23e34f4aa4a06ecddd309d9692e7b7ca45b76fd0d5f4ce4f7fbf29731d9abd6', // event topic hash (public) — gitleaks:allow
  NFTAllocated: '0xaf0d8c007926747ede4270a56f69d2e872c3f0d7e1ef7bbc643b3185c50f6758', // event topic hash (public) — gitleaks:allow
  NFTKept: '0xe71c2721f75bef3206b21176a6d26685852a16878249fc84d18f443f959bb8f5', // event topic hash (public) — gitleaks:allow
  NFTRelisted: '0x5fa40266a1e401404f322db009d5f8631ed44abc96b84784d9f8f90a8846abd8', // event topic hash (public) — gitleaks:allow
  DepositorBidAccepted: '0x88ebc94b0ff4693b3d25995dc7c5c4e5683a8ca7de00836773ca24c8b69d78e3', // event topic hash (public) — gitleaks:allow
  DepositorBidAcceptedAsTokens: '0x819cd055ab6ba83877ab68882609b8d7aa75d4951f6d89fa99d3b59fa45f439f', // keccak of the event sig, not a key — gitleaks:allow
  AcquisitionExpired: '0x97639294216e9dc091da2646074b483c81c79f6b6143e69b244331ecded15b12', // event topic hash (public) — gitleaks:allow
  AcquisitionRefundedNoListing: '0x4906638bdfd382f0f3258500c1e972e71b9b3cd95ceacd95ca188d493c8e0ee8', // event topic hash (public) — gitleaks:allow
  AcquisitionRefundedSlippage: '0x6e0c967dcdde10dc8a73e11f39aac35df75b9647cd6db11c0918a0d49e98f22a', // event topic hash (public) — gitleaks:allow
  NFTListed: '0x01c953cf171a8c32b553c5b7e0964bae6b2123db065615e54e8425fec3ec16cd', // event topic hash (public) — gitleaks:allow
  ListingStaged: '0x8684098dea97bebc638de0445aee7a3cd3929bb89af1add56703b5b721273b4f', // event topic hash (public) — gitleaks:allow
  ListingWithdrawn: '0x155ad598d62a05a119f984c463f10d75b4fe9b0af1e0fbe0c2b2caaf8e4bdfda', // event topic hash (public) — gitleaks:allow
  BackingUpdated: '0x5c4c79e86213f723a47892346939f61e044f21669b282f71b022098eea2d136b', // event topic hash (public) — gitleaks:allow
  UnsettledFinalized: '0x6f4528c508dc00c3d0fb4dcffe0346f48ae4332f18abe3d4eff0b27895997929', // event topic hash (public) — gitleaks:allow
  TopListingSet: '0x24ace256adc6182b122f3aa90b19d20b6d637236a63154d9a6ceb9032b50b514', // event topic hash (public) — gitleaks:allow
  TopListingSettled: '0x72747a194a7ea234ca6c67bae23a563ff193d2efe4611bec783df82b40c47892', // event topic hash (public) — gitleaks:allow
  FeesPaidOut: '0xcbe199cf5a1eb4e2f03e17cb7d09cad0b775715e745ccfe1e3fef26671433657', // event topic hash (public) — gitleaks:allow
};

// URL-safe base64 for GET-cacheable requests (matches Node's 'base64url').
function base64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Shared executor: serves hosted-mode cache hits, fetches only the misses.
// safe=true maps per-call errors to null instead of throwing the whole batch.
async function rpcExec(calls, safe) {
  const now = Date.now();
  const results = new Array(calls.length);
  const misses = []; // [resultIndex, call, cacheKey]

  calls.forEach((call, i) => {
    const key = cacheTtl(call[0]) ? call[0] + JSON.stringify(call[1]) : null;
    if (key) {
      const hit = rpcCache.get(key);
      if (hit && hit.expires > now) {
        results[i] = hit.result;
        return;
      }
    }
    misses.push([i, call, key]);
  });

  if (misses.length) {
    // Deterministic per-batch ids: every visitor running this same code
    // produces a byte-identical request, so the edge proxy's GET URLs collide
    // on purpose and all visitors share one cached upstream response.
    const body = misses.map(([, call], j) => ({
      jsonrpc: '2.0',
      id: j + 1,
      method: call[0],
      params: call[1],
    }));
    const payload = JSON.stringify(body);

    let res;
    const cacheable = misses.every(([, call]) => cacheTtl(call[0]) > 0);
    if (RPC_URL.startsWith('/api/') && cacheable) {
      const q = base64url(payload);
      if (q.length < 7000) {
        res = await fetch(RPC_URL + '?q=' + q);
      }
    }
    if (!res) {
      res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    }
    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
    const json = await res.json();
    const byId = {};
    (Array.isArray(json) ? json : [json]).forEach((r) => { byId[r.id] = r; });

    misses.forEach(([i, call, key], j) => {
      const r = byId[j + 1];
      if (!r || r.error) {
        if (safe) {
          results[i] = null;
          return;
        }
        throw new Error((r && r.error && r.error.message) || 'RPC error');
      }
      results[i] = r.result;
      const ttl = cacheTtl(call[0]);
      if (key && ttl) rpcCache.set(key, { expires: Date.now() + ttl, result: r.result });
    });
    pruneRpcCache();
  }

  return results;
}

export function rpcBatch(calls) {
  return rpcExec(calls, false);
}

// selector + uint256/address words -> calldata hex. Addresses may be passed as
// 0x-strings; everything else as BigInt/number.
export function encodeData(selector, argWords = []) {
  return selector + argWords.map((w) => {
    const v = typeof w === 'string' ? BigInt(w) : BigInt(w);
    return v.toString(16).padStart(64, '0');
  }).join('');
}

export function ethCall(selector, argWords = [], overrides = {}) {
  return ['eth_call', [{ to: FWA_ADDRESS, data: encodeData(selector, argWords), ...overrides }, 'latest']];
}

export function ethCallTo(to, selector, argWords = []) {
  return ['eth_call', [{ to, data: encodeData(selector, argWords) }, 'latest']];
}

export const addrTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

// Like rpcBatch but per-call errors come back as null instead of throwing the
// whole batch — for best-effort lookups against arbitrary NFT contracts.
export function rpcBatchSafe(calls) {
  return rpcExec(calls, true);
}

// Decode a single ABI-encoded string return value.
export function decodeString(hex) {
  try {
    if (!hex || hex === '0x') return null;
    const offset = Number(word(hex, 0));
    const lenPos = 2 + offset * 2;
    const len = Number(BigInt('0x' + hex.slice(lenPos, lenPos + 64)));
    const bytes = hex.slice(lenPos + 64, lenPos + 64 + len * 2);
    let out = '';
    for (let i = 0; i < bytes.length; i += 2) {
      out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    }
    // handle UTF-8 published as raw bytes
    try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
  } catch (_) {
    return null;
  }
}

const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export function resolveTokenUrl(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAY + uri.slice(7).replace(/^ipfs\//, '');
  if (uri.startsWith('data:') || uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  return null;
}

/* === ENS reverse resolution (batched + cached, via the local node) === */

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// namehash("<addr-no-0x>.addr.reverse")
function reverseNode(address) {
  let node = '0'.repeat(64);
  ['reverse', 'addr', address.slice(2).toLowerCase()].forEach((label) => {
    node = keccak256(hexToBytes(node + keccak256(label)));
  });
  return node;
}

const ensCache = new Map(); // lowercase addr -> name | null
let ensPending = new Map(); // lowercase addr -> [resolve, ...]
let ensTimer = null;

export function ensName(address) {
  if (!address) return Promise.resolve(null);
  const a = address.toLowerCase();
  if (ensCache.has(a)) return Promise.resolve(ensCache.get(a));
  return new Promise((resolve) => {
    if (!ensPending.has(a)) ensPending.set(a, []);
    ensPending.get(a).push(resolve);
    if (!ensTimer) ensTimer = setTimeout(flushEnsQueue, 50);
  });
}

async function flushEnsQueue() {
  ensTimer = null;
  const batch = ensPending;
  ensPending = new Map();
  const addrs = [...batch.keys()];
  const names = new Array(addrs.length).fill(null);
  try {
    const nodes = addrs.map((a) => BigInt('0x' + reverseNode(a)));
    const resolvers = await rpcBatchSafe(
      nodes.map((n) => ethCallTo(ENS_REGISTRY, SEL_ENS_RESOLVER, [n]))
    );
    const withResolver = [];
    resolvers.forEach((r, i) => {
      if (r && r !== '0x' && BigInt(r) !== 0n) withResolver.push([i, wordAddr(r, 0)]);
    });
    if (withResolver.length) {
      const nameRes = await rpcBatchSafe(
        withResolver.map(([i, resolver]) => ethCallTo(resolver, SEL_ENS_NAME, [nodes[i]]))
      );
      withResolver.forEach(([i], j) => {
        const n = decodeString(nameRes[j]);
        if (n) names[i] = n;
      });
    }
  } catch (_) { /* leave nulls — addresses render as hex */ }
  addrs.forEach((a, i) => {
    ensCache.set(a, names[i]);
    batch.get(a).forEach((resolve) => resolve(names[i]));
  });
}

// Best-effort: tokenURI string -> image URL from the metadata JSON.
export async function fetchTokenImage(uri) {
  const url = resolveTokenUrl(uri);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const meta = await res.json();
    const img = meta.image || meta.image_url || meta.imageUrl || (meta.properties && meta.properties.image) || null;
    return resolveTokenUrl(typeof img === 'string' ? img : null);
  } catch (_) {
    return null;
  }
}

/* === listing art: listingId -> { img, collection, tokenId }, cached === */

const listingArtCache = {}; // listingId -> { img, collection, tokenId }

export async function fetchListingArt(listingIds) {
  const out = {};
  const missing = [];
  [...new Set(listingIds)].forEach((id) => {
    if (listingArtCache[id]) out[id] = listingArtCache[id];
    else missing.push(id);
  });
  if (missing.length === 0) return out;

  const listingRes = await rpcBatchSafe(
    missing.map((id) => ethCall(SELECTORS.listings, [BigInt(id)]))
  );
  const withToken = [];
  missing.forEach((id, i) => {
    const raw = listingRes[i];
    if (raw && raw !== '0x') withToken.push({ id, collection: wordAddr(raw, 0), tokenId: word(raw, 3) });
  });
  if (withToken.length === 0) return out;

  const uriRes = await rpcBatchSafe(
    withToken.map((w) => ethCallTo(w.collection, SELECTORS.tokenURI, [w.tokenId]))
  );
  await Promise.all(withToken.map(async (w, i) => {
    const img = await fetchTokenImage(decodeString(uriRes[i]));
    const entry = { img, collection: w.collection, tokenId: w.tokenId.toString() };
    listingArtCache[w.id] = entry;
    out[w.id] = entry;
  }));
  return out;
}

export const toBig = (hex) => (hex && hex !== '0x' ? BigInt(hex) : 0n);
export const toNum = (hex) => Number(toBig(hex));

// pull the i-th 32-byte word out of returned calldata as a BigInt
export function word(hex, i) {
  return BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
}

export function wordAddr(hex, i) {
  return '0x' + hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64);
}

export const topicAddr = (t) => '0x' + t.slice(26);
export const topicNum = (t) => Number(BigInt(t));

const ETH = 10n ** 18n;

export function fmtEth(wei, digits = 4) {
  if (typeof wei === 'string') wei = toBig(wei);
  const negative = wei < 0n;
  if (negative) wei = -wei;
  const scale = 10n ** BigInt(digits);
  const scaled = (wei * scale + ETH / 2n) / ETH; // rounded
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
}

export const fmtNum = (n) => Number(n).toLocaleString('en-US');
export const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');
export const shortHash = (h) => (h ? h.slice(0, 10) + '…' : '—');

export function fmtAge(seconds) {
  if (seconds < 0) seconds = 0;
  if (seconds < 90) return Math.round(seconds) + 's';
  if (seconds < 5400) return Math.round(seconds / 60) + 'm';
  if (seconds < 172800) return (seconds / 3600).toFixed(1) + 'h';
  return (seconds / 86400).toFixed(1) + 'd';
}

// Decode one FWA log into { name, badge, parts } for the activity feed.
// `parts` is a list of plain strings and { addr } segments so the renderer can
// swap addresses for the <FwaAddress/> component.
export function describeLog(log) {
  const t = log.topics;
  const d = log.data;
  const dataWord = (i) => word(d, i);
  const A = (addr) => ({ addr });
  switch (t[0]) {
    case TOPICS.AcquisitionRequested:
      return { name: 'Acquisition', badge: 'info', parts: [A(topicAddr(t[2])), ' paid ' + fmtEth(dataWord(0)) + ' ETH'] };
    case TOPICS.NFTAllocated:
      return { name: 'Allocated', badge: 'primary', parts: ['listing #' + topicNum(t[2]) + ' → ', A(topicAddr(t[3])), ' (backing ' + fmtEth(dataWord(1)) + ' ETH)'] };
    case TOPICS.NFTKept:
      return { name: 'NFT kept', badge: 'success', parts: ['listing #' + topicNum(t[1]) + ' kept by ', A(topicAddr(t[2]))] };
    case TOPICS.NFTRelisted:
      return { name: 'Relisted', badge: 'success', parts: ['listing #' + topicNum(t[1]) + ' → new #' + topicNum(t[2])] };
    case TOPICS.DepositorBidAccepted:
      return { name: 'Bid accepted', badge: 'warning', parts: [A(topicAddr(t[2])), ' took ' + fmtEth(dataWord(0)) + ' ETH for listing #' + topicNum(t[1])] };
    case TOPICS.DepositorBidAcceptedAsTokens:
      return { name: 'Bid → FWA', badge: 'warning', parts: [A(topicAddr(t[2])), ' took ' + fmtEth(dataWord(0)) + ' ETH as tokens, listing #' + topicNum(t[1])] };
    case TOPICS.AcquisitionExpired:
      return { name: 'Expired', badge: 'danger', parts: ['seq ' + topicNum(t[2]) + ', ' + fmtEth(dataWord(0)) + ' ETH refunded'] };
    case TOPICS.AcquisitionRefundedNoListing:
      return { name: 'Refund (empty)', badge: 'danger', parts: [fmtEth(dataWord(0)) + ' ETH → ', A(topicAddr(t[2]))] };
    case TOPICS.AcquisitionRefundedSlippage:
      return { name: 'Refund (slip)', badge: 'danger', parts: [fmtEth(dataWord(0)) + ' ETH → ', A(topicAddr(t[2]))] };
    case TOPICS.NFTListed:
      return { name: 'Listed', badge: 'success', parts: ['#' + topicNum(t[1]) + ' by ', A(topicAddr(t[3])), ', backing ' + fmtEth(dataWord(3)) + ' ETH'] };
    case TOPICS.ListingStaged:
      return { name: 'Staged', badge: 'secondary', parts: ['#' + topicNum(t[1]) + ' by ', A(topicAddr(t[2])), ', backing ' + fmtEth(dataWord(2)) + ' ETH'] };
    case TOPICS.ListingWithdrawn:
      return { name: 'Withdrawn', badge: 'secondary', parts: ['#' + topicNum(t[1]) + ' by ', A(topicAddr(t[2])), ', ' + fmtEth(dataWord(0)) + ' ETH'] };
    case TOPICS.BackingUpdated:
      return { name: 'Repriced', badge: 'secondary', parts: ['#' + topicNum(t[1]) + ': ' + fmtEth(dataWord(0)) + ' → ' + fmtEth(dataWord(1)) + ' ETH'] };
    case TOPICS.UnsettledFinalized:
      return { name: 'Finalized', badge: 'secondary', parts: ['listing #' + topicNum(t[1]) + ' defaulted'] };
    case TOPICS.TopListingSet:
      return { name: 'Top listing', badge: 'primary', parts: [topicNum(t[1]) === 0 ? 'top vacated' : '#' + topicNum(t[1]) + ' took the top'] };
    case TOPICS.TopListingSettled:
      return { name: 'Top pot paid', badge: 'primary', parts: [fmtEth(dataWord(0)) + ' ETH → ', A(topicAddr(t[2]))] };
    case TOPICS.FeesPaidOut:
      return { name: 'Fees paid', badge: 'secondary', parts: [fmtEth(dataWord(0)) + ' ETH → ', A(topicAddr(t[1]))] };
    default:
      return { name: 'Event', badge: 'secondary', parts: [shortHash(t[0])] };
  }
}
