import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS,
  rpcBatch, rpcBatchSafe, ethCall, addrTopic, encodeData,
  toNum, word, wordAddr, topicNum,
  fmtEth, fmtAge, fetchListingArt, openSeaUrl, POLL,
} from '../fwa/fwa';
import { injected, onAccountsChanged, sendTx, waitForReceipt } from '../fwa/wallet';

const POLL_MS = POLL.account;
const CHUNK_BLOCKS = 7200; // 24h per getLogs call — under node range/result caps
const MAX_SCAN_BLOCKS = 50400; // ~7d; pruned nodes stop the walk early anyway
const MAX_TILES = 48; // whale guard: count/total cover everything, tiles don't
const LISTING_ACTIVE = 1n;

// Your NFTs currently in the pool. NFTListed indexes the depositor, so one
// filtered log scan finds your listings without touching every collection:
// the newest day paints first, then the walk deepens to ~7d in the background,
// and each poll re-checks statuses (pulled NFTs drop out) + picks up new
// deposits incrementally.
export class MyDeposits extends Component {
  state = { account: null, items: [], scanning: false, scannedBlocks: 0, now: Date.now(), feeCredit: 0n, pendingTotal: 0n, txBusy: null, txError: null };

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
        const res = await rpcBatchSafe([
          ...items.map((it) => ethCall(SELECTORS.listings, [BigInt(it.listingId)])),
          ...items.map((it) => ethCall(SELECTORS.pendingFees, [BigInt(it.listingId)])),
          ethCall(SELECTORS.feeCredit, [account]),
        ]);
        const gone = new Set();
        let pendingTotal = 0n;
        items.forEach((it, i) => {
          const raw = res[i];
          if (!raw || word(raw, 10) !== LISTING_ACTIVE
            || wordAddr(raw, 1).toLowerCase() !== account.toLowerCase()) gone.add(it.listingId);
          else if (res[items.length + i]) pendingTotal += word(res[items.length + i], 0);
        });
        const creditRaw = res[items.length * 2];
        if (this.alive && this.state.account === account) {
          this.setState((prev) => ({
            items: gone.size ? prev.items.filter((it) => !gone.has(it.listingId)) : prev.items,
            pendingTotal,
            feeCredit: creditRaw ? word(creditRaw, 0) : prev.feeCredit,
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

    // keep only listings still active and still ours (word1 = depositor)
    const res = await rpcBatchSafe(fresh.map((f) => ethCall(SELECTORS.listings, [BigInt(f.listingId)])));
    const live = [];
    fresh.forEach((f, i) => {
      const raw = res[i];
      if (raw && word(raw, 10) === LISTING_ACTIVE
        && wordAddr(raw, 1).toLowerCase() === account.toLowerCase()) {
        live.push({ ...f, backing: word(raw, 5) });
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
    const { account, items, scanning, scannedBlocks, now, feeCredit, pendingTotal, txBusy, txError } = this.state;
    if (!account || (!items.length && !scanning)) return null;
    const total = items.reduce((sum, it) => sum + it.backing, 0n);
    const days = Math.max(1, Math.round(scannedBlocks / 7200));
    const earned = feeCredit + pendingTotal;
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
                title="settles pending fees into your credit, then withdraws it (two wallet prompts)"
                onClick={() => this.withdrawEarnings()}
              >
                {txBusy ? txBusy + '…' : 'withdraw ' + fmtEth(earned) + ' ETH'}
              </button>
            )}
            {txError && <div className="small text-danger mine-tx-error">{txError}</div>}
          </div>
          <div className="pull-ticker-strip">
            {items.length === 0
              ? <span className="text-muted pl-3">scanning your deposits…</span>
              : items.slice(0, MAX_TILES).map((it) => {
                const os = openSeaUrl(it.collection, it.tokenId);
                return (
                <div key={it.listingId} className="pull-tilewrap">
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
                    <span className="small text-muted">#{it.listingId}</span>
                    <span className="pull-ticker-age">{fmtAge(Math.max(0, (now - it.tsMs) / 1000))} ago</span>
                  </a>
                  {os && (
                    <a className="os-badge" href={os} target="_blank" rel="noopener noreferrer" title="view on OpenSea">
                      <i className="mdi mdi-ship-wheel"></i>
                    </a>
                  )}
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
