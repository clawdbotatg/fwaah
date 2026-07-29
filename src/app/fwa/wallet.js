// Thin EIP-1193 wrapper — the injected wallet (MetaMask etc.) signs and sends;
// this app never touches keys. Reads and receipt-watching stay on the local node.

import { rpcBatch } from './fwa';

export function injected() {
  return typeof window !== 'undefined' ? window.ethereum : null;
}

export async function connectWallet() {
  const eth = injected();
  if (!eth) throw new Error('no wallet found — install MetaMask (or any injected wallet)');
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('wallet returned no accounts');
  return accounts[0];
}

export function onAccountsChanged(handler) {
  const eth = injected();
  if (eth && eth.on) eth.on('accountsChanged', handler);
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
