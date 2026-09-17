#!/usr/bin/env node
// Regenerate src/app/fwa/pools.json — the baked on-chain state (owner knobs
// with no public getter, the deposit whitelist, oracle exemptions) for BOTH
// main pools. The app and the api/ functions overlay live ConfigSet /
// CollectionWhitelistSet / OracleExemptionSet events on top of this file, so
// it only has to be fresh enough that the overlay scan stays short.
//
//   RPC=https://eth-mainnet.g.alchemy.com/v2/KEY node scripts/snapshot.mjs
//
// Read-only. Never commit an RPC key; pass it in the environment.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RPC = process.env.RPC || process.env.NODE_RPC_URL;
if (!RPC) { console.error('set RPC=<mainnet json-rpc url>'); process.exit(1); }

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'fwa', 'pools.json');

const POOLS = {
  v2: { address: '0x958C41181182e76F221331b2755b77D9e1426A98', deployBlock: 25944480 },
  v1: { address: '0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c', deployBlock: 25546793 },
};

// event topic hashes (public keccak of the event sigs) — gitleaks:allow
const T = {
  ConfigSet: '0x150110afd46e9924086bf85c855aae25722518b293155bf0ae689dd99a2e88cc', // gitleaks:allow
  CollectionWhitelistSet: '0x4c4950b9ef6cb1bc030a44fd8dc97dd16083b2731fb3516ed4f0b9cdffcc9527', // gitleaks:allow
  OracleExemptionSet: '0xb2d0f6071086c8df6da3b5d215d8a0e198bd0fbaef5a4bd99df860f827fd5933', // gitleaks:allow
};

// prettier names than name() returns, keyed by lowercase address
const CURATED = {
  '0x000000000000003607fce1ac9e043a86675c5c2f': 'CryptoPunks 721',
  '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d': 'Bored Ape Yacht Club',
  '0x60e4d786628fea6478f785a6d7e704777c86a7c6': 'Mutant Ape Yacht Club',
  '0xbd3531da5cf5857e7cfaa92426877b022e612cf8': 'Pudgy Penguins',
  '0x524cab2ec69124574082676e6f654a18df49a048': 'Lil Pudgys',
  '0x062e691c2054de82f28008a8ccc6d7a1c8ce060d': 'Pudgy Present',
  '0x059edd72cd353df5106d2b9cc5ab83a52287ac3a': 'Art Blocks (Squiggle)',
  '0xab00000000002ade39f58f9d8278a31574ffbe77': 'Art Blocks',
  '0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a': 'Art Blocks Explorations',
  '0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270': 'Art Blocks (Curated)',
  '0x99a9b7c1116f9ceeb1652de04d5969cce509b069': 'Art Blocks (Presents)',
  '0xab0000000000aa06f89b268d604a9c1c41524ac6': 'Art Blocks (Studio)',
  '0x79fcdef22feed20eddacbb2587640e45491b757f': 'mfers',
  '0x4440732b0d85e2a77dcb2caedfd940154241249a': 'Masks of Luci (Sam Spratt)',
  '0x880af717abba38f31ca21673843636a355fb45f3': 'DRIP DROP (Dave Krugman)',
  '0xd1169e5349d1cb9941f3dcba135c8a4b9eacfdde': 'MAX PAIN (XCOPY)',
  '0xd92e44ac213b9ebda0178e1523cc0ce177b7fa96': 'Beeple Round 2',
  '0x0427743df720801825a5c82e0582b1e915e0f750': '0xmons',
  '0xdfea2b364db868b1d2601d6b833d74db4de94460': 'RMNANTS',
  '0x727c739f07a89f11e883fe0f34937c55e4c3d74a': 'FWA Token Packs', // public contract address — gitleaks:allow
  '0x470879abd61fdca91436fe27ed87db2c8650f3e7': 'Locked FWA Token Packs', // public contract address — gitleaks:allow
};

async function rpc(calls) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c[0], params: c[1] }))) });
  const json = await res.json();
  const byId = {}; (Array.isArray(json) ? json : [json]).forEach((r) => { byId[r.id] = r; });
  return calls.map((_, i) => (byId[i + 1] && !byId[i + 1].error ? byId[i + 1].result : null));
}
const hx = (n) => '0x' + n.toString(16);
const word = (h, i = 0) => BigInt('0x' + h.slice(2 + i * 64, 2 + (i + 1) * 64));
const addr = (h) => '0x' + h.slice(26).toLowerCase();
const decodeString = (h) => {
  try { const off = Number(word(h, 0)); const len = Number(BigInt('0x' + h.slice(2 + off * 2, 2 + off * 2 + 64))); return Buffer.from(h.slice(2 + off * 2 + 64, 2 + off * 2 + 64 + len * 2), 'hex').toString('utf8'); } catch (e) { return null; }
};

async function scan(address, from, to, topics) {
  const ranges = [];
  for (let f = from; f <= to; f += 50000) ranges.push([f, Math.min(f + 49999, to)]);
  const chunks = await rpc(ranges.map(([a, b]) => ['eth_getLogs', [{ address, fromBlock: hx(a), toBlock: hx(b), topics: [topics] }]]));
  if (chunks.some((c) => c === null)) throw new Error('getLogs failed for ' + address);
  return chunks.flat().sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || Number(x.logIndex) - Number(y.logIndex));
}

const latest = Number((await rpc([['eth_blockNumber', []]]))[0]);
let prev = {};
try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch (e) { /* first run */ }
const out = { generatedAt: new Date().toISOString(), snapshotBlock: latest };

for (const [id, pool] of Object.entries(POOLS)) {
  const logs = await scan(pool.address, pool.deployBlock, latest, [T.ConfigSet, T.CollectionWhitelistSet, T.OracleExemptionSet]);
  const config = {}; // key -> latest value (decimal string)
  const wl = new Map(); const exempt = new Set();
  logs.forEach((l) => {
    if (l.topics[0] === T.ConfigSet) config[Number(word(l.topics[1]))] = word(l.data).toString();
    else if (l.topics[0] === T.CollectionWhitelistSet) { const a = addr(l.topics[1]); if (word(l.data) === 0n) wl.delete(a); else if (!wl.has(a)) wl.set(a, null); }
    else if (l.topics[0] === T.OracleExemptionSet) { const a = addr(l.topics[1]); if (word(l.data) === 0n) exempt.delete(a); else exempt.add(a); }
  });
  const addrs = [...wl.keys()];
  const names = await rpc(addrs.map((a) => ['eth_call', [{ to: a, data: '0x06fdde03' }, 'latest']]));
  const prevNames = new Map(((prev[id] || {}).whitelist || []));
  addrs.forEach((a, i) => wl.set(a, CURATED[a] || prevNames.get(a) || (names[i] && decodeString(names[i])) || a));
  const asAddr = (v) => (v ? '0x' + BigInt(v).toString(16).padStart(40, '0') : null);
  out[id] = {
    address: pool.address,
    deployBlock: pool.deployBlock,
    // knobs with no public getter — see FWAV2ConfigKeys.sol / FWAConfigKeys.sol
    knobs: {
      minBacking: config[22] || '10000000000000000',
      pullSurchargeBps: config[13] || '500',
      maxPullsPerTx: config[12] || '5',
      protocolFeeToTokenBps: config[23] || '0',
      maxStagedListings: config[25] || '0',
      pullsEnabled: config[41] === '1',
      withdrawOnly: config[42] === '1',
      whitelistEnabled: config[43] !== '0',
      sellBackAsTokens: config[44] !== '0',
      whitelistManager: asAddr(config[62]),
      fwairLaunchRegistry: asAddr(config[65]),
    },
    configLatest: config, // every ConfigSet key's latest value, for the record
    whitelist: [...wl.entries()],
    oracleExempt: [...exempt],
  };
  console.log(id, pool.address, '→', wl.size, 'whitelisted,', exempt.size, 'oracle-exempt,', Object.keys(config).length, 'config keys');
}

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', OUT, 'at block', latest);
