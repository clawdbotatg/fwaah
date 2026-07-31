import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, TOPICS,
  rpcBatch, toNum, word,
  fmtEth, fmtAge, topicAddr, topicNum,
  fetchListingArt, openSeaUrl, POLL,
} from '../fwa/fwa';
import FwaAddress from '../fwa/FwaAddress';

const POLL_MS = POLL.highValue;
const WINDOW_HOURS = 24;
const WINDOW_BLOCKS = WINDOW_HOURS * 300; // 12s blocks
const CHUNKS = 4;
const MAX_TILES = 16;

// Latest NFTs deposited into the pool (NFTListed), newest first.
export class RecentDeposits extends Component {
  state = { items: [], now: Date.now() };

  componentDidMount() {
    this.alive = true;
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), POLL_MS);
    this.ageTimer = setInterval(() => this.setState({ now: Date.now() }), 5000);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.pollTimer);
    clearInterval(this.ageTimer);
  }

  async refresh() {
    try {
      const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
      const latest = toNum(latestHex);
      // range chunks keep each call safely under the node's log caps
      const start = Math.max(latest - WINDOW_BLOCKS, 0);
      const chunkSize = Math.ceil((latest - start + 1) / CHUNKS);
      const ranges = [];
      for (let from = start; from <= latest; from += chunkSize) {
        ranges.push([from, Math.min(from + chunkSize - 1, latest)]);
      }
      const chunks = await rpcBatch(ranges.map(([from, to]) => [
        'eth_getLogs',
        [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16),
          topics: [[TOPICS.NFTListed]],
        }],
      ]));
      const nowMs = Date.now();
      const deposits = [].concat(...chunks).map((log) => {
        const bn = toNum(log.blockNumber);
        return {
          key: log.transactionHash + log.logIndex,
          listingId: topicNum(log.topics[1]),
          depositor: topicAddr(log.topics[3]),
          backing: word(log.data, 3),
          tx: log.transactionHash,
          bn,
          li: toNum(log.logIndex),
          tsMs: nowMs - (latest - bn) * 12000,
        };
      });

      deposits.sort((a, b) => (b.bn - a.bn) || (b.li - a.li));
      const top = deposits.slice(0, MAX_TILES);
      if (!this.alive) return;
      this.setState({ items: top });

      const art = await fetchListingArt(top.map((it) => it.listingId));
      if (!this.alive) return;
      this.setState((prev) => ({
        items: prev.items.map((it) => (art[it.listingId]
          ? { ...it, img: art[it.listingId].img, collection: art[it.listingId].collection, tokenId: art[it.listingId].tokenId }
          : it)),
      }));
    } catch (e) { /* retry on the next poll */ }
  }

  // failed art clears state so React swaps the placeholder itself — never
  // mutate the DOM under React (outerHTML swaps crash later unmounts)
  artFailed(key) {
    if (!this.alive) return;
    this.setState((prev) => ({
      items: prev.items.map((it) => (it.key === key ? { ...it, img: null } : it)),
    }));
  }

  render() {
    const { items, now } = this.state;
    return (
      <div className="card pull-ticker-card hv-card dep-card grid-margin">
        <div className="d-flex align-items-stretch">
          <div className="pull-ticker-head">
            <div className="pull-ticker-live hv-title dep-title"><i className="mdi mdi-tray-arrow-down"></i> DEPOSITS</div>
            <div className="pull-ticker-sub text-muted">newest listings · last {WINDOW_HOURS}h</div>
          </div>
          <div className="pull-ticker-strip">
            {items.length === 0
              ? <span className="text-muted pl-3">scanning for deposits…</span>
              : items.map((it) => {
                const os = openSeaUrl(it.collection, it.tokenId);
                return (
                <div key={it.key} className="pull-tilewrap">
                  <a
                    className="pull-ticker-item hv-item"
                    href={ETHERSCAN + '/tx/' + it.tx}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={'listing #' + it.listingId + ' deposited — backing ' + fmtEth(it.backing) + ' ETH'}
                  >
                    {it.img
                      ? <img className="pull-ticker-art hv-art" src={it.img} alt="" onError={() => this.artFailed(it.key)} />
                      : (
                        <div className="pull-ticker-art hv-art pull-ticker-art-placeholder">
                          <i className="mdi mdi-image text-info"></i>
                        </div>
                      )}
                    <span className="hv-eth text-info">{fmtEth(it.backing, 3)} ETH</span>
                    <FwaAddress address={it.depositor} size="xs" noLink />
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

export default RecentDeposits;
