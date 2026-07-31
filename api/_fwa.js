// FWA constants + hex decode helpers shared by the api/ functions.
// Mirrors src/app/fwa/fwa.js — when the knob/whitelist snapshots are
// regenerated there, regenerate them here too (same block, same values).

const FWA_ADDRESS = '0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c';
const DEPLOY_BLOCK = 25546793;
// Knob/whitelist state below verified on-chain as of this block (2026-07-30);
// ConfigSet / CollectionWhitelistSet events from here to latest overlay it.
const SNAPSHOT_BLOCK = 25650175;

// keccak-256 selectors for the views the snapshot reads
const SELECTORS = {
  activeListingCount: '0x4681a7c6',
  acquisitionFee: '0x38f5f005',
  totalWeight: '0x96c82e57',
  weightedBackingTotal: '0xd6eb0dbd',
  pendingAcquisitionCount: '0x34b1670f',
  unsettledAcquisitionCount: '0x3d21f274',
  topListingId: '0xee35bc33',
  topListingPot: '0xba20687b',
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
  vrfService: '0x59749e94',
  // FWARewards / FWAToken views
  emissionStart: '0x513da948',
  emissionDuration: '0x2d9c4dd2',
  depositorRatePerSec: '0xd2b48fff',
  purchaserDailyPot: '0xfb894e65',
  totalSupply: '0x18160ddd',
  isBuying: '0x24f0aa72',
  tokenBuyAllowanceTotal: '0xb74d90cd',
  // ERC721
  name: '0x06fdde03',
};

const TOPICS = {
  ConfigSet: '0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc', // event topic hash (public) — gitleaks:allow
  CollectionWhitelistSet: '0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527', // event topic hash (public) — gitleaks:allow
};

// Knobs with no public getter, from ConfigSet history at SNAPSHOT_BLOCK.
const KNOB_SNAPSHOT = {
  minBacking: 50000000000000000n, // 0.05 ETH
  pullsEnabled: true,
  withdrawOnly: false,
  whitelistEnabled: true,
  sellBackAsTokens: true,
  maxPullsPerTx: 5n,
  pullSurchargeBps: 1000n,
  whitelistManager: '0x854352b275cf6a0dffcf2983c986fbe9345e17c3',
};

// Collections allowed to deposit, as of SNAPSHOT_BLOCK.
const WHITELIST_SNAPSHOT = [
  ['0x000000000000003607fce1ac9e043a86675c5c2f', 'CryptoPunks 721'],
  ['0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', 'Bored Ape Yacht Club'],
  ['0x60e4d786628fea6478f785a6d7e704777c86a7c6', 'Mutant Ape Yacht Club'],
  ['0xed5af388653567af2f388e6224dc7c4b3241c544', 'Azuki'],
  ['0x5af0d9827e0c53e4799bb226655a1de152a425a5', 'Milady'],
  ['0xbd3531da5cf5857e7cfaa92426877b022e612cf8', 'Pudgy Penguins'],
  ['0x524cab2ec69124574082676e6f654a18df49a048', 'Lil Pudgys'],
  ['0x062e691c2054de82f28008a8ccc6d7a1c8ce060d', 'Pudgy Present'],
  ['0x8a90cab2b38dba80c64b7734e58ee1db38b8992e', 'Doodles'],
  ['0x9c8ff314c9bc7f6e59a9d9225fb22946427edc03', 'Nouns'],
  ['0x7bd29408f11d2bfc23c34f18275bbf23bb716bc7', 'Meebits'],
  ['0xd4e4078ca3495de5b1d4db434bebc5a986197782', 'Autoglyphs'],
  ['0x059edd72cd353df5106d2b9cc5ab83a52287ac3a', 'Art Blocks (Squiggle)'],
  ['0xab00000000002ade39f58f9d8278a31574ffbe77', 'Art Blocks'],
  ['0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a', 'Art Blocks Explorations'],
  ['0xbdde08bd57e5c9fd563ee7ac61618cb2ecdc0ce0', 'CryptoCitizens'],
  ['0x1cb1a5e65610aeff2551a50f76a87a7d3fb649c6', 'Cryptoadz'],
  ['0x42069abfe407c60cf4ae4112bedead391dba1cdb', 'CryptoDickbutts S3'],
  ['0x036721e5a769cc48b3189efbb9cce4471e8a48b1', 'Checks'],
  ['0x6339e5e072086621540d0362c4e3cea0d643e114', 'Opepen Edition'],
  ['0xd774557b647330c91bf44cfeab205095f7e6c367', 'Nakamigos'],
  ['0x79fcdef22feed20eddacbb2587640e45491b757f', 'mfers'],
  ['0x2acab3dea77832c09420663b0e1cb386031ba17b', 'DeadFellaz'],
  ['0xa3aee8bce55beea1951ef834b99f3ac60d1abeeb', 'VeeFriends'],
  ['0x9378368ba6b85c1fba5b131b530f5f5bedf21a18', 'VeeFriends Series 2'],
  ['0xb852c6b5892256c264cc2c888ea462189154d8d7', 'Rektguy'],
  ['0x307af7d28afee82092aa95d35644898311ca5360', 'Chimpers'],
  ['0xd4b7d9bb20fa20ddada9ecef8a7355ca983cccb1', 'Quirkies'],
  ['0xc7e67762821b2ed6c0a1f423547b2899822d8650', 'Wolf Game'],
  ['0x790b2cf29ed4f310bf7641f013c65d4560d28371', 'Otherdeed Expanded'],
  ['0xe012baf811cf9c05c408e879c399960d1f305903', 'Koda'],
  ['0x26d7ad0e930b54b84c00daad077ee31ba9e2fb2e', 'Ten Thousand Tokens'],
  ['0xd1169e5349d1cb9941f3dcba135c8a4b9eacfdde', 'MAX PAIN (XCOPY)'],
  ['0xc04e0000726ed7c5b9f0045bc0c4806321bc6c65', 'XCORE'],
  ['0xd92e44ac213b9ebda0178e1523cc0ce177b7fa96', 'Beeple Round 2'],
  ['0xdd012153e008346591153fff28b0dd6724f0c256', 'Beeple Spring Collection'],
  ['0x4440732b0d85e2a77dcb2caedfd940154241249a', 'Masks of Luci (Sam Spratt)'],
  ['0x880af717abba38f31ca21673843636a355fb45f3', 'DRIP DROP (Dave Krugman)'],
  ['0x8e02d1e68dff0dcebf1cde4ee5f60f1d5a499b1e', 'OCH Genesis Ring'],
  ['0x7a50abab1af2c15fe9780f4f045820294e1a715c', 'PXL NET'],
  ['0xdfea2b364db868b1d2601d6b833d74db4de94460', 'RMNANTS'],
  ['0x7a7b26ec72c8497fd068211979199044deeacc3b', 'REGULAR ANIMALS'],
  ['0xa471f4da9b79645f4f5358e102c62f59c1329aa5', 'beef brothko'],
  ['0x03b8d129a8f6dc62a797b59aa5eebb11ad63dada', 'SMOWL'],
  ['0x75de5bc35248026fabcb2382cf322bc79dfd1a8c', 'Birds'],
  ['0xb8ea78fcacef50d41375e44e6814ebba36bb33c4', 'Good Vibes Club'],
  ['0xe18f2247fe4a69c0e2210331b0604f6d10fece9e', 'glitch Gallery'],
  ['0x4c159520f1117ac58cb5efa1765469cac54dcaab', 'pattern recognition'],
  ['0x6efc003d3f3658383f06185503340c2cf27a57b6', 'YOU THE REAL MVP'],
  ['0x614917f589593189ac27ac8b81064cbe450c35e3', 'Letters'],
  ['0x4024c2083f5457874ec489f7c7332680bb86c92b', 'Farmer'],
  ['0xd0090373e80236adb6c07cf21b7395938cca46b3', 'everything vs nothing'],
  ['0xd90829c6c6012e4dde506bd95d7499a04b9a56de', 'BROKEN'],
  ['0xf8cc77098adb1e8becad7aae11d667aa01db9d7c', 'GeoMetric Pepes'],
  ['0xd716473c8eb83a2102def2b6390d9dfe74b2f580', 'Wrappers'],
  ['0x8fe1a377b83921fe1429adb1b8fbfecd45de9cd8', 'fwogs'],
  ['0xd16809c0a7d82c9e7552a01fd608fff90efb564f', 'RCS'],
  ['0xd83b6493ecebc29a6da555935d1b8572a14fc989', 'Ethos Validators'],
  ['0x0427743df720801825a5c82e0582b1e915e0f750', '0xmons'],
  ['0x727c739f07a89f11e883fe0f34937c55e4c3d74a', 'FWA Token Packs'],
  ['0x470879abd61fdca91436fe27ed87db2c8650f3e7', 'Locked FWA Token Packs'],
];

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
  FWA_ADDRESS, DEPLOY_BLOCK, SNAPSHOT_BLOCK, SELECTORS, TOPICS,
  KNOB_SNAPSHOT, WHITELIST_SNAPSHOT,
  toBig, toNum, word, wordAddr, decodeString, fmtEth,
};
