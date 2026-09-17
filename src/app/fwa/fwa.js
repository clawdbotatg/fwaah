// FWA contract + node JSON-RPC helpers. Talks to /rpc (proxied to the local eth node).

import { keccak256 } from 'js-sha3';
import POOL_SNAPSHOTS from './pools.json';

export const ETHERSCAN = 'https://etherscan.io';

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const SEL_ENS_RESOLVER = '0x0178b8bf'; // resolver(bytes32)
const SEL_ENS_NAME = '0x691f3431'; // name(bytes32)

/* === the two live main pools ===========================================
   FWA V2 (purchases live 2026-09-16 16:00 UTC) is a SEPARATE deployment,
   not an upgrade: V1 keeps running with its own listings, fees and rewards,
   and the official site lets you migrate by withdrawing from one and
   depositing into the other. Both share the FWA token + its Uniswap v4 hook.
   This app drives ONE pool per page load, chosen at boot (below); everything
   pool-specific hangs off POOL so the rest of the code reads one config. */

// static per-pool facts (addresses from https://www.fwa.fun/docs/v2-deployments
// and /docs/deployments); the on-chain snapshot (knobs, whitelist, oracle
// exemptions) lives in pools.json — regenerate with `node scripts/snapshot.mjs`
const POOL_STATIC = {
  v2: {
    id: 'v2',
    label: 'V2',
    title: 'FWA V2 main pool',
    site: 'https://www.fwa.fun',
    docs: 'https://www.fwa.fun/docs/v2',
    // everything wired around the pool — the pool's own getters (token,
    // rewards, floorOracle, fwairLaunchRegistry) are read live; these are the
    // immutable/constructor ones with no getter, per the official deployments page
    contracts: {
      vrfService: '0xCACBd874e24B533935176154E990Bf710F56693A',
      buyback: '0xaba91665cdf921F0f6B33A099337336B324c9793',
      purchaseNotifier: '0x612dF3a344990F8E53499ec1bC79Be63cFa496D0',
      whitelistAuthority: '0x0ad3128429242007D58952c65546BA99b9b70146',
      fwairLaunchManager: '0x716486a7bD6B4d7409fC4F8B52f0B23D2BcFac72',
      punkLister: '0xb924048A35160B077A85954A049d5CAc29F23ad1',
      feeSplitter: '0x1b83eb5d2377150d561c05f0475fccd78c12645b', // OwnerSplitterV2 — routes hook trading fees, 20% to the punk lister
      tokenHook: '0x2C67ebA8A50AF0dB5Fba55F725247a75CbDA6444', // public contract address — gitleaks:allow
    },
  },
  v1: {
    id: 'v1',
    label: 'V1',
    title: 'FWA V1 main pool (legacy, still live)',
    site: 'https://v1.fwa.fun',
    docs: 'https://www.fwa.fun/docs/v1',
    contracts: {
      vrfService: '0xa084c33Fb7a467307452898b8D58165ebd2E5D9f',
      whitelistAuthority: '0x54B641aC97A9e9375665934b8e7a7D0b2C0E898B',
      fwairLaunchManager: '0x900252d9A8F9AcC3DD1014C594c91fC33e5A6AAf',
      tokenHook: '0x2C67ebA8A50AF0dB5Fba55F725247a75CbDA6444', // public contract address — gitleaks:allow
    },
  },
};

const big = (s) => BigInt(s);
function buildPool(id) {
  const snap = POOL_SNAPSHOTS[id];
  const k = snap.knobs;
  return {
    ...POOL_STATIC[id],
    address: snap.address,
    deployBlock: snap.deployBlock,
    snapshotBlock: POOL_SNAPSHOTS.snapshotBlock,
    // knobs with NO public getter — the latest ConfigSet(key, value) per key,
    // baked at snapshotBlock; the admin-event overlay keeps them current
    knobs: {
      minBacking: big(k.minBacking),
      pullSurchargeBps: big(k.pullSurchargeBps),
      maxPullsPerTx: big(k.maxPullsPerTx),
      protocolFeeToTokenBps: big(k.protocolFeeToTokenBps),
      pullsEnabled: k.pullsEnabled,
      withdrawOnly: k.withdrawOnly,
      whitelistEnabled: k.whitelistEnabled,
      sellBackAsTokens: k.sellBackAsTokens,
      whitelistManager: k.whitelistManager,
    },
    whitelist: snap.whitelist,
    oracleExempt: snap.oracleExempt,
  };
}
export const POOLS = { v2: buildPool('v2'), v1: buildPool('v1') };

// Which pool this page load drives: V2 unless the URL says ?pool=v1. It is
// deliberately NOT remembered (unlike ?rpc=): a bare fwaah.com must always be
// the current pool, and V1 stays an explicit opt-in you can bookmark.
// Switching pools reloads the page (poolUrl), so no component ever has to
// handle a live address change.
function resolvePoolId() {
  try {
    const q = (new URLSearchParams(window.location.search).get('pool') || '').toLowerCase();
    if (POOLS[q]) return q;
  } catch (_) { /* no window (tests, api) */ }
  return 'v2';
}
export const POOL_ID = resolvePoolId();
export const POOL = POOLS[POOL_ID];
export const IS_V2 = POOL_ID === 'v2';
export const OTHER_POOL = POOLS[IS_V2 ? 'v1' : 'v2'];
export const FWA_ADDRESS = POOL.address;
export const DEPLOY_BLOCK = POOL.deployBlock;
export const KNOB_SNAPSHOT = POOL.knobs;
export const WHITELIST_SNAPSHOT = POOL.whitelist;
export const ORACLE_EXEMPT_SNAPSHOT = POOL.oracleExempt;

// same page, other pool — keeps ?rpc= and friends; V2 is the bare URL
export function poolUrl(id) {
  try {
    const u = new URL(window.location.href);
    if (id === 'v2') u.searchParams.delete('pool'); else u.searchParams.set('pool', id);
    return u.pathname + u.search + u.hash;
  } catch (_) {
    return id === 'v2' ? '/' : '/?pool=' + id;
  }
}

/* === V2 purchase blackout (fixed in the contract, not a knob) ===
   New purchases are refused daily 11:45–12:00 and 23:45–00:00 UTC
   (`block.timestamp % 12h >= 11h45m`). Callbacks, settlement and exits keep
   working; over-ceiling listings can be kicked ONLY inside these windows. */
export const BLACKOUT_PERIOD_S = 12 * 3600;
export const BLACKOUT_START_S = 11 * 3600 + 45 * 60;
export function blackoutState(nowS = Date.now() / 1000) {
  if (!IS_V2) return { active: false, secondsToChange: Infinity };
  const t = Math.floor(nowS) % BLACKOUT_PERIOD_S;
  const active = t >= BLACKOUT_START_S;
  return { active, secondsToChange: active ? BLACKOUT_PERIOD_S - t : BLACKOUT_START_S - t };
}

// V2 crown commitment (FWAV2CrownPolicy — fixed): leaving or shrinking the
// crown within 12h of taking it costs 1% of the full backing
export const CROWN_COMMITMENT_S = 12 * 3600;
export const CROWN_EARLY_EXIT_BPS = 100n;

// V2 oracle ceiling: backing ≤ oracle ask × (1 + premium)
export const oracleCeiling = (ask, premiumBps) => ask * (10000n + premiumBps) / 10000n;

/* === token-level facts shared by both pools === */
export const FWA_TOKEN = '0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845';
export const PUNKS_721 = '0x000000000000003607fce1ac9e043a86675c5c2f'; // CryptoPunks 721 wrapper — the punk collection both pools list
export const INITIAL_FWA_SUPPLY = 10n ** 27n; // 1,000,000,000 FWA minted at deploy (two 500M mints, block 25546793); burns only shrink it
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // ERC-20/721 Transfer — public event hash — gitleaks:allow
export const ZERO_TOPIC = '0x' + '0'.repeat(64);
// the Punk lister (V2 only): a protocol strategy funded by 20% of FWA trading
// fees (via OwnerSplitterV2) + its own listing earnings + owner top-ups; it
// buys punks (purchaseAndList, gated by publicMarketPurchasesEnabled) or takes
// admin-deposited ones, lists them in the pool, and decays their backing on a
// schedule (configuration()). Events are the record of what it bought/listed.
export const PUNK_LISTER = IS_V2 ? POOL.contracts.punkLister : null;
export const LISTER_SELECTORS = {
  lockedCapital: '0x2f86e2b0', unlockedCapital: '0x7e18d27b', spendableCapital: '0xde4a097d', trackedCapital: '0x974031d6',
  purchaseCapacity: '0xb592e0c6', publicMarketPurchasesEnabled: '0xc0abf507', nextPositionId: '0x899346c7',
  paused: '0x5c975abb', configuration: '0x6c70bee9', // -> (decayInterval s, decayAmount wei, minimumBacking wei, capitalUnlockPerBlock wei)
};
export const LISTER_TOPICS = { // keccak event-signature hashes, public — gitleaks:allow
  PunkPurchased: '0xc95fbbb2b2b5d79d5eea30ca1c563dd8af4018a13a189d987dedfdf8ff61383b', // (idx positionId, idx punkId, idx seller, price) — gitleaks:allow
  WrappedPunkDeposited: '0x91200a452433bfcba10e482a32f3c6b80ff4344520058fde60d4021a43d70a25', // (idx positionId, idx punkId, idx contributor, listingId, backing) — gitleaks:allow
  PositionListed: '0xa4e908016dd25c77bb716cc01f2731681013a7f1266f6646a006fb96296cc73b', // (idx positionId, idx punkId, idx listingId, backing) — gitleaks:allow
  PositionExited: '0xc80edd82547f4dcac7cba54a3338657b4d10f55e0f44a36a4b8d1c182d301005', // (idx positionId, idx punkId, idx listingId) — gitleaks:allow
  CapitalLocked: '0x0ab1e73b4fbe24bd81c00f49859ce55f65648be9bafb94195658077da0978016', // (idx source, amount, lockedCapital) — gitleaks:allow
  BackingReduced: '0x678d6eded3ce3adfb0c49ab8a81fcc15a1ae8a2e0e22f93d4d9c78f93d66b685', // (idx positionId, idx listingId, oldBacking, newBacking) — gitleaks:allow
};

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

// Human label for the active RPC — hosted surfaces never expose a LAN IP or an
// API key path. At home, the dev server's /rpc-target endpoint resolves the
// proxy's real host async; subscribe with onRpcLabel to catch the update.
export let RPC_LABEL = (() => {
  if (RPC_URL.startsWith('/api/')) return 'shared RPC · edge cached';
  if (RPC_URL === '/rpc') return 'local node';
  try {
    return new URL(RPC_URL, 'http://x').hostname || 'custom RPC';
  } catch (_) {
    return 'custom RPC';
  }
})();

const rpcLabelSubs = new Set();
export function onRpcLabel(fn) {
  rpcLabelSubs.add(fn);
  return () => rpcLabelSubs.delete(fn);
}

if (RPC_URL === '/rpc') {
  fetch('/rpc-target')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j && j.host) {
        RPC_LABEL = 'local node · ' + j.host;
        rpcLabelSubs.forEach((fn) => fn(RPC_LABEL));
      }
    })
    .catch(() => { /* keep the generic label */ });
}

// poll cadence per surface, ms
export const POLL = HOSTED
  ? { node: 12000, ticker: 24000, stats: 60000, logs: 300000, highValue: 300000, account: 30000 }
  : { node: 2000, ticker: 6000, stats: 12000, logs: 60000, highValue: 60000, account: 12000 };

// short-TTL per-call cache, active only in hosted mode
const rpcCache = new Map(); // key -> { expires, result }

function cacheTtl(method) {
  if (!HOSTED) return 0;
  switch (method) {
    case 'eth_getCode': return 3600000; // EOA-vs-contract checks — code barely changes
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

// keccak-256 selectors for the FWA view functions we poll. Shared by V1 and
// V2 unless tagged — the V2 core kept V1's getter ABI for indexers and only
// changed `acquire` (see acquireV2) among the writes this app sends.
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
  topListingSince: '0x9360191e', // V2 — crown tenure start (uint64), drives the 12h commitment
  accruedOwnerFees: '0x7b9aa10f',
  acquisitionEscrowTotal: '0x59d973db',
  acquisitionRefundCreditTotal: '0xb5091d48',
  nextListingId: '0xaaccf1ec',
  treeRootWeight: '0x1b9bc525', // V1 only
  listings: '0xde74e57b',
  tokenURI: '0xc87b56dd', // tokenURI(uint256) — on NFT collections, not on FWA
  name: '0x06fdde03', // name() — on NFT collections, not on FWA
  // rules-of-the-game reads (owner-tunable knobs with public getters)
  finalizeWindow: '0x8600e5cb',
  ownerAcquisitionFeeBps: '0x2b0b9641',
  ownerSettlementFeeBps: '0x4a088a42',
  topListingShareBps: '0x823e645a',
  topThresholdBps: '0x6a6e8c70',
  retainedToProtocol: '0x5b69ae6a',
  selectionSlippageBps: '0x40ef7ee1',
  selectionTimeoutBlocks: '0xdf881bd1',
  owner: '0x8da5cb5b',
  payoutAddress: '0x5b8d02d7',
  collectionWhitelisted: '0x666cd313', // collectionWhitelisted(address)
  token: '0xfc0c546a',
  rewards: '0x9ec5a894',
  vrfService: '0x59749e94', // V1 only — V2 exposes vrfServiceFee()/vrfCoordinatorAndSubId() instead
  // V2 core: oracle ceiling, blackout, cashout rates, exemptions
  tokenSettlementDiscountBps: '0x97d69193', // FWA cashout budget (bps of backing)
  isPurchaseBlackout: '0x4d5fe14c',
  floorOracle: '0x29dd24c7',
  oracleCeilingPremiumBps: '0xedfd4c45',
  maxOracleAge: '0x7c87a993',
  minOracleChallengePeriod: '0xf2565bde',
  oracleExemptCollections: '0xcd9ba024', // oracleExemptCollections(address)
  canDeposit: '0x4bf0d331', // canDeposit(address) — whitelist decision only
  fwairListing: '0x9f13336c', // fwairListing(uint256)
  fwairLaunchRegistry: '0x4146858d',
  settlementFeeBpsForListing: '0x28899231',
  vrfServiceFee: '0xff48b8ae',
  stuckNFTRecipient: '0xf7375a7f', // stuckNFTRecipient(uint256)
  // FWARewards (V1) views — call with ethCallTo(rewardsAddr, …)
  emissionStart: '0x513da948',
  emissionDuration: '0x2d9c4dd2', // EMISSION_DURATION()
  depositorRatePerSec: '0xd2b48fff',
  purchaserDailyPot: '0xfb894e65',
  totalSupply: '0x18160ddd', // on the FWA token
  isBuying: '0x24f0aa72', // rewards — raised only inside the module's own FWA buy
  tokenBuyAllowanceTotal: '0xb74d90cd', // rewards — ETH queued for FWA buys (pullers' allowance + builders)
  // FWAV2Rewards views — no fixed emission: FWA arrives from buybacks and is
  // split by √backing (depositors) and per-epoch shares (pullers)
  epochStart: '0x15e5a1e5',
  currentEpoch: '0x76671808',
  purchaserEpochPot: '0x641a875d', // purchaserEpochPot(uint256 epoch)
  acquisitionsInEpoch: '0x68a9b6ff', // acquisitionsInEpoch(uint256 epoch)
  pendingAcquisitionsInEpoch: '0xa3cc7a8c',
  userAcquisitionsInEpoch: '0x31360fc5', // (uint256 epoch, address purchaser)
  purchaserClaimed: '0xf7cfa1bd', // (uint256 epoch, address purchaser)
  sqrtBackingTotal: '0xd33e5daa',
  builderRewardBps: '0x6c1f08a9',
  buyback: '0xf8ec6911',
  tokenCredit: '0xad1ee407', // tokenCredit(address) — settled FWA waiting for withdrawTokens
  pendingDepositorTokens: '0x6e077f61', // pendingDepositorTokens(uint256 listingId)
  claimDepositorTokens: '0x4627b85f', // claimDepositorTokens(uint256[])
  claimEpochTokens: '0xa545c16a', // claimEpochTokens(uint256[] epochs)
  withdrawTokens: '0x8d8f2adb',
  // CollectionFloorOracle (V2) — call with ethCallTo(floorOracle, …)
  getFloorRange: '0xd72e40e3', // getFloorRange(address) -> (bid, ask, observedAt, periodUsed)
  getFloor: '0x83f67ba4', // getFloor(address) -> (price, observedAt)
  challengePeriod: '0xf3f480d9',
  // FWAV2Buyback — call with ethCallTo(buyback, …)
  maxEthPerBuy: '0x400c5780',
  minBuyDelayBlocks: '0xf923a36b',
  callerRewardBps: '0xe3d604c0',
  routeDepositorBps: '0x87374239',
  routePurchaserBps: '0x898c6150',
  routeBurnBps: '0x224212cb',
  paused: '0x5c975abb',
  lastBuybackBlock: '0x0741dc4d',
  // depositor earnings
  feeCredit: '0x5c584c88', // feeCredit(address)
  pendingFees: '0xa2b93478', // pendingFees(uint256)
  withdrawEarnings: '0xb73c6ce9',
  withdrawListing: '0xaec6e273', // withdrawListing(uint256) — NFT + backing back to depositor
  claimListingFees: '0xb840cf36', // claimListingFees(uint256[])
  updateBacking: '0xc622bfcf', // updateBacking(uint256,uint256) payable — re-price a listing
  claimTopSpot: '0x0986a5a1', // claimTopSpot(uint256)
  kickListing: '0x61e02d6e', // V2 — kickListing(uint256), blackout-only, over-ceiling listings
  // deposit flow (ERC721 calls go to the collection, listNFT to FWA)
  listNFT: '0x3c61c7aa', // listNFT(address,uint256) payable — backing is msg.value
  ownerOf: '0x6352211e',
  getApproved: '0x081812fc',
  isApprovedForAll: '0xe985e9c5',
  approve: '0x095ea7b3', // approve(address,uint256)
  balanceOf: '0x70a08231', // balanceOf(address)
  tokenOfOwnerByIndex: '0x2f745c59', // ERC721Enumerable
  tokensOfOwner: '0x8462151c', // tokensOfOwner(address) — ERC721AQueryable / Punks721, one-call array
  // pull-panel reads
  quoteAcquisitionPrice: '0x987df4cd', // -> (fee, vrf, total)
  settlementDiscountBps: '0xfb2dd096', // ETH cashout (bps of backing)
  settlementWindow: '0xb4a7bdf9',
  acquisitions: '0x41111a4a', // acquisitions(uint256)
  acquisitionRefundCredit: '0x39ea5e12', // acquisitionRefundCredit(address)
  // writes (sent through the user's wallet, never by this app)
  acquire: '0x548b0de9', // V1 — acquire(uint256 maxAcquisitionFee, uint256 minWeightedValue)
  acquireV2: '0xf6cb8511', // V2 — acquire(address purchaser, uint256 count, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps)
  keepNFT: '0x49cfb710',
  acceptDepositorBid: '0x35390e96',
  acceptBidAsTokens: '0x20bd63ba', // acceptBidAsTokens(uint256,uint256)
  withdrawAcquisitionRefund: '0x6e658d1a',
  recoverStuckNFT: '0x8ca14105', // V2 — recoverStuckNFT(uint256)
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
  // admin / governance events
  ConfigSet: '0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc', // event topic hash (public) — gitleaks:allow
  CollectionWhitelistSet: '0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527', // event topic hash (public) — gitleaks:allow
  OwnershipTransferred: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0', // event topic hash (public) — gitleaks:allow
  OwnershipHandoverRequested: '0xdbf36a107da19e49527a7176a1babf963b4b0ff8cde35ee35d6cd8f1f9ac7e1d', // event topic hash (public) — gitleaks:allow
  // V2-only events (all keccak event-signature hashes, public — gitleaks:allow)
  ListingKicked: '0x25d3112a6d76bf15c75a68a5afe2ea559e7ef701e0328cfa7697f0c6fd6e96c5', // (listingId, caller, depositor, backing, oracleCap) — gitleaks:allow
  EarlyCrownExitFee: '0x54481df24baf8652d2c08c9a9de5626c914c23180818e523d3c2a72ac46686d2', // (listingId, depositor, grossBacking, fee) — gitleaks:allow
  TopListingFunded: '0x165c0e5f0e97dd3e3dfd3c8020ff4218886edff2d8f53afa95c0dcd41f4456e0', // every pull — too noisy for feeds — gitleaks:allow
  NFTDeliveryFailed: '0xb1be2a86e47b6e5052fdd7414928151684a30a17640d50390cd274f6df8e00ac', // (listingId, recipient, collection, tokenId) — gitleaks:allow
  StuckNFTRecovered: '0xa92dbf0b2ad45a4269427142d1441737f15adf493da0b097a304f3a1dd71e664', // (listingId, recipient) — gitleaks:allow
  RandomnessTimedOut: '0xb6cbca0f3c364202e477b3951369e96c1c5c8423a8d578723e26f3ef9e24f751', // (requestId, sequence, wordDeadlineBlock, callbackBlock) — gitleaks:allow
  OracleExemptionSet: '0xb2d0f6071086c8df6da3b5d215d8a0e198bd0fbaef5a4bd99df860f827fd5933', // (collection, exempt) — gitleaks:allow
  ProtocolFeesToBuyback: '0xfa8aa08559268fe858e68cd50683d74465cea4c087e9dc303b5690bd5a563c71', // (buyback, amount) — gitleaks:allow
  EarningsWithdrawn: '0x48dc35af7b45e2a81fffad55f6e2fafacdb1d3d0d50d24ebdc16324f5ba757f1', // (depositor, amount) — gitleaks:allow
  RewardsConfigured: '0x3d3d959e38561e3bf73148f6a9048274ba5c2e1f2bc63227c3963a3edf187f3f', // (rewards, token) — gitleaks:allow
  // FWAV2Buyback
  Bought: '0x15053609d51f61ee8a7b1c2250290b901d8ef6cb2afec5d8987f3d8cafa06c4f', // (caller, ethSpent, tokensBought, callerReward, depositorTokens, purchaserTokens, burnedTokens) — gitleaks:allow
};

// owner/governance events — rare, shown in the feeds and scanned deep for the rules card
export const ADMIN_TOPICS = [
  TOPICS.ConfigSet, TOPICS.CollectionWhitelistSet,
  TOPICS.OwnershipTransferred, TOPICS.OwnershipHandoverRequested,
  ...(IS_V2 ? [TOPICS.OracleExemptionSet] : []),
];

// everything a human would call "activity" — shared by the live strip and the 24h feed.
// V2 drops FeesPaidOut: a bot calls payoutFees() nearly every block there
// (a 0-ETH FeesPaidOut + a ProtocolFeesToBuyback each time) — pure noise in a
// 40-row feed; the buyback flow shows up in the rewards card instead.
export const FEED_TOPICS = [
  TOPICS.AcquisitionRequested, TOPICS.NFTAllocated, TOPICS.NFTKept, TOPICS.NFTRelisted,
  TOPICS.DepositorBidAccepted, TOPICS.DepositorBidAcceptedAsTokens,
  TOPICS.AcquisitionExpired, TOPICS.AcquisitionRefundedNoListing, TOPICS.AcquisitionRefundedSlippage,
  TOPICS.NFTListed, TOPICS.ListingStaged, TOPICS.ListingWithdrawn, TOPICS.BackingUpdated,
  TOPICS.UnsettledFinalized, TOPICS.TopListingSet, TOPICS.TopListingSettled,
  ...(IS_V2
    ? [TOPICS.ListingKicked, TOPICS.EarlyCrownExitFee, TOPICS.NFTDeliveryFailed, TOPICS.StuckNFTRecovered, TOPICS.RandomnessTimedOut]
    : [TOPICS.FeesPaidOut]),
  ...ADMIN_TOPICS,
];

// Apply one ConfigSet(key, value) to a knobs object (the no-getter knobs) —
// used by the dashboard's admin overlay and mirrored in api/_fwa.js.
export function applyConfigSet(knobs, key, value) {
  switch (key) {
    case 12: knobs.maxPullsPerTx = value; break;
    case 13: knobs.pullSurchargeBps = value; break;
    case 22: knobs.minBacking = value; break;
    case 23: knobs.protocolFeeToTokenBps = value; break;
    case 41: knobs.pullsEnabled = value !== 0n; break;
    case 42: knobs.withdrawOnly = value !== 0n; break;
    case 43: knobs.whitelistEnabled = value !== 0n; break;
    case 44: knobs.sellBackAsTokens = value !== 0n; break;
    case 62: knobs.whitelistManager = value === 0n ? null : '0x' + value.toString(16).padStart(40, '0'); break;
    default: break;
  }
  return knobs;
}

// FWAConfigKeys / FWAV2ConfigKeys: the owner's tunable knobs, keyed by the uint in ConfigSet(key, value).
// Keys are globally unique across setUint/setBool/setAddr and identical between V1 and V2
// (V2 adds 26–29 and 63–66). fmt renders the raw uint the way a human reads that knob.
const fmtBps = (v) => { const p = Number(v) / 100; return (Number.isInteger(p) ? p : p.toFixed(2)) + '%'; };
const fmtSecs = (v) => { const s = Number(v); return s % 86400 === 0 ? s / 86400 + 'd' : s % 3600 === 0 ? s / 3600 + 'h' : s % 60 === 0 ? s / 60 + 'm' : s + 's'; };
const fmtSwitch = (v) => (v === 0n ? 'OFF' : 'ON');
const fmtAddrWord = (v) => shortAddr('0x' + v.toString(16).padStart(40, '0'));
export const CONFIG_KEYS = {
  1: { label: 'VRF callback gas', fmt: (v) => fmtNum(v) },
  2: { label: 'VRF subscription', fmt: () => 'rotated' },
  7: { label: 'VRF confirmations', fmt: (v) => v.toString() },
  10: { label: 'max activations / pull', fmt: (v) => v.toString() },
  11: { label: 'selection timeout', fmt: (v) => v.toString() + ' blocks' },
  12: { label: 'max pulls / tx', fmt: (v) => v.toString() },
  13: { label: 'pull surcharge', fmt: fmtBps },
  14: { label: 'selection slippage', fmt: fmtBps },
  15: { label: 'crown tithe (share of pulls)', fmt: fmtBps },
  16: { label: 'crown takeover threshold', fmt: (v) => '+' + fmtBps(v) },
  17: { label: 'ETH sell-back payout', fmt: fmtBps },
  18: { label: 'owner cut of pulls', fmt: fmtBps },
  19: { label: 'owner cut of kept NFTs', fmt: fmtBps },
  20: { label: 'winner settlement window', fmt: fmtSecs },
  21: { label: 'finalize window', fmt: fmtSecs },
  22: { label: 'min deposit backing', fmt: (v) => fmtEth(v) + ' ETH' },
  23: { label: 'protocol fees → FWA buyback', fmt: fmtBps },
  24: { label: 'VRF key hash', fmt: () => 'rotated' },
  25: { label: 'staging queue cap', fmt: (v) => (v === 0n ? 'unlimited' : v.toString()) },
  26: { label: 'max oracle quote age', fmt: fmtSecs },
  27: { label: 'min oracle challenge period', fmt: fmtSecs },
  28: { label: 'oracle ceiling premium', fmt: (v) => '+' + fmtBps(v) + ' over ask' },
  29: { label: 'FWA sell-back budget', fmt: fmtBps },
  40: { label: 'retained slice → protocol', fmt: fmtSwitch },
  41: { label: 'pulls enabled', fmt: fmtSwitch },
  42: { label: 'withdraw-only mode', fmt: fmtSwitch },
  43: { label: 'deposit whitelist', fmt: fmtSwitch },
  44: { label: 'sell-back as FWA tokens', fmt: fmtSwitch },
  60: { label: 'VRF coordinator', fmt: () => 'rotated' },
  61: { label: 'payout address', fmt: fmtAddrWord },
  62: { label: 'whitelist manager', fmt: (v) => (v === 0n ? 'revoked' : fmtAddrWord(v)) },
  63: { label: 'VRF service', fmt: fmtAddrWord },
  64: { label: 'floor oracle', fmt: fmtAddrWord },
  65: { label: 'FWAIR launch registry', fmt: (v) => (v === 0n ? 'disabled' : fmtAddrWord(v)) },
  66: { label: 'purchase notifier', fmt: fmtAddrWord },
};
export function describeConfig(key, value) {
  const k = CONFIG_KEYS[key];
  if (!k) return 'config key ' + key + ' = ' + value.toString();
  return k.label + ' → ' + k.fmt(value);
}

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
    const cacheable = misses.every(([, call]) => cacheTtl(call[0]) > 0);
    const useGet = RPC_URL.startsWith('/api/') && cacheable;

    // Big cacheable batches (the ticker's 60 art lookups, a page-load ENS
    // flush) split into fixed-size groups: each group's GET URL stays under
    // the proxy's size guard, so it edge-caches and is shared across visitors
    // instead of falling back to a per-visitor uncached POST. Deterministic
    // grouping + per-group ids keep every visitor's URLs byte-identical. It
    // also keeps every group under the proxy's 64-calls-per-batch cap.
    const GET_CHUNK = 20;
    const groups = [];
    if (useGet && misses.length > GET_CHUNK) {
      for (let i = 0; i < misses.length; i += GET_CHUNK) groups.push(misses.slice(i, i + GET_CHUNK));
    } else {
      groups.push(misses);
    }

    const runGroup = async (group) => {
      const body = group.map(([, call], j) => ({
        jsonrpc: '2.0',
        id: j + 1,
        method: call[0],
        params: call[1],
      }));
      const payload = JSON.stringify(body);

      let res;
      if (useGet) {
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

      group.forEach(([i, call, key], j) => {
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
    };

    await Promise.all(groups.map((g) => runGroup(g).catch((e) => {
      if (!safe) throw e;
      g.forEach(([i]) => { if (results[i] === undefined) results[i] = null; });
    })));
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
        // some default reverse resolvers answer with a bare hex address (seen
        // live: the zero address) instead of empty — only accept things shaped
        // like a real ENS name
        if (n && n.includes('.') && !/^0x[0-9a-fA-F]*$/.test(n)) names[i] = n;
      });
    }
  } catch (_) { /* leave nulls — addresses render as hex */ }
  addrs.forEach((a, i) => {
    ensCache.set(a, names[i]);
    batch.get(a).forEach((resolve) => resolve(names[i]));
  });
}

// EOA vs contract — batched + cached eth_getCode, same shape as the ENS
// resolver. Drives where an address link takes people: EOAs → address.vision,
// contracts → abi.ninja (both link onward to etherscan if wanted).
const codeCache = new Map();
let codePending = new Map();
let codeTimer = null;

export function isContract(address) {
  if (!address) return Promise.resolve(false);
  const a = address.toLowerCase();
  if (codeCache.has(a)) return Promise.resolve(codeCache.get(a));
  return new Promise((resolve) => {
    if (!codePending.has(a)) codePending.set(a, []);
    codePending.get(a).push(resolve);
    if (!codeTimer) codeTimer = setTimeout(flushCodeQueue, 50);
  });
}

async function flushCodeQueue() {
  codeTimer = null;
  const batch = codePending;
  codePending = new Map();
  const addrs = [...batch.keys()];
  const res = await rpcBatchSafe(addrs.map((a) => ['eth_getCode', [a, 'latest']]));
  addrs.forEach((a, i) => {
    const contract = !!(res[i] && res[i] !== '0x');
    if (res[i] != null) codeCache.set(a, contract); // null = transient error, retry next ask
    batch.get(a).forEach((resolve) => resolve(contract));
  });
}

export const addressVisionUrl = (addr) => 'https://address.vision/' + addr;
export const abiNinjaUrl = (addr, methods) =>
  'https://abi.ninja/' + addr + '/1' + (methods && methods.length ? '?methods=' + encodeURIComponent(methods.join(',')) : '');
export const addrExplorerUrl = (addr, contract) => (contract ? abiNinjaUrl(addr) : addressVisionUrl(addr));

// Proxy an http(s) URL through /api/meta (Vercel fn in prod, setupProxy in
// dev) — several big collections' metadata hosts (artblocks, milady,
// veefriends, opepen) send no CORS headers, so direct browser fetches die.
const metaProxyUrl = (url) => '/api/meta?u=' + encodeURIComponent(url);

// hosts whose direct fetch already failed once — go straight to the proxy
const corsBlockedHosts = new Set();
const urlHost = (url) => { try { return new URL(url).host; } catch (_) { return null; } };

// fetch a metadata URL; returns parsed JSON, or { __image: url } if the URL
// turned out to be the image itself (some tokenURIs point straight at art).
async function fetchMeta(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ct = res.headers.get('content-type') || '';
  if (/^image\//i.test(ct)) return { __image: url };
  return res.json();
}

// Best-effort: tokenURI string -> image URL from the metadata JSON.
export async function fetchTokenImage(uri) {
  const url = resolveTokenUrl(uri);
  if (!url) return null;
  let meta = null;
  const host = url.startsWith('data:') ? null : urlHost(url);
  if (host && corsBlockedHosts.has(host)) {
    try { meta = await fetchMeta(metaProxyUrl(url)); } catch (_) { return null; }
  } else {
    try {
      meta = await fetchMeta(url);
    } catch (_) {
      if (!host) return null;
      try { meta = await fetchMeta(metaProxyUrl(url)); } catch (_2) { return null; }
      corsBlockedHosts.add(host);
    }
  }
  if (meta.__image) return meta.__image;
  let img = meta.image || meta.image_url || meta.imageUrl || (meta.properties && meta.properties.image) || null;
  img = resolveTokenUrl(typeof img === 'string' ? img : null);
  if (!img && typeof meta.image_data === 'string' && meta.image_data.trim().startsWith('<svg')) {
    img = 'data:image/svg+xml,' + encodeURIComponent(meta.image_data);
  }
  // http:// art on an https page is blocked as mixed content — proxy it
  if (img && img.startsWith('http://') && typeof window !== 'undefined' && window.location.protocol === 'https:') {
    img = metaProxyUrl(img);
  }
  return img;
}

export const openSeaUrl = (collection, tokenId) => (collection
  ? 'https://opensea.io/assets/ethereum/' + collection + '/' + tokenId
  : null);

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
    // only cache successes — a transient fetch failure shouldn't pin the
    // placeholder forever; the next poll retries
    if (img) listingArtCache[w.id] = entry;
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
    case TOPICS.ConfigSet:
      return { name: 'Rule change', badge: 'danger', parts: [describeConfig(topicNum(t[1]), dataWord(0))] };
    case TOPICS.CollectionWhitelistSet:
      return { name: 'Whitelist', badge: 'danger', parts: [A(topicAddr(t[1])), dataWord(0) === 0n ? ' removed' : ' allowed'] };
    case TOPICS.OwnershipTransferred:
      return { name: 'New owner', badge: 'danger', parts: ['ownership → ', A(topicAddr(t[2]))] };
    case TOPICS.OwnershipHandoverRequested:
      return { name: 'Handover ask', badge: 'danger', parts: [A(topicAddr(t[1])), ' requested ownership'] };
    // ---- V2 ----
    case TOPICS.ListingKicked:
      return { name: 'Kicked', badge: 'danger', parts: ['#' + topicNum(t[1]) + ' over the oracle cap (' + fmtEth(dataWord(0)) + ' > ' + fmtEth(dataWord(1)) + ' ETH) — kicked by ', A(topicAddr(t[2])), ', backing + NFT back to ', A(topicAddr(t[3]))] };
    case TOPICS.EarlyCrownExitFee:
      return { name: 'Crown exit fee', badge: 'warning', parts: ['#' + topicNum(t[1]) + ' left the crown inside 12h — ', A(topicAddr(t[2])), ' paid ' + fmtEth(dataWord(1)) + ' ETH (1% of ' + fmtEth(dataWord(0)) + ')'] };
    case TOPICS.NFTDeliveryFailed:
      return { name: 'NFT stuck', badge: 'danger', parts: ['#' + topicNum(t[1]) + ' could not be delivered to ', A(topicAddr(t[2])), ' — recoverable via recoverStuckNFT'] };
    case TOPICS.StuckNFTRecovered:
      return { name: 'NFT recovered', badge: 'success', parts: ['#' + topicNum(t[1]) + ' recovered by ', A(topicAddr(t[2]))] };
    case TOPICS.RandomnessTimedOut:
      return { name: 'VRF late', badge: 'danger', parts: ['seq ' + topicNum(t[2]) + ': randomness landed after its deadline — request will be skipped and refunded'] };
    case TOPICS.OracleExemptionSet:
      return { name: 'Oracle exempt', badge: 'danger', parts: [A(topicAddr(t[1])), dataWord(0) === 0n ? ' back under the oracle ceiling' : ' exempt from the oracle ceiling (no drift kicks)'] };
    case TOPICS.ProtocolFeesToBuyback:
      return { name: 'Fees → buyback', badge: 'secondary', parts: [fmtEth(dataWord(0)) + ' ETH → ', A(topicAddr(t[1]))] };
    case TOPICS.EarningsWithdrawn:
      return { name: 'Earnings out', badge: 'secondary', parts: [A(topicAddr(t[1])), ' withdrew ' + fmtEth(dataWord(0)) + ' ETH of fees'] };
    default:
      return { name: 'Event', badge: 'secondary', parts: [shortHash(t[0])] };
  }
}
