import React, { Component } from 'react';
import {
  FWA_ADDRESS, SELECTORS, WHITELIST_SNAPSHOT, KNOB_SNAPSHOT,
  rpcBatchSafe, ethCall, ethCallTo, encodeData, word, wordAddr,
  fmtEth,
} from '../fwa/fwa';
import { injected, onAccountsChanged, autoReconnectAllowed, sendTx, waitForReceipt } from '../fwa/wallet';

const MAX_OWNED_SHOWN = 24;

// Deposit an NFT into the pool: pick a whitelisted collection, pick one of
// your tokens (balanceOf + tokenOfOwnerByIndex where the collection supports
// enumeration; a manual tokenId input where it doesn't), choose the ETH
// backing. Ownership/whitelist/approval are verified with cheap eth_calls
// before any transaction; the flow is approve → listNFT (backing = msg.value).
export class DepositPanel extends Component {
  state = {
    account: null,
    collection: WHITELIST_SNAPSHOT[0][0],
    tokenId: '',
    backing: '',
    owned: null, // null = loading · {total, ids, enumerable}
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

  // What do they hold here? balanceOf is universal; tokenOfOwnerByIndex is
  // ERC721Enumerable — where a collection dropped it, keep the manual input.
  async fetchOwned(account, collection) {
    try {
      const [balRaw] = await rpcBatchSafe([ethCallTo(collection, SELECTORS.balanceOf, [account])]);
      if (!this.alive || this.state.account !== account || this.state.collection !== collection) return;
      const total = balRaw ? Number(word(balRaw, 0)) : null;
      if (total === null) { this.setState({ owned: { total: null, ids: [], enumerable: false } }); return; }
      if (total === 0) { this.setState({ owned: { total: 0, ids: [], enumerable: true } }); return; }
      const count = Math.min(total, MAX_OWNED_SHOWN);
      const idRes = await rpcBatchSafe(Array.from({ length: count }, (_, i) => (
        ethCallTo(collection, SELECTORS.tokenOfOwnerByIndex, [account, BigInt(i)])
      )));
      if (!this.alive || this.state.account !== account || this.state.collection !== collection) return;
      const ids = idRes.filter((r) => r && r !== '0x').map((r) => word(r, 0).toString());
      // nulls/empties mean no enumeration support — degrade to manual entry
      this.setState({ owned: { total, ids, enumerable: ids.length > 0 } });
    } catch (e) {
      if (this.alive) this.setState({ owned: { total: null, ids: [], enumerable: false } });
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
                {(!owned || !owned.enumerable || owned.total === null) && (
                  <div className="form-group mb-0 mr-2">
                    <label className="small text-muted mb-1">tokenId{owned && !owned.enumerable ? ' (collection hides holdings — enter it)' : ''}</label>
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
                  className="btn btn-sm btn-warning deposit-btn"
                  disabled={!!busy || !tokenId.trim() || !backing.trim()}
                  onClick={() => this.deposit()}
                >
                  {busy ? busy + '…' : 'DEPOSIT' + (tokenId.trim() ? ' #' + tokenId.trim() : '')}
                </button>
              </React.Fragment>
            ) : <span className="text-muted small">connect your wallet (top right) to deposit</span>}
          </div>
          {account && owned && owned.enumerable && owned.total === 0 && (
            <div className="small text-muted mt-2">this wallet holds none of that collection — pick another</div>
          )}
          {account && owned && owned.enumerable && owned.ids.length > 0 && (
            <div className="deposit-owned mt-2">
              <span className="small text-muted mr-2">
                you hold {owned.total}{owned.total > owned.ids.length ? ' (first ' + owned.ids.length + ' shown)' : ''} — pick one:
              </span>
              {owned.ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={'deposit-chip' + (tokenId === id ? ' deposit-chip-active' : '')}
                  onClick={() => this.setState({ tokenId: id, error: null, done: null })}
                >
                  #{id}
                </button>
              ))}
            </div>
          )}
          {error && <div className="small text-danger mt-2">{error}</div>}
          {done && <div className="small text-success mt-2">{done}</div>}
        </div>
      </div>
    );
  }
}

export default DepositPanel;
