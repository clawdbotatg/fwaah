// FWA constants + hex decode helpers shared by the api/ functions.
// Mirrors src/app/fwa/fwa.js. The on-chain snapshot (no-getter knobs,
// whitelist, oracle exemptions) is the SAME pools.json the app imports —
// regenerate it with `node scripts/snapshot.mjs`; nothing to keep in sync here.

const SNAPSHOTS = require('../src/app/fwa/pools.json');

// static per-pool facts — https://www.fwa.fun/docs/v2-deployments, /docs/deployments
const POOL_STATIC = {
  v2: {
    id: 'v2',
    label: 'V2',
    title: 'FWA V2 main pool',
    site: 'https://www.fwa.fun',
    docs: 'https://www.fwa.fun/docs/v2',
    contracts: {
      vrfService: '0xCACBd874e24B533935176154E990Bf710F56693A',
      buyback: '0xaba91665cdf921F0f6B33A099337336B324c9793',
      purchaseNotifier: '0x612dF3a344990F8E53499ec1bC79Be63cFa496D0',
      whitelistAuthority: '0x0ad3128429242007D58952c65546BA99b9b70146',
      fwairLaunchManager: '0x716486a7bD6B4d7409fC4F8B52f0B23D2BcFac72',
      punkLister: '0xb924048A35160B077A85954A049d5CAc29F23ad1',
      feeSplitter: '0x1b83eb5d2377150d561c05f0475fccd78c12645b', // OwnerSplitterV2 — 20% of hook trading fees → punk lister
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
    },
  },
};

function buildPool(id) {
  const snap = SNAPSHOTS[id];
  const k = snap.knobs;
  return {
    ...POOL_STATIC[id],
    address: snap.address,
    deployBlock: snap.deployBlock,
    snapshotBlock: SNAPSHOTS.snapshotBlock,
    knobs: {
      minBacking: BigInt(k.minBacking),
      pullSurchargeBps: BigInt(k.pullSurchargeBps),
      maxPullsPerTx: BigInt(k.maxPullsPerTx),
      protocolFeeToTokenBps: BigInt(k.protocolFeeToTokenBps),
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
const POOLS = { v2: buildPool('v2'), v1: buildPool('v1') };

// token-level facts shared by both pools
const FWA_TOKEN = '0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845';
const PUNKS_721 = '0x000000000000003607fce1ac9e043a86675c5c2f'; // CryptoPunks 721 wrapper
const INITIAL_FWA_SUPPLY = 10n ** 27n; // 1B FWA minted at deploy; burns only shrink it
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // ERC-20/721 Transfer — gitleaks:allow
const ZERO_TOPIC = '0x' + '0'.repeat(64);
// FWAPunkListerV2 views + events (V2 only) — public keccak hashes — gitleaks:allow
const LISTER_SELECTORS = {
  lockedCapital: '0x2f86e2b0', spendableCapital: '0xde4a097d', purchaseCapacity: '0xb592e0c6',
  publicMarketPurchasesEnabled: '0xc0abf507', nextPositionId: '0x899346c7', paused: '0x5c975abb', configuration: '0x6c70bee9',
};
const LISTER_TOPICS = {
  PunkPurchased: '0xc95fbbb2b2b5d79d5eea30ca1c563dd8af4018a13a189d987dedfdf8ff61383b', // gitleaks:allow
  WrappedPunkDeposited: '0x91200a452433bfcba10e482a32f3c6b80ff4344520058fde60d4021a43d70a25', // gitleaks:allow
  PositionListed: '0xa4e908016dd25c77bb716cc01f2731681013a7f1266f6646a006fb96296cc73b', // gitleaks:allow
  PositionExited: '0xc80edd82547f4dcac7cba54a3338657b4d10f55e0f44a36a4b8d1c182d301005', // gitleaks:allow
  CapitalLocked: '0x0ab1e73b4fbe24bd81c00f49859ce55f65648be9bafb94195658077da0978016', // gitleaks:allow
  BackingReduced: '0x678d6eded3ce3adfb0c49ab8a81fcc15a1ae8a2e0e22f93d4d9c78f93d66b685', // gitleaks:allow
};

// ?pool=v1|v2 on the request; V2 is the default
function poolFromReq(req) {
  const q = String((req.query && req.query.pool) || '').toLowerCase();
  return POOLS[q] || POOLS.v2;
}

// keccak-256 selectors for the views the snapshot reads (shared V1/V2 unless tagged)
const SELECTORS = {
  activeListingCount: '0x4681a7c6',
  acquisitionFee: '0x38f5f005',
  totalWeight: '0x96c82e57',
  weightedBackingTotal: '0xd6eb0dbd',
  pendingAcquisitionCount: '0x34b1670f',
  unsettledAcquisitionCount: '0x3d21f274',
  topListingId: '0xee35bc33',
  topListingPot: '0xba20687b',
  topListingSince: '0x9360191e', // V2
  nextListingId: '0xaaccf1ec',
  accruedOwnerFees: '0x7b9aa10f',
  acquisitionEscrowTotal: '0x59d973db',
  acquisitionRefundCreditTotal: '0xb5091d48',
  listings: '0xde74e57b',
  finalizeWindow: '0x8600e5cb',
  ownerAcquisitionFeeBps: '0x2b0b9641',
  ownerSettlementFeeBps: '0x4a088a42',
  topListingShareBps: '0x823e645a',
  topThresholdBps: '0x6a6e8c70',
  retainedToProtocol: '0x5b69ae6a',
  selectionSlippageBps: '0x40ef7ee1',
  selectionTimeoutBlocks: '0xdf881bd1',
  settlementDiscountBps: '0xfb2dd096',
  settlementWindow: '0xb4a7bdf9',
  owner: '0x8da5cb5b',
  payoutAddress: '0x5b8d02d7',
  token: '0xfc0c546a',
  rewards: '0x9ec5a894',
  vrfService: '0x59749e94', // V1 only
  // V2 core
  tokenSettlementDiscountBps: '0x97d69193',
  isPurchaseBlackout: '0x4d5fe14c',
  floorOracle: '0x29dd24c7',
  oracleCeilingPremiumBps: '0xedfd4c45',
  maxOracleAge: '0x7c87a993',
  minOracleChallengePeriod: '0xf2565bde',
  fwairLaunchRegistry: '0x4146858d',
  vrfServiceFee: '0xff48b8ae',
  // FWARewards (V1) / FWAToken views
  emissionStart: '0x513da948',
  emissionDuration: '0x2d9c4dd2',
  depositorRatePerSec: '0xd2b48fff',
  purchaserDailyPot: '0xfb894e65',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  isBuying: '0x24f0aa72',
  tokenBuyAllowanceTotal: '0xb74d90cd',
  // FWAV2Rewards views
  epochStart: '0x15e5a1e5',
  currentEpoch: '0x76671808',
  purchaserEpochPot: '0x641a875d',
  acquisitionsInEpoch: '0x68a9b6ff',
  pendingAcquisitionsInEpoch: '0xa3cc7a8c',
  sqrtBackingTotal: '0xd33e5daa',
  builderRewardBps: '0x6c1f08a9',
  buyback: '0xf8ec6911',
  // FWAV2Buyback views
  maxEthPerBuy: '0x400c5780',
  callerRewardBps: '0xe3d604c0',
  routeDepositorBps: '0x87374239',
  routePurchaserBps: '0x898c6150',
  routeBurnBps: '0x224212cb',
  paused: '0x5c975abb',
  lastBuybackBlock: '0x0741dc4d',
  // ERC721
  name: '0x06fdde03',
};

// event topic0 hashes (public keccak of the event sigs) — gitleaks:allow
const TOPICS = {
  ConfigSet: '0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc', // gitleaks:allow
  CollectionWhitelistSet: '0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527', // gitleaks:allow
  OracleExemptionSet: '0xb2d0f6071086c8df6da3b5d215d8a0e198bd0fbaef5a4bd99df860f827fd5933', // V2 — gitleaks:allow
  AcquisitionRequested: '0xf23e34f4aa4a06ecddd309d9692e7b7ca45b76fd0d5f4ce4f7fbf29731d9abd6', // gitleaks:allow
  NFTAllocated: '0xaf0d8c007926747ede4270a56f69d2e872c3f0d7e1ef7bbc643b3185c50f6758', // gitleaks:allow
  NFTKept: '0xe71c2721f75bef3206b21176a6d26685852a16878249fc84d18f443f959bb8f5', // gitleaks:allow
  NFTRelisted: '0x5fa40266a1e401404f322db009d5f8631ed44abc96b84784d9f8f90a8846abd8', // gitleaks:allow
  DepositorBidAccepted: '0x88ebc94b0ff4693b3d25995dc7c5c4e5683a8ca7de00836773ca24c8b69d78e3', // gitleaks:allow
  DepositorBidAcceptedAsTokens: '0x819cd055ab6ba83877ab68882609b8d7aa75d4951f6d89fa99d3b59fa45f439f', // gitleaks:allow
  AcquisitionExpired: '0x97639294216e9dc091da2646074b483c81c79f6b6143e69b244331ecded15b12', // gitleaks:allow
  AcquisitionRefundedNoListing: '0x4906638bdfd382f0f3258500c1e972e71b9b3cd95ceacd95ca188d493c8e0ee8', // gitleaks:allow
  AcquisitionRefundedSlippage: '0x6e0c967dcdde10dc8a73e11f39aac35df75b9647cd6db11c0918a0d49e98f22a', // gitleaks:allow
  NFTListed: '0x01c953cf171a8c32b553c5b7e0964bae6b2123db065615e54e8425fec3ec16cd', // gitleaks:allow
  ListingWithdrawn: '0x155ad598d62a05a119f984c463f10d75b4fe9b0af1e0fbe0c2b2caaf8e4bdfda', // gitleaks:allow
  UnsettledFinalized: '0x6f4528c508dc00c3d0fb4dcffe0346f48ae4332f18abe3d4eff0b27895997929', // gitleaks:allow
  ListingKicked: '0x25d3112a6d76bf15c75a68a5afe2ea559e7ef701e0328cfa7697f0c6fd6e96c5', // V2 — gitleaks:allow
  EarlyCrownExitFee: '0x54481df24baf8652d2c08c9a9de5626c914c23180818e523d3c2a72ac46686d2', // V2 — gitleaks:allow
};

// human labels for ConfigSet(key, value) — mirrors CONFIG_KEYS in fwa.js
const CONFIG_LABELS = {
  1: 'VRF callback gas', 2: 'VRF subscription', 7: 'VRF confirmations',
  10: 'max activations / pull', 11: 'selection timeout (blocks)', 12: 'max pulls / tx',
  13: 'pull surcharge (bps)', 14: 'selection slippage (bps)', 15: 'crown tithe (bps)',
  16: 'crown takeover threshold (bps)', 17: 'ETH sell-back payout (bps)',
  18: 'owner cut of pulls (bps)', 19: 'owner cut of kept NFTs (bps)',
  20: 'winner settlement window (s)', 21: 'finalize window (s)', 22: 'min deposit backing (wei)',
  23: 'protocol fees → FWA buyback (bps)', 24: 'VRF key hash', 25: 'staging queue cap',
  26: 'max oracle quote age (s)', 27: 'min oracle challenge period (s)', 28: 'oracle ceiling premium (bps)',
  29: 'FWA sell-back budget (bps)',
  40: 'retained slice → protocol', 41: 'pulls enabled', 42: 'withdraw-only mode',
  43: 'deposit whitelist', 44: 'sell-back as FWA tokens',
  60: 'VRF coordinator', 61: 'payout address', 62: 'whitelist manager',
  63: 'VRF service', 64: 'floor oracle', 65: 'FWAIR launch registry', 66: 'purchase notifier',
};

// apply one ConfigSet(key, value) to a knobs object — mirrors applyConfigSet in fwa.js
function applyConfigSet(knobs, key, value) {
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

// ---- hex decode helpers (32-byte word ABI layout) ----

function toBig(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function toNum(hex) {
  return Number(toBig(hex));
}

function word(hex, i) {
  const s = (hex || '0x').slice(2);
  const w = s.slice(i * 64, (i + 1) * 64);
  return w ? BigInt('0x' + w) : 0n;
}

function wordAddr(hex, i) {
  return '0x' + word(hex, i).toString(16).padStart(40, '0');
}

// ABI-encoded string return (offset word, length word, utf8 bytes)
function decodeString(hex) {
  try {
    const off = Number(word(hex, 0));
    const len = Number(BigInt('0x' + (hex.slice(2 + off * 2, 2 + off * 2 + 64) || '0')));
    const bytes = hex.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2);
    return Buffer.from(bytes, 'hex').toString('utf8');
  } catch (e) {
    return null;
  }
}

// wei bigint -> decimal ETH string, up to 6 dp, no trailing zeros
function fmtEth(wei) {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = ((abs % 10n ** 18n) / 10n ** 12n).toString().padStart(6, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

module.exports = {
  POOLS, poolFromReq, SELECTORS, TOPICS, CONFIG_LABELS, applyConfigSet,
  FWA_TOKEN, PUNKS_721, INITIAL_FWA_SUPPLY, TRANSFER_TOPIC, ZERO_TOPIC, LISTER_SELECTORS, LISTER_TOPICS,
  toBig, toNum, word, wordAddr, decodeString, fmtEth,
};
