import React, { Component } from 'react';
import {
  FWA_ADDRESS, SELECTORS, WHITELIST_SNAPSHOT, KNOB_SNAPSHOT,
  rpcBatch, rpcBatchSafe, ethCall, ethCallTo, encodeData, word, wordAddr, addrTopic, toNum,
  fmtEth,
} from '../fwa/fwa';
import { injected, onAccountsChanged, autoReconnectAllowed, sendTx, waitForReceipt } from '../fwa/wallet';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // event topic hash (public) — gitleaks:allow
const MAX_OWNED_SHOWN = 60;
const MAX_VERIFY = 200; // ownerOf checks per transfer-scan (newest receipts first)

// Deposit an NFT into the pool: pick a whitelisted collection, pick one of
// your tokens from a select populated by fetchOwned's strategy chain, choose
// the ETH backing. Ownership/whitelist/approval are verified with cheap
// eth_calls before any transaction; approve → listNFT (backing = msg.value).
export class DepositPanel extends Component {
  state = {
    account: null,
    collection: WHITELIST_SNAPSHOT[0][0],
    tokenId: '',
    backing: '',
    owned: null, // null = loading · {total, ids, partial, scanFailed}
    busy: null,
    error: null,
    done: null,
  };

  componentDidMount() {
    this.alive = true;
    this.offAccounts = onAccountsChanged((accounts) => {
      if (!this.alive) return;
      const account = accounts && accounts[0] ? accounts[0] : null;
      this.setState({ account, error: null, done: null, owned: null, tokenId: '' });
      if (account) this.fetchOwned(account, this.state.collection);
    });
    const eth = injected();
    if (eth && autoReconnectAllowed()) {
      eth.request({ method: 'eth_accounts' }).then((accounts) => {
        if (this.alive && accounts && accounts[0] && !this.state.account) {
          this.setState({ account: accounts[0] });
          this.fetchOwned(accounts[0], this.state.collection);
        }
      }).catch(() => { /* locked */ });
    }
  }

  componentWillUnmount() {
    this.alive = false;
    this.offAccounts();
  }

  pickCollection(collection) {
    this.setState({ collection, tokenId: '', owned: null, error: null, done: null });
    if (this.state.account) this.fetchOwned(this.state.account, collection);
  }

  stale(account, collection) {
    return !this.alive || this.state.account !== account || this.state.collection !== collection;
  }

  // Which of this collection's tokens does the wallet hold? Three strategies,
  // cheapest first — every one is plain eth_call/eth_getLogs, no indexer:
  //   1. tokensOfOwner(owner)            — one call (ERC721AQueryable, Punks721)
  //   2. balanceOf + tokenOfOwnerByIndex — batched (ERC721Enumerable)
  //   3. Transfer-log scan → ownerOf     — universal; full-history on hosted
  //      RPCs, the node's retained window on pruned home nodes
  async fetchOwned(account, collection) {
    try {
      const [tooRaw, balRaw] = await rpcBatchSafe([
        ethCallTo(collection, SELECTORS.tokensOfOwner, [account]),
        ethCallTo(collection, SELECTORS.balanceOf, [account]),
      ]);
      if (this.stale(account, collection)) return;
      const total = balRaw ? Number(word(balRaw, 0)) : null;
      if (total === 0) { this.setState({ owned: { total: 0, ids: [], partial: false } }); return; }

      // 1. one-call array
      if (tooRaw && tooRaw.length >= 130) {
        const len = Number(word(tooRaw, 1));
        const ids = Array.from({ length: Math.min(len, MAX_OWNED_SHOWN) }, (_, i) => word(tooRaw, 2 + i).toString());
        this.setState({ owned: { total: len, ids, partial: false } });
        return;
      }

      // 2. enumerable
      if (total !== null && total > 0) {
        const count = Math.min(total, MAX_OWNED_SHOWN);
        const idRes = await rpcBatchSafe(Array.from({ length: count }, (_, i) => (
          ethCallTo(collection, SELECTORS.tokenOfOwnerByIndex, [account, BigInt(i)])
        )));
        if (this.stale(account, collection)) return;
        const ids = idRes.filter((r) => r && r !== '0x').map((r) => word(r, 0).toString());
        if (ids.length > 0) {
          this.setState({ owned: { total, ids, partial: false } });
          return;
        }
      }

      // 3. transfer scan: every tokenId this wallet ever received, verified
      // against ownerOf so sold/deposited ones drop out
      let logs = null;
      let partial = false;
      const scan = (fromBlock) => rpcBatch([['eth_getLogs', [{
        address: collection, fromBlock, toBlock: 'latest',
        topics: [TRANSFER_TOPIC, null, addrTopic(account)],
      }]]]).then(([l]) => l);
      try {
        logs = await scan('0x0');
      } catch (e) {
        // pruned home node — take whatever window it still has
        try {
          const [latestHex] = await rpcBatch([['eth_blockNumber', []]]);
          logs = await scan('0x' + Math.max(toNum(latestHex) - 99000, 0).toString(16));
          partial = true;
        } catch (e2) { logs = null; }
      }
      if (this.stale(account, collection)) return;
      if (!logs) { this.setState({ owned: { total, ids: [], partial: true, scanFailed: true } }); return; }
      const seen = new Set();
      const candidates = [];
      for (let i = logs.length - 1; i >= 0; i--) { // newest receipts first
        const t = logs[i].topics;
        if (!t || t.length !== 4) continue;
        const id = word(t[3], 0).toString();
        if (!seen.has(id)) { seen.add(id); candidates.push(id); }
      }
      const check = candidates.slice(0, MAX_VERIFY);
      const owners = await rpcBatchSafe(check.map((id) => ethCallTo(collection, SELECTORS.ownerOf, [BigInt(id)])));
      if (this.stale(account, collection)) return;
      const ids = check.filter((id, i) => owners[i] && wordAddr(owners[i], 0).toLowerCase() === account.toLowerCase())
        .slice(0, MAX_OWNED_SHOWN);
      this.setState({ owned: { total: total !== null ? total : ids.length, ids, partial: partial || candidates.length > MAX_VERIFY } });
    } catch (e) {
      if (this.alive) this.setState({ owned: { total: null, ids: [], partial: true, scanFailed: true } });
    }
  }

  async deposit() {
    const { account, collection, tokenId, backing } = this.state;
    if (!account || this.state.busy) return;
    let id;
    let backingWei;
    try {
      id = BigInt(tokenId.trim());
      backingWei = BigInt(Math.round(parseFloat(backing) * 1e6)) * 10n ** 12n;
    } catch (e) {
      this.setState({ error: 'tokenId and backing must be numbers' });
      return;
    }
    if (backingWei < KNOB_SNAPSHOT.minBacking) {
      this.setState({ error: 'backing below the ' + fmtEth(KNOB_SNAPSHOT.minBacking) + ' ETH minimum' });
      return;
    }
    try {
      this.setState({ busy: 'checking', error: null, done: null });
      const [ownerRaw, approvedRaw, allRaw, wlRaw] = await rpcBatchSafe([
        ethCallTo(collection, SELECTORS.ownerOf, [id]),
        ethCallTo(collection, SELECTORS.getApproved, [id]),
        ethCallTo(collection, SELECTORS.isApprovedForAll, [account, FWA_ADDRESS]),
        ethCall(SELECTORS.collectionWhitelisted, [collection]),
      ]);
      if (!ownerRaw) throw new Error("that tokenId doesn't exist in this collection");
      if (wordAddr(ownerRaw, 0).toLowerCase() !== account.toLowerCase()) {
        throw new Error("you don't own that token");
      }
      if (!wlRaw || word(wlRaw, 0) !== 1n) {
        throw new Error('collection is not whitelisted for deposits');
      }
      const approved = (approvedRaw && wordAddr(approvedRaw, 0).toLowerCase() === FWA_ADDRESS.toLowerCase())
        || (allRaw && word(allRaw, 0) === 1n);
      if (!approved) {
        this.setState({ busy: 'approving' });
        const hash = await sendTx({
          from: account,
          to: collection,
          data: encodeData(SELECTORS.approve, [FWA_ADDRESS, id]),
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status === '0x0') throw new Error('approval reverted');
      }
      this.setState({ busy: 'depositing' });
      const hash = await sendTx({
        from: account,
        to: FWA_ADDRESS,
        data: encodeData(SELECTORS.listNFT, [collection, id]),
        value: backingWei,
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status === '0x0') throw new Error('deposit reverted');
      if (!this.alive) return;
      this.setState({ busy: null, done: '#' + id.toString() + ' is in the pool — it will appear in YOUR DEPOSITS shortly', tokenId: '', backing: '' });
    } catch (e) {
      if (!this.alive) return;
      const msg = e && e.code === 4001 ? 'rejected in wallet' : String((e && e.message) || e);
      this.setState({ busy: null, error: msg });
    }
  }

  render() {
    const { account, collection, tokenId, backing, owned, busy, error, done } = this.state;
    return (
      <div className="card deposit-card grid-margin">
        <div className="card-body py-3">
          <div className="d-flex flex-wrap align-items-end deposit-row">
            <div className="deposit-title mr-3">
              <div className="pull-ticker-live"><i className="mdi mdi-tray-arrow-down"></i> DEPOSIT AN NFT</div>
            </div>
            {account ? (
              <React.Fragment>
                <div className="form-group mb-0 mr-2">
                  <label className="small text-muted mb-1">collection</label>
                  <select
                    className="form-control form-control-sm deposit-select"
                    value={collection}
                    onChange={(e) => this.pickCollection(e.target.value)}
                  >
                    {WHITELIST_SNAPSHOT.map(([addr, name]) => <option key={addr} value={addr}>{name}</option>)}
                  </select>
                </div>
                {owned && owned.ids.length > 0 && (
                  <div className="form-group mb-0 mr-2">
                    <label className="small text-muted mb-1">
                      your token ({owned.total}{owned.partial || owned.total > owned.ids.length ? ', first ' + owned.ids.length + ' shown' : ''})
                    </label>
                    <select
                      className="form-control form-control-sm deposit-input"
                      value={tokenId}
                      onChange={(e) => this.setState({ tokenId: e.target.value, error: null, done: null })}
                    >
                      <option value="">pick one…</option>
                      {owned.ids.map((id) => <option key={id} value={id}>#{id}</option>)}
                    </select>
                  </div>
                )}
                {!owned && (
                  <div className="form-group mb-0 mr-2">
                    <label className="small text-muted mb-1">your token</label>
                    <span className="form-control-plaintext form-control-sm text-muted deposit-input">looking…</span>
                  </div>
                )}
                {owned && owned.ids.length === 0 && owned.scanFailed && (
                  <div className="form-group mb-0 mr-2">
                    <label className="small text-muted mb-1">tokenId (holdings scan unavailable on this RPC)</label>
                    <input
                      className="form-control form-control-sm deposit-input"
                      placeholder="e.g. 202"
                      value={tokenId}
                      onChange={(e) => this.setState({ tokenId: e.target.value, error: null, done: null })}
                    />
                  </div>
                )}
                <div className="form-group mb-0 mr-2">
                  <label className="small text-muted mb-1">backing (min {fmtEth(KNOB_SNAPSHOT.minBacking)} ETH)</label>
                  <input
                    className="form-control form-control-sm deposit-input"
                    placeholder="0.05"
                    value={backing}
                    onChange={(e) => this.setState({ backing: e.target.value, error: null, done: null })}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-warning deposit-btn mr-3"
                  disabled={!!busy || !tokenId.trim() || !backing.trim()}
                  onClick={() => this.deposit()}
                >
                  {busy ? busy + '…' : 'DEPOSIT' + (tokenId.trim() ? ' #' + tokenId.trim() : '')}
                </button>
                <a
                  className="small deposit-os-link"
                  href={'https://opensea.io/assets/ethereum/' + collection}
                  target="_blank" rel="noopener noreferrer"
                  title="check floor / listings before choosing your backing"
                >
                  <i className="mdi mdi-ship-wheel"></i> view collection on OpenSea
                </a>
              </React.Fragment>
            ) : <span className="text-muted small">connect your wallet (top right) to deposit</span>}
          </div>
          {account && owned && owned.ids.length === 0 && !owned.scanFailed && (
            <div className="small text-muted mt-2">this wallet holds none of that collection — pick another</div>
          )}
          {error && <div className="small text-danger mt-2">{error}</div>}
          {done && <div className="small text-success mt-2">{done}</div>}
        </div>
      </div>
    );
  }
}

export default DepositPanel;
