# SWOGE Pusher — game server (shared real-time table)

One authoritative server runs **a single physics table**. Every player connects
by WebSocket, sees the **same** coins/pile, and taps to drop. Balances come from
on-chain deposits into `SwogePusherVault`; winnings are cashed out via
backend-signed vouchers the vault pays automatically.

```
 Wallet ──deposit $SWOGE──► SwogePusherVault (escrow, on-chain)
                                   │ Deposit event
 Player ◄──WebSocket──► THIS SERVER (one shared table)
   • login by signature          • cannon-es physics (authoritative)
   • tap → "drop"                • provably-fair coin values
   • sees everyone's coins       • credits winnings, signs withdraw vouchers
```

## What's verified
- Physics: coins pile up and get pushed off the front = wins (fork-tested).
- Vault vouchers: signatures from this server are **accepted by the contract**.
- WebSocket: login (wallet signature), shared 20 Hz state broadcast, drop, withdraw voucher.

## Run locally
```bash
npm install
# demo mode (no chain): lets a client self-credit to try the table
DEV_FAUCET=1 npm start
# open the client (served separately) and point it at ws://localhost:8080
```

## Deploy (Railway)
1. Put these files in a GitHub repo (e.g. `swoge-pusher-server`).
2. Railway → New Project → Deploy from GitHub → this repo.
3. Set **Variables**:

| Variable | Value |
|---|---|
| `VAULT_ADDRESS` | address of the deployed `SwogePusherVault` |
| `SIGNER_PRIVATE_KEY` | the key whose address you set as the vault `signer` (⚠️ keep secret) |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` (default) |
| `CHAIN_ID` | `4663` (default) |
| `SWOGE_TOKEN` | `0x8a166Fb41Cd659a0a43396272FF73973Ce29F817` (default) |
| `MIN_WITHDRAW` | must match the vault's `minWithdraw` (default `50`) |
| `DROP_COST` | $SWOGE per drop (default `1`) |
| `DEV_FAUCET` | **leave unset in production** (dev-only free credits) |

4. Deploy → logs show `SWOGE Pusher server on :PORT` and the signer address.
   Make sure that signer address is set as `signer` on the vault (`setSigner`).

## ⚠️ Before real money
- The `SIGNER_PRIVATE_KEY` can authorize payouts — protect it (Railway secret,
  rotate if leaked). If it leaks, the pot can be drained.
- Keep the vault **bankroll** funded (`ownerDeposit`) so winnings can always pay.
- RTP emerges from `POOL` values + table dynamics — tune in `config.js`.
- This is an MVP. Get it reviewed/audited before taking real deposits at scale,
  and check the legal side of running a paid game where you operate.

## Files
- `config.js` — all settings (env-overridable)
- `physics.js` — the shared table (cannon-es)
- `chain.js` — deposit watch + EIP-712 voucher signing + login verify
- `game.js` — balances, provably-fair RNG, winnings
- `server.js` — WebSocket server + loops
- `PROTOCOL.md` — the client⇄server message protocol
