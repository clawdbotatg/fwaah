import React, { Component } from 'react';
import {
  FWA_ADDRESS, ETHERSCAN, SELECTORS, TOPICS,
  rpcBatch, rpcBatchSafe, ethCall, encodeData, addrTopic,
  toBig, toNum, word, wordAddr, topicNum,
  fmtEth, fetchListingArt, POLL,
} from '../fwa/fwa';
import { injected, connectWallet, onAccountsChanged, sendTx, waitForReceipt } from '../fwa/wallet';
import FwaAddress from '../fwa/FwaAddress';

const REFRESH_MS = POLL.account;
const BPS = 10000n;
const REQ_SCAN_BLOCKS = 7200; // my pulls, last ~24h
const WON_SCAN_BLOCKS = 50400; // my unresolved wins, last ~7d (finalize window)

// AcquisitionStatus enum indices (see FWA.sol)
const ACQ_PENDING = 1n;
const ACQ_READY = 5n;
// ListingStatus.Allocated
const LISTING_ALLOCATED = 2n;

export class PullPanel extends Component {
  state = {
    account: null,
    quote: null, // { fee, vrf, total }
    discountBps: null,
    waiting: [], // my requests still waiting on VRF / ordered settlement
    won: [], // my allocated listings awaiting the keep/eth/tokens choice
    refundCredit: 0n,
    busy: null, // label of the action in flight
    txHash: null,
    error: null,
  };

  componentDidMount() {
    this.alive = true;
    this.refreshQuote();
    this.quoteTimer = setInterval(() => this.refreshQuote(), REFRESH_MS);
    onAccountsChanged((accounts) => {
      if (!this.alive) return;
      this.setState({ account: accounts && accounts[0] ? accounts[0] : null, waiting: [], won: [] });
      if (accounts && accounts[0]) this.refreshAccount(accounts[0]);
    });
    // silently reconnect if the wallet is already authorized; retry briefly in
    // case the provider injects after we mount
    const tryReconnect = (attempts) => {
      const eth = injected();
      if (eth) {
        eth.request({ method: 'eth_accounts' }).then((accounts) => {
          if (this.alive && accounts && accounts[0] && !this.state.account) {
            this.setState({ account: accounts[0] });
            this.refreshAccount(accounts[0]);
          }
        }).catch(() => {});
      }
      if (attempts > 0 && !this.state.account) {
        setTimeout(() => this.alive && tryReconnect(attempts - 1), 1000);
      }
    };
    tryReconnect(3);
    this.accountTimer = setInterval(() => {
      if (this.state.account) this.refreshAccount(this.state.account);
    }, REFRESH_MS);
  }

  componentWillUnmount() {
    this.alive = false;
    clearInterval(this.quoteTimer);
    clearInterval(this.accountTimer);
  }

  async refreshQuote() {
    try {
      const [block] = await rpcBatch([['eth_getBlockByNumber', ['latest', false]]]);
      const gasPrice = toBig(block.baseFeePerGas || '0x3b9aca00') * 3n; // vrf fee scales with tx.gasprice
      const [quoteRaw, discountRaw] = await rpcBatch([
        ethCall(SELECTORS.quoteAcquisitionPrice, [], { gasPrice: '0x' + gasPrice.toString(16) }),
        ethCall(SELECTORS.settlementDiscountBps),
      ]);
      if (!this.alive) return;
      this.setState({
        quote: { fee: word(quoteRaw, 0), vrf: word(quoteRaw, 1), total: word(quoteRaw, 2) },
        discountBps: toBig(discountRaw),
      });
    } catch (e) {
      if (this.alive) this.setState({ error: 'quote failed: ' + (e.message || e) });
    }
  }

  async refreshAccount(account) {
    try {
      const [latestHex, refundRaw] = await rpcBatch([
        ['eth_blockNumber', []],
        ethCall(SELECTORS.acquisitionRefundCredit, [account]),
      ]);
      const latest = toNum(latestHex);
      const [reqLogs, wonLogs] = await rpcBatch([
        ['eth_getLogs', [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + Math.max(latest - REQ_SCAN_BLOCKS, 0).toString(16),
          toBlock: 'latest',
          topics: [[TOPICS.AcquisitionRequested], null, addrTopic(account)],
        }]],
        ['eth_getLogs', [{
          address: FWA_ADDRESS,
          fromBlock: '0x' + Math.max(latest - WON_SCAN_BLOCKS, 0).toString(16),
          toBlock: 'latest',
          topics: [[TOPICS.NFTAllocated], null, null, addrTopic(account)],
        }]],
      ]);

      // requests still in flight
      const requestIds = reqLogs.map((l) => toBig(l.topics[1]));
      let waiting = [];
      if (requestIds.length) {
        const acqRes = await rpcBatchSafe(requestIds.map((id) => ethCall(SELECTORS.acquisitions, [id])));
        waiting = requestIds
          .map((id, i) => ({ id, raw: acqRes[i] }))
          .filter((r) => r.raw && (word(r.raw, 4) === ACQ_PENDING || word(r.raw, 4) === ACQ_READY))
          .map((r) => ({
            requestId: r.id.toString(),
            status: word(r.raw, 4) === ACQ_PENDING ? 'waiting for VRF' : 'word cached — settling',
          }));
      }

      // allocated listings still awaiting my choice
      const listingIds = [...new Set(wonLogs.map((l) => topicNum(l.topics[2])))];
      let won = [];
      if (listingIds.length) {
        const listRes = await rpcBatchSafe(listingIds.map((id) => ethCall(SELECTORS.listings, [BigInt(id)])));
        won = listingIds
          .map((id, i) => ({ id, raw: listRes[i] }))
          .filter((r) => r.raw && word(r.raw, 10) === LISTING_ALLOCATED
            && wordAddr(r.raw, 2).toLowerCase() === account.toLowerCase())
          .map((r) => ({
            listingId: r.id,
            backing: word(r.raw, 5),
            allocatedAt: Number(word(r.raw, 9)),
            tokenQuote: null,
            img: null,
          }));
        // quote the token payout by simulating acceptBidAsTokens from the purchaser
        const tokenRes = await rpcBatchSafe(won.map((w) =>
          ethCall(SELECTORS.acceptBidAsTokens, [BigInt(w.listingId), 0n], { from: account })
        ));
        won.forEach((w, i) => {
          if (tokenRes[i] && tokenRes[i] !== '0x') w.tokenQuote = word(tokenRes[i], 0);
        });
      }

      if (!this.alive) return;
      this.setState({ waiting, won, refundCredit: toBig(refundRaw), error: null });

      if (won.length) {
        const art = await fetchListingArt(won.map((w) => w.listingId));
        if (!this.alive) return;
        this.setState((prev) => ({
          won: prev.won.map((w) => (art[w.listingId]
            ? { ...w, img: art[w.listingId].img, collection: art[w.listingId].collection, tokenId: art[w.listingId].tokenId }
            : w)),
        }));
      }
    } catch (e) {
      if (this.alive) this.setState({ error: String(e.message || e) });
    }
  }

  async connect() {
    try {
      const account = await connectWallet();
      this.setState({ account, error: null });
      this.refreshAccount(account);
    } catch (e) {
      this.setState({ error: String(e.message || e) });
    }
  }

  // Wrap a wallet action: send, watch the receipt on the local node, refresh.
  async runTx(label, txParams) {
    const { account } = this.state;
    this.setState({ busy: label, txHash: null, error: null });
    try {
      const hash = await sendTx({ from: account, to: FWA_ADDRESS, ...txParams });
      this.setState({ txHash: hash });
      const receipt = await waitForReceipt(hash);
      if (receipt.status === '0x0') throw new Error('transaction reverted');
      this.setState({ busy: null, txHash: null });
      this.refreshAccount(account);
      this.refreshQuote();
    } catch (e) {
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ busy: null, error: label + ': ' + msg });
    }
  }

  pull() {
    const { quote } = this.state;
    if (!quote) return;
    // protect against a fee shift between quote and inclusion; overpay is refunded in-tx
    const maxFee = quote.fee * 105n / 100n;
    const value = maxFee + quote.vrf * 2n;
    this.runTx('pull', { data: encodeData(SELECTORS.acquire, [maxFee, 0n]), value });
  }

  keepNFT(w) {
    this.runTx('keep NFT #' + w.listingId, { data: encodeData(SELECTORS.keepNFT, [BigInt(w.listingId)]) });
  }

  takeEth(w) {
    this.runTx('take ETH for #' + w.listingId, { data: encodeData(SELECTORS.acceptDepositorBid, [BigInt(w.listingId)]) });
  }

  takeTokens(w) {
    const minOut = w.tokenQuote ? w.tokenQuote * 95n / 100n : 0n;
    this.runTx('take FWA for #' + w.listingId, { data: encodeData(SELECTORS.acceptBidAsTokens, [BigInt(w.listingId), minOut]) });
  }

  withdrawRefund() {
    this.runTx('withdraw refund', { data: encodeData(SELECTORS.withdrawAcquisitionRefund, []) });
  }

  render() {
    const { account, quote, discountBps, waiting, won, refundCredit, busy, txHash, error } = this.state;
    const hasWallet = !!injected();

    return (
      <div className="card grid-margin pull-panel">
        <div className="card-body py-3">
          <div className="d-flex flex-wrap align-items-center justify-content-between">
            <div className="d-flex align-items-center">
              <h4 className="mb-0 mr-3"><i className="mdi mdi-dice-5 text-success"></i> Pull from the pool</h4>
              {quote && (
                <span className="text-muted small">
                  price <strong className="text-white">{fmtEth(quote.total)} ETH</strong>
                  <span className="d-none d-md-inline"> (pool fee {fmtEth(quote.fee)} + vrf {fmtEth(quote.vrf)})</span>
                </span>
              )}
            </div>
            <div className="d-flex align-items-center">
              {account
                ? <span className="mr-3"><FwaAddress address={account} size="sm" /></span>
                : (
                  <button className="btn btn-sm btn-outline-primary mr-3" onClick={() => this.connect()} disabled={!hasWallet}>
                    <i className="mdi mdi-wallet"></i> {hasWallet ? 'Connect Wallet' : 'No wallet found'}
                  </button>
                )}
              <button
                className="btn btn-success font-weight-bold"
                disabled={!account || !quote || !!busy}
                onClick={() => this.pull()}
              >
                <i className="mdi mdi-dice-multiple"></i> {busy === 'pull' ? 'PULLING…' : 'PULL'}
              </button>
            </div>
          </div>

          {(busy || txHash || error) && (
            <p className="small mb-0 mt-2">
              {busy && <span className="text-warning"><i className="mdi mdi-loading mdi-spin"></i> {busy}{txHash ? ' — ' : '…'}</span>}
              {txHash && <a href={ETHERSCAN + '/tx/' + txHash} target="_blank" rel="noopener noreferrer">{txHash.slice(0, 14)}…</a>}
              {error && <span className="text-danger"><i className="mdi mdi-alert-circle"></i> {error}</span>}
            </p>
          )}

          {account && refundCredit > 0n && (
            <p className="small mb-0 mt-2">
              <span className="text-info">you have a {fmtEth(refundCredit)} ETH pull refund waiting</span>
              <button className="btn btn-xs btn-outline-info ml-2 py-0" disabled={!!busy} onClick={() => this.withdrawRefund()}>withdraw</button>
            </p>
          )}

          {account && waiting.length > 0 && (
            <p className="small mb-0 mt-2 text-muted">
              {waiting.map((wq) => (
                <span key={wq.requestId} className="badge badge-outline-warning mr-2">
                  <i className="mdi mdi-timer-sand"></i> pull {wq.requestId.slice(0, 8)}… {wq.status}
                </span>
              ))}
            </p>
          )}

          {account && won.length > 0 && (
            <div className="mt-3">
              <p className="text-muted small mb-2">YOU WON — choose how to take it:</p>
              <div className="d-flex flex-wrap">
                {won.map((w) => {
                  // check the floor/offers before choosing keep vs ETH vs tokens
                  const osUrl = w.collection
                    ? 'https://opensea.io/assets/ethereum/' + w.collection + '/' + w.tokenId
                    : null;
                  return (
                  <div key={w.listingId} className="pull-panel-win mr-3 mb-2">
                    {w.img
                      ? (osUrl
                        ? <a href={osUrl} target="_blank" rel="noopener noreferrer"><img className="pull-ticker-art hv-art" src={w.img} alt="" /></a>
                        : <img className="pull-ticker-art hv-art" src={w.img} alt="" />)
                      : <div className="pull-ticker-art hv-art pull-ticker-art-placeholder"><i className="mdi mdi-trophy text-warning"></i></div>}
                    <p className="small text-center mb-1 mt-1">
                      #{w.listingId} · backing <strong>{fmtEth(w.backing, 3)} ETH</strong>
                      {osUrl && (
                        <>
                          {' · '}
                          <a href={osUrl} target="_blank" rel="noopener noreferrer">
                            OpenSea <i className="mdi mdi-open-in-new"></i>
                          </a>
                        </>
                      )}
                    </p>
                    <button className="btn btn-sm btn-outline-primary btn-block mb-1" disabled={!!busy} onClick={() => this.keepNFT(w)}>
                      <i className="mdi mdi-image"></i> Keep the NFT
                    </button>
                    <button className="btn btn-sm btn-outline-success btn-block mb-1" disabled={!!busy} onClick={() => this.takeEth(w)}>
                      <i className="mdi mdi-ethereum"></i> Take {discountBps ? fmtEth(w.backing * discountBps / BPS, 3) : '…'} ETH
                    </button>
                    <button className="btn btn-sm btn-outline-warning btn-block" disabled={!!busy || w.tokenQuote === null} onClick={() => this.takeTokens(w)}>
                      <i className="mdi mdi-alpha-f-circle"></i> Take {w.tokenQuote !== null ? '~' + fmtEth(w.tokenQuote, 1) : '…'} FWA
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {!account && (
            <p className="text-muted small mb-0 mt-2">
              connect a wallet to pull — the wallet signs, this page never touches your keys;
              reads and receipts come from your own node
            </p>
          )}
        </div>
      </div>
    );
  }
}

export default PullPanel;
