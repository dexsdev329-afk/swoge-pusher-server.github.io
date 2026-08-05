'use strict';
/*
 * Chain glue (ethers v5):
 *   - watch the Vault's Deposit events → credit in-game balances
 *   - sign EIP-712 withdrawal vouchers the SwogePusherVault contract accepts
 *   - verify wallet login signatures (SIWE-style)
 */
const { ethers } = require('ethers');
const cfg = require('./config');

const VAULT_ABI = [
  'event Deposit(address indexed player, uint256 amount, uint256 playerTotal, uint256 timestamp)',
  'function withdrawn(address) view returns (uint256)',
  'function totalPot() view returns (uint256)',
  'function minWithdraw() view returns (uint256)',
];

class Chain {
  constructor() {
    this.provider = new ethers.providers.StaticJsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);
    this.signer = cfg.SIGNER_PRIVATE_KEY ? new ethers.Wallet(cfg.SIGNER_PRIVATE_KEY) : null;
    this.vault = cfg.VAULT_ADDRESS
      ? new ethers.Contract(cfg.VAULT_ADDRESS, VAULT_ABI, this.provider)
      : null;
    this.token = cfg.SWOGE_TOKEN
      ? new ethers.Contract(cfg.SWOGE_TOKEN, ['function totalSupply() view returns (uint256)'], this.provider)
      : null;
    this.domain = {
      name: 'SwogePusherVault', version: '1',
      chainId: cfg.CHAIN_ID, verifyingContract: cfg.VAULT_ADDRESS,
    };
    this.types = { Withdraw: [
      { name: 'player', type: 'address' },
      { name: 'cumulative', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ]};
  }

  get signerAddress() { return this.signer ? this.signer.address : null; }

  /**
   * Poll Deposit events from `fromBlock`. Calls onDeposit({player, amount, tx, block})
   * per event, and onBlock(nextBlock) after each successful poll so the caller can
   * persist the watermark (resume here after a restart, no missed/double credits).
   */
  async watchDeposits(fromBlock, onDeposit, onBlock) {
    if (!this.vault) { console.warn('[chain] no VAULT_ADDRESS set — deposit watch disabled'); return; }
    let last = fromBlock;
    const tick = async () => {
      try {
        const tip = await this.provider.getBlockNumber();
        if (tip >= last) {
          const evs = await this.vault.queryFilter(this.vault.filters.Deposit(), last, tip);
          for (const e of evs) {
            onDeposit({
              player: e.args.player.toLowerCase(),
              amount: e.args.amount,           // BigNumber (wei)
              tx: e.transactionHash,
              block: e.blockNumber,
            });
          }
          last = tip + 1;
          if (onBlock) onBlock(last);
        }
      } catch (err) { console.warn('[chain] deposit poll error:', err.message); }
      setTimeout(tick, cfg.DEPOSIT_POLL_MS);
    };
    tick();
  }

  /** Sign a cumulative-withdrawal voucher for `player`. Returns {cumulative, deadline, v, r, s}. */
  async signVoucher(player, cumulativeWei) {
    if (!this.signer) throw new Error('no signer key configured');
    const deadline = Math.floor(Date.now() / 1000) + cfg.VOUCHER_TTL_SEC;
    const value = { player, cumulative: cumulativeWei.toString(), deadline };
    const sig = await this.signer._signTypedData(this.domain, this.types, value);
    const { v, r, s } = ethers.utils.splitSignature(sig);
    return { cumulative: cumulativeWei.toString(), deadline, v, r, s };
  }

  /** How much has this player already pulled on-chain (so vouchers stay cumulative-correct). */
  async withdrawnOnChain(player) {
    if (!this.vault) return ethers.BigNumber.from(0);
    try { return await this.vault.withdrawn(player); }
    catch { return ethers.BigNumber.from(0); }
  }

  /** SWOGE token total supply (wei) or null. */
  async totalSupply() {
    if (!this.token) return null;
    try { return await this.token.totalSupply(); } catch { return null; }
  }

  /** Verify a login signature. Returns the recovered address (lowercased) or null. */
  verifyLogin(message, signature) {
    try { return ethers.utils.verifyMessage(message, signature).toLowerCase(); }
    catch { return null; }
  }
}

module.exports = { Chain, VAULT_ABI };
