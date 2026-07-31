// Thin EIP-1193 wrapper — the injected wallet (MetaMask etc.) signs and sends;
// this app never touches keys. Reads and receipt-watching stay on the local node.

import { rpcBatch } from './fwa';

export function injected() {
  return typeof window !== 'undefined' ? window.ethereum : null;
}

// Central account fan-out: EVERY connect/disconnect broadcasts to every
// subscriber, because the provider's own accountsChanged event does NOT
// reliably fire on the first connect — without this, a panel mounted before
// the connect click never learns about the account until a reload.
const accountSubs = new Set();
let providerWired = false;

function broadcast(accounts) {
  accountSubs.forEach((h) => { try { h(accounts); } catch (e) { /* one bad sub never blocks the rest */ } });
}

// "user hit disconnect" survives reloads so we don't silently re-grab the
// wallet the wallet itself still considers authorized
const DISCONNECTED_KEY = 'fwaah.walletDisconnected';
export function autoReconnectAllowed() {
  try { return !window.localStorage.getItem(DISCONNECTED_KEY); } catch (e) { return true; }
}

export async function connectWallet() {
  const eth = injected();
  if (!eth) throw new Error('no wallet found — install MetaMask (or any injected wallet)');
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('wallet returned no accounts');
  try { window.localStorage.removeItem(DISCONNECTED_KEY); } catch (e) { /* private mode */ }
  broadcast(accounts);
  return accounts[0];
}

// EIP-1193 has no programmatic disconnect — this forgets the account app-side
// (all panels clear via the broadcast) and stops future silent reconnects.
export function disconnectWallet() {
  try { window.localStorage.setItem(DISCONNECTED_KEY, '1'); } catch (e) { /* private mode */ }
  broadcast([]);
}

export function onAccountsChanged(handler) {
  accountSubs.add(handler);
  const eth = injected();
  if (eth && eth.on && !providerWired) {
    providerWired = true;
    eth.on('accountsChanged', (accounts) => broadcast(accounts));
  }
  return () => accountSubs.delete(handler);
}

export async function ensureMainnet() {
  const eth = injected();
  const chainId = await eth.request({ method: 'eth_chainId' });
  if (chainId !== '0x1') {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  }
}

export async function sendTx({ from, to, data, value }) {
  const eth = injected();
  if (!eth) throw new Error('no wallet found');
  await ensureMainnet();
  return eth.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, ...(value ? { value: '0x' + value.toString(16) } : {}) }],
  });
}

// Watch for the receipt via the LOCAL node (works even if the wallet's RPC lags).
export async function waitForReceipt(hash, timeoutMs = 300000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const [receipt] = await rpcBatch([['eth_getTransactionReceipt', [hash]]]);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('timed out waiting for receipt ' + hash);
}
