import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS, IS_V2, CROWN_COMMITMENT_S, oracleCeiling,
  rpcBatch, rpcBatchSafe, ethCall, ethCallTo, addrTopic, encodeData,
  toNum, toBig, word, wordAddr, topicNum,
  fmtEth, fmtNum, fmtAge, fetchListingArt, openSeaUrl, POLL,
} from '../fwa/fwa';
import { injected, onAccountsChanged, autoReconnectAllowed, sendTx, waitForReceipt } from '../fwa/wallet';

const POLL_MS = POLL.account;
const CHUNK_BLOCKS = 7200; // 24h per getLogs call — under node range/result caps
const MAX_SCAN_BLOCKS = 50400; // ~7d; pruned nodes stop the walk early anyway
const MAX_TILES = 48; // whale guard: count/total cover everything, tiles don't
const LISTING_ACTIVE = 1n;
const ZERO_ADDR = /^0x0{40}$/;

// Your NFTs currently in the pool. NFTListed indexes the depositor, so one
// filtered log scan finds your listings without touching every collection:
// the newest day paints first, then the walk deepens to ~7d in the background,
// and each poll re-checks statuses (pulled NFTs drop out) + picks up new
// deposits incrementally.
export class MyDeposits extends Component {
  state = {
    account: null, items: [], scanning: false, scannedBlocks: 0, now: Date.now(),
    feeCredit: 0n, pendingTotal: 0n, // ETH fee earnings: settled credit + pending on active listings
    fwaCredit: 0n, fwaPendingTotal: 0n, // FWA rewards from the rewards module, same split
    crown: null, // { listingId, since } — who holds the crown (V2 adds the 12h commitment)
    txBusy: null, txError: null,
  };

  componentDidMount() {
    this.alive = true;
    this.seen = new Set();
    this.lastBlock = 0;
    onAccountsChanged((accounts) => {
      if (!this.alive) return;
      const account = accounts && accounts[0] ? accounts[0] : null;
      this.seen = new Set();
      this.lastBlock = 0;
      this.setState({ account, items: [], scannedBlocks: 0 });
      if (account) this.deepScan(account);
    });
    const tryReconnect = (attempts) => {
      if (!autoReconnectAllowed()) return; // user hit disconnect — stay out
      const eth = injected();
      if (eth) {
        eth.request({ method: 'eth_accounts' }).then((accounts) => {
          if (this.alive && accounts && accounts[0] && !this.state.account) {
            this.setState({ account: accounts[0] });
            this.deepScan(accounts[0]);
          }
        }).catch(() => { /* wallet locked — stay hidden */ });
      }
      if (attempts > 0 && !this.state.account) {
        setTimeout(() => this.alive && tryReconnect(attempts - 1), 1000);
      }
    };
    tryReconnect(3);
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 5000);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  // one-time wiring: rewards module address; on V2 also the floor oracle,
  // its premium and quote max-age (needed to flag listings above the ceiling)
  async loadWiring() {
    if (this.wiring) return this.wiring;
    try {
      const calls = [ethCall(SELECTORS.rewards)];
      if (IS_V2) calls.push(ethCall(SELECTORS.floorOracle), ethCall(SELECTORS.oracleCeilingPremiumBps), ethCall(SELECTORS.maxOracleAge));
      const r = await rpcBatchSafe(calls);
      const rewards = r[0] ? wordAddr(r[0], 0) : null;
      this.wiring = {
        rewards: rewards && !ZERO_ADDR.test(rewards) ? rewards : null,
        oracle: IS_V2 && r[1] ? wordAddr(r[1], 0) : null,
        premiumBps: IS_V2 && r[2] ? toBig(r[2]) : 0n,
        maxAgeS: IS_V2 && r[3] ? toNum(r[3]) : 0,
      };
    } catch (e) { this.wiring = null; }
    return this.wiring;
  }

  depositorLogs(account, from, to) {
    return rpcBatch([['eth_getLogs', [{
      address: FWA_ADDRESS,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [[TOPICS.NFTListed], null, null, addrTopic(account)],
    }]]]).then(([logs]) => logs);
  }

  // walk history backward one day at a time so the strip paints fast and
  // deepens; stops quietly when the node's pruned/range-capped history ends
  async deepScan(account) {
    this.setState({ scanning: true });
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      this.lastBlock = latest;
      for (let back = 0; back < MAX_SCAN_BLOCKS; back += CHUNK_BLOCKS) {
        if (!this.alive || this.state.account !== account) return;
        const to = latest - back;
        const from = Math.max(to - CHUNK_BLOCKS + 1, 0);
        let logs;
        try {
          logs = await this.depositorLogs(account, from, to);
        } catch (e) { break; }
        await this.ingest(account, logs, latest);
        if (!this.alive || this.state.account !== account) return;
        this.setState({ scannedBlocks: Math.min(back + CHUNK_BLOCKS, MAX_SCAN_BLOCKS) });
        if (from === 0) break;
      }
    } catch (e) { /* retry via poll */ }
    if (this.alive) this.setState({ scanning: false });
  }

  // incremental: 2 RPC calls per poll (blockNumber + a tiny getLogs range);
  // the N-call status sweep runs on the slower highValue cadence, and art
  // that failed under page-load pressure retries here until it lands
  async poll() {
    const { account } = this.state;
    if (!account || this.state.scanning) return;
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      if (this.lastBlock && latest > this.lastBlock) {
        const logs = await this.depositorLogs(account, this.lastBlock + 1, latest);
        this.lastBlock = latest;
        await this.ingest(account, logs, latest);
      }
      // drop items that left the pool (pulled / withdrawn / relisted away) and
      // total up the fee earnings — batched eth_calls per item, so only sweep
      // every POLL.highValue
      const { items } = this.state;
      if (items.length && Date.now() - (this.lastSweep || 0) > POLL.highValue) {
        this.lastSweep = Date.now();
        const wiring = await this.loadWiring();
        const n = items.length;
        const calls = [
          ...items.map((it) => ethCall(SELECTORS.listings, [BigInt(it.listingId)])),
          ...items.map((it) => ethCall(SELECTORS.pendingFees, [BigInt(it.listingId)])),
          ethCall(SELECTORS.feeCredit, [account]),
          ethCall(SELECTORS.topListingId),
          ...(IS_V2 ? [ethCall(SELECTORS.topListingSince)] : []),
        ];
        // FWA rewards ride the same batch when the module is wired
        const hasRewards = wiring && wiring.rewards;
        if (hasRewards) {
          calls.push(...items.map((it) => ethCallTo(wiring.rewards, SELECTORS.pendingDepositorTokens, [BigInt(it.listingId)])));
          calls.push(ethCallTo(wiring.rewards, SELECTORS.tokenCredit, [account]));
        }
        // V2 oracle ceiling per distinct collection, to flag kick-eligible listings
        const collections = IS_V2 && wiring && wiring.oracle
          ? [...new Set(items.map((it) => it.collection).filter(Boolean))] : [];
        collections.forEach((c) => calls.push(
          ethCallTo(wiring.oracle, SELECTORS.getFloorRange, [c]),
          ethCall(SELECTORS.oracleExemptCollections, [c]),
        ));
        const res = await rpcBatchSafe(calls);
        const gone = new Set();
        const pendingById = {};
        let pendingTotal = 0n;
        items.forEach((it, i) => {
          const raw = res[i];
          if (!raw || word(raw, 10) !== LISTING_ACTIVE
            || wordAddr(raw, 1).toLowerCase() !== account.toLowerCase()) gone.add(it.listingId);
          else if (res[n + i]) {
            const p = word(res[n + i], 0);
            pendingById[it.listingId] = p;
            pendingTotal += p;
          }
        });
        let i = 2 * n;
        const creditRaw = res[i++];
        const topRaw = res[i++];
        const sinceRaw = IS_V2 ? res[i++] : null;
        const crown = topRaw && word(topRaw, 0) !== 0n
          ? { listingId: Number(word(topRaw, 0)), since: sinceRaw ? Number(word(sinceRaw, 0)) : null } : null;
        const fwaById = {};
        let fwaPendingTotal = 0n;
        let fwaCreditRaw = null;
        if (hasRewards) {
          items.forEach((it, j) => {
            const r = res[i + j];
            if (r) { fwaById[it.listingId] = word(r, 0); fwaPendingTotal += word(r, 0); }
          });
          i += n;
          fwaCreditRaw = res[i++];
        }
        // cap per collection: null when exempt or no fresh quote (no kick possible without one)
        const capByCollection = {};
        collections.forEach((c) => {
          const rangeRaw = res[i++];
          const exemptRaw = res[i++];
          const exempt = !!exemptRaw && word(exemptRaw, 0) === 1n;
          const ask = rangeRaw ? word(rangeRaw, 1) : 0n;
          const fresh = rangeRaw && ask !== 0n && Number(word(rangeRaw, 2)) + wiring.maxAgeS >= Date.now() / 1000;
          capByCollection[c] = exempt || !fresh ? null : oracleCeiling(ask, wiring.premiumBps);
        });
        if (this.alive && this.state.account === account) {
          this.setState((prev) => ({
            items: prev.items
              .filter((it) => !gone.has(it.listingId))
              .map((it) => ({
                ...it,
                pending: pendingById[it.listingId] !== undefined ? pendingById[it.listingId] : it.pending,
                fwaPending: fwaById[it.listingId] !== undefined ? fwaById[it.listingId] : it.fwaPending,
                cap: it.collection && capByCollection[it.collection] !== undefined ? capByCollection[it.collection] : it.cap,
              })),
            pendingTotal,
            feeCredit: creditRaw ? word(creditRaw, 0) : prev.feeCredit,
            fwaPendingTotal,
            fwaCredit: fwaCreditRaw ? word(fwaCreditRaw, 0) : prev.fwaCredit,
            crown,
          }));
        }
      }
      // retry art for visible tiles that missed it (cache makes hits free)
      const need = this.state.items.slice(0, MAX_TILES).filter((it) => !it.img);
      if (need.length) {
        const art = await fetchListingArt(need.map((it) => it.listingId));
        if (!this.alive || this.state.account !== account) return;
        this.setState((prev) => ({
          items: prev.items.map((it) => (art[it.listingId] && art[it.listingId].img
            ? { ...it, img: art[it.listingId].img, collection: art[it.listingId].collection, tokenId: art[it.listingId].tokenId }
            : it)),
        }));
      }
    } catch (e) { /* transient — next poll retries */ }
  }

  // Pull the fee earnings out: settle active listings' pending fees into the
  // withdrawable credit first (one tx, id list capped for gas), then withdraw.
  async withdrawEarnings() {
    const { account, items, pendingTotal, feeCredit } = this.state;
    if (!account || this.state.txBusy) return;
    try {
      if (pendingTotal > 0n && items.length) {
        this.setState({ txBusy: 'claiming', txError: null });
        const ids = items.slice(0, 120).map((it) => BigInt(it.listingId));
        const hash = await sendTx({
          from: account,
          to: FWA_ADDRESS,
          data: encodeData(SELECTORS.claimListingFees, [32n, BigInt(ids.length), ...ids]),
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('claim reverted');
      }
      if (feeCredit > 0n || pendingTotal > 0n) {
        this.setState({ txBusy: 'withdrawing', txError: null });
        const hash = await sendTx({
          from: account,
          to: FWA_ADDRESS,
          data: encodeData(SELECTORS.withdrawEarnings, []),
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('withdraw reverted');
      }
      if (!this.alive) return;
      this.lastSweep = 0; // re-total on the next poll
      this.setState({ txBusy: null, feeCredit: 0n, pendingTotal: 0n });
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ txBusy: null, txError: msg });
    }
  }

  // Harvest FWA rewards from the rewards module: settle each active listing's
  // accrual into your token credit (claimDepositorTokens), then withdrawTokens.
  async claimFwa() {
    const { account, items, fwaPendingTotal, fwaCredit } = this.state;
    const wiring = await this.loadWiring();
    if (!account || this.state.txBusy || !wiring || !wiring.rewards) return;
    try {
      if (fwaPendingTotal > 0n && items.length) {
        this.setState({ txBusy: 'claiming FWA', txError: null });
        const ids = items.filter((it) => it.fwaPending > 0n).slice(0, 120).map((it) => BigInt(it.listingId));
        const hash = await sendTx({
          from: account,
          to: wiring.rewards,
          data: encodeData(SELECTORS.claimDepositorTokens, [32n, BigInt(ids.length), ...ids]),
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('claim reverted');
      }
      if (fwaCredit > 0n || fwaPendingTotal > 0n) {
        this.setState({ txBusy: 'withdrawing FWA', txError: null });
        const hash = await sendTx({ from: account, to: wiring.rewards, data: encodeData(SELECTORS.withdrawTokens, []) });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('withdraw reverted');
      }
      if (!this.alive) return;
      this.lastSweep = 0;
      this.setState({ txBusy: null, fwaCredit: 0n, fwaPendingTotal: 0n });
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ txBusy: null, txError: msg });
    }
  }

  // Re-price ONE listing: updateBacking(id, newBacking) — send the shortfall
  // to raise, get the difference back to lower. Raising keeps crown tenure;
  // lowering forfeits it (and costs 1% inside the 12h commitment on V2).
  async reprice(it) {
    const { account, crown } = this.state;
    if (!account || this.state.txBusy) return;
    const isCrown = crown && crown.listingId === it.listingId;
    const lockedS = isCrown && crown.since ? Math.max(0, crown.since + CROWN_COMMITMENT_S - Date.now() / 1000) : 0;
    let hint = 'new backing in ETH for #' + it.listingId + ' (now ' + fmtEth(it.backing) + ')';
    if (IS_V2 && it.cap) hint += '\nV2 oracle ceiling for this collection: ' + fmtEth(it.cap) + ' ETH';
    if (lockedS > 0) hint += '\nthis is the crown, ' + fmtAge(lockedS) + ' into its 12h commitment: LOWERING it costs 1% of the current backing (raising is free)';
    const input = window.prompt(hint, fmtEth(it.backing));
    if (input === null) return;
    let newWei;
    try { newWei = BigInt(Math.round(parseFloat(input) * 1e6)) * 10n ** 12n; } catch (e) { return; }
    if (!(newWei > 0n) || newWei === it.backing) return;
    if (IS_V2 && it.cap && newWei > it.cap) {
      this.setState({ txError: 'that is above the oracle ceiling (' + fmtEth(it.cap) + ' ETH) — the contract would revert' });
      return;
    }
    try {
      this.setState({ txBusy: 'repricing #' + it.listingId, txError: null });
      const hash = await sendTx({
        from: account,
        to: FWA_ADDRESS,
        data: encodeData(SELECTORS.updateBacking, [BigInt(it.listingId), newWei]),
        value: newWei > it.backing ? newWei - it.backing : 0n,
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status === '0x0') throw new Error('reprice reverted');
      if (!this.alive) return;
      this.lastSweep = 0;
      this.setState((prev) => ({
        txBusy: null,
        items: prev.items.map((x) => (x.listingId === it.listingId ? { ...x, backing: newWei } : x)),
      }));
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ txBusy: null, txError: msg });
    }
  }

  // Pull ONE listing out of the pool — the NFT and its backing come home.
  async withdrawListing(listingId) {
    const { account } = this.state;
    if (!account || this.state.txBusy) return;
    try {
      this.setState({ txBusy: 'withdrawing #' + listingId, txError: null });
      const hash = await sendTx({
        from: account,
        to: FWA_ADDRESS,
        data: encodeData(SELECTORS.withdrawListing, [BigInt(listingId)]),
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status === '0x0') throw new Error('withdraw reverted');
      if (!this.alive) return;
      this.lastSweep = 0; // re-total earnings soon
      this.setState((prev) => ({
        txBusy: null,
        items: prev.items.filter((it) => it.listingId !== listingId),
      }));
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ txBusy: null, txError: msg });
    }
  }

  // an <img> whose load errored (burst-choked CDN, transient net) drops its
  // art so the poll retry re-resolves it — never a permanent placeholder
  artFailed(listingId) {
    if (!this.alive) return;
    this.setState((prev) => ({
      items: prev.items.map((it) => (it.listingId === listingId ? { ...it, img: null } : it)),
    }));
  }

  async ingest(account, logs, latest) {
    const fresh = [];
    for (const log of logs) {
      const listingId = topicNum(log.topics[1]);
      if (this.seen.has(listingId)) continue;
      this.seen.add(listingId);
      fresh.push({
        listingId,
        tx: log.transactionHash,
        bn: toNum(log.blockNumber),
        tsMs: Date.now() - (latest - toNum(log.blockNumber)) * 12000,
      });
    }
    if (!fresh.length) return;

    // keep only listings still active and still ours (word1 = depositor);
    // pendingFees rides the same batch so tiles can show what each earned
    const res = await rpcBatchSafe([
      ...fresh.map((f) => ethCall(SELECTORS.listings, [BigInt(f.listingId)])),
      ...fresh.map((f) => ethCall(SELECTORS.pendingFees, [BigInt(f.listingId)])),
    ]);
    const live = [];
    fresh.forEach((f, i) => {
      const raw = res[i];
      if (raw && word(raw, 10) === LISTING_ACTIVE
        && wordAddr(raw, 1).toLowerCase() === account.toLowerCase()) {
        const pendRaw = res[fresh.length + i];
        live.push({ ...f, collection: wordAddr(raw, 0), tokenId: word(raw, 3).toString(), backing: word(raw, 5), pending: pendRaw ? word(pendRaw, 0) : 0n, fwaPending: 0n, cap: undefined });
      }
    });
    if (!live.length || !this.alive || this.state.account !== account) return;

    await new Promise((resolve) => this.setState((prev) => ({
      items: prev.items.concat(live).sort((a, b) => b.bn - a.bn),
    }), resolve));

    // art only for tiles that can actually show
    const need = this.state.items.slice(0, MAX_TILES).filter((it) => !it.img);
    if (!need.length) return;
    const art = await fetchListingArt(need.map((it) => it.listingId));
    if (!this.alive || this.state.account !== account) return;
    this.setState((prev) => ({
      items: prev.items.map((it) => (art[it.listingId]
        ? { ...it, img: art[it.listingId].img, collection: art[it.listingId].collection, tokenId: art[it.listingId].tokenId }
        : it)),
    }));
  }

  render() {
    const { account, items, scanning, scannedBlocks, now, feeCredit, pendingTotal, fwaCredit, fwaPendingTotal, crown, txBusy, txError } = this.state;
    if (!account || (!items.length && !scanning)) return null;
    const total = items.reduce((sum, it) => sum + it.backing, 0n);
    const days = Math.max(1, Math.round(scannedBlocks / 7200));
    const earned = feeCredit + pendingTotal;
    const fwaEarned = fwaCredit + fwaPendingTotal;
    const crownLockLeftS = crown && crown.since && IS_V2 ? Math.max(0, crown.since + CROWN_COMMITMENT_S - now / 1000) : 0;
    return (
      <div className="card pull-ticker-card hv-card mine-card grid-margin">
        <div className="d-flex align-items-stretch">
          <div className="pull-ticker-head">
            <div className="pull-ticker-live hv-title mine-title"><i className="mdi mdi-treasure-chest"></i> YOUR DEPOSITS</div>
            <div className="pull-ticker-sub text-muted">
              {items.length} in the pool · {fmtEth(total, 3)} ETH backing
              {scanning ? ' · scanning…' : ' · last ' + days + 'd'}
            </div>
            {earned > 0n && (
              <button
                type="button"
                className="btn btn-outline-warning mine-withdraw"
                disabled={!!txBusy}
                title="your total FEE EARNINGS across all listings — settles pending fees into your credit, then withdraws (two wallet prompts). To pull an NFT itself out, use the ⏏ on its tile."
                onClick={() => this.withdrawEarnings()}
              >
                {txBusy ? txBusy + '…' : 'withdraw earnings · ' + fmtEth(earned) + ' ETH'}
              </button>
            )}
            {fwaEarned > 0n && (
              <button
                type="button"
                className="btn btn-outline-info mine-withdraw mt-1"
                disabled={!!txBusy}
                title="FWA rewards across your listings (weighted by √backing) — claims the accruals into your credit, then withdraws (up to two wallet prompts, both on the rewards module)"
                onClick={() => this.claimFwa()}
              >
                {txBusy && /FWA/.test(txBusy) ? txBusy + '…' : 'claim FWA · ' + fmtNum(Math.round(Number(fwaEarned) / 1e18))}
              </button>
            )}
            {txError && <div className="small text-danger mine-tx-error">{txError}</div>}
          </div>
          <div className="pull-ticker-strip">
            {items.length === 0
              ? <span className="text-muted pl-3">scanning your deposits…</span>
              : items.slice(0, MAX_TILES).map((it) => {
                const os = openSeaUrl(it.collection, it.tokenId);
                const isCrown = crown && crown.listingId === it.listingId;
                const overCap = IS_V2 && it.cap && it.backing > it.cap;
                let wdTitle = 'withdraw THIS listing — #' + it.listingId + ' leaves the pool, NFT + ' + fmtEth(it.backing, 3) + ' ETH backing return to you';
                if (isCrown && crownLockLeftS > 0) wdTitle += '. CROWN COMMITMENT: leaving within 12h of taking the crown costs 1% (' + fmtEth(it.backing / 100n, 4) + ' ETH) — free in ' + fmtAge(crownLockLeftS);
                return (
                <div key={it.listingId} className="pull-tilewrap">
                  {isCrown && (
                    <span className={'crown-badge ' + (crownLockLeftS > 0 ? 'text-warning' : 'text-success')} title={'your listing holds the crown' + (crownLockLeftS > 0 ? ' — ' + fmtAge(crownLockLeftS) + ' left on the 12h commitment (early exit costs 1%)' : IS_V2 ? ' — commitment served, free to leave' : '')}>
                      <i className="mdi mdi-crown"></i>
                    </span>
                  )}
                  {overCap && (
                    <span className="cap-badge text-danger" title={'backing ' + fmtEth(it.backing, 3) + ' ETH is above this collection\'s oracle ceiling (' + fmtEth(it.cap, 3) + ' ETH) — anyone can kick it during a purchase pause (11:45 / 23:45 UTC). You get NFT + full backing back, but lose the spot. Reprice below the ceiling to stay.'}>
                      <i className="mdi mdi-alert"></i>
                    </span>
                  )}
                  <a
                    className="pull-ticker-item hv-item"
                    href={ETHERSCAN + '/tx/' + it.tx}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={'your listing #' + it.listingId + ' — backing ' + fmtEth(it.backing) + ' ETH'}
                  >
                    {it.img
                      ? <img className="pull-ticker-art hv-art" src={it.img} alt="" loading="lazy" decoding="async" onError={() => this.artFailed(it.listingId)} />
                      : (
                        <div className="pull-ticker-art hv-art pull-ticker-art-placeholder">
                          <i className="mdi mdi-treasure-chest text-warning"></i>
                        </div>
                      )}
                    <span className="hv-eth mine-eth">{fmtEth(it.backing, 3)} ETH</span>
                    <span
                      className={'mine-pl ' + (it.pending > 0n ? 'text-success' : 'text-muted')}
                      title={'fees this listing has earned so far, on its ' + fmtEth(it.backing, 3) + ' ETH backing'}
                    >
                      {it.pending > 0n
                        ? '+' + fmtEth(it.pending) + ' · ' + (Number(it.pending * 10000n / it.backing) / 100).toFixed(1) + '%'
                        : '±0'}
                    </span>
                    <span className="small text-muted">#{it.listingId}</span>
                    <span className="pull-ticker-age">{fmtAge(Math.max(0, (now - it.tsMs) / 1000))} ago</span>
                  </a>
                  {os && (
                    <a className="os-badge" href={os} target="_blank" rel="noopener noreferrer" title="view on OpenSea">
                      <i className="mdi mdi-ship-wheel"></i>
                    </a>
                  )}
                  <button
                    type="button"
                    className="wd-badge"
                    disabled={!!txBusy}
                    title={wdTitle}
                    onClick={() => this.withdrawListing(it.listingId)}
                  >
                    <i className="mdi mdi-eject"></i>
                  </button>
                  <button
                    type="button"
                    className="rp-badge"
                    disabled={!!txBusy}
                    title={'re-price #' + it.listingId + ' — change its ETH backing (raise: pay the difference; lower: get it back). Lower backing = pulled sooner, higher = longer in the pool' + (IS_V2 && it.cap ? ' · ceiling ' + fmtEth(it.cap, 3) + ' ETH' : '')}
                    onClick={() => this.reprice(it)}
                  >
                    <i className="mdi mdi-swap-vertical"></i>
                  </button>
                </div>
                );
              })}
          </div>
        </div>
      </div>
    );
  }
}

export default MyDeposits;
