# WebSocket protocol (client ⇄ server)

All messages are JSON. Connect to the server's WebSocket URL.

## Server → client

- `hello` — on connect:
  `{ type, loginNonce, serverSeedHash, dropCost, minWithdraw, vault, token, chainId }`
- `auth` — login accepted:
  `{ type, address, balance, fairness:{serverSeedHash, clientSeed, nonce} }`
- `state` — **20×/sec**, the shared table:
  `{ type:"state", pusherZ, coins:[ [id,x,y,z, qx,qy,qz,qw, prize], ... ] }`
  (`prize`=1 for a prize coin, 0 for empty — the client chooses the look; all
  coins render the SWOGE coin face.)
- `balance` — `{ type, balance }`
- `deposit` — a deposit was credited: `{ type, balance }`
- `win` — one of YOUR coins fell off the front: `{ type, value, balance }`
- `ticker` — global winners feed: `{ type, name, value }`
- `need_deposit` — tried to drop with too little balance: `{ type, balance }`
- `voucher` — withdrawal authorized:
  `{ type, vault, balance, voucher:{ cumulative, deadline, v, r, s } }`
  For the bet vault the same message carries `coffre:"bet"`, `betBalance`, and
  `vault` is the SwogeBetVault address: call `withdraw` on THAT contract.
- `betBalance` — `{ type, betBalance }` — your $SWOGEBET balance (sports bets only)
- `betDeposit` — a $SWOGEBET deposit was credited: `{ type, betBalance }`
- `pariPose` — a bet was placed: `{ type, pari, balance, betBalance, matchs, mesParis }`
- `fairness` — `{ type, fairness:{serverSeedHash, clientSeed, nonce} }`
- `error` — `{ type, error }`

## Client → server

- `login` — `{ type, message, signature, name? }`
  `message` **must** equal `"SWOGE Pusher login\nnonce: <loginNonce>"`; sign it
  with the wallet (`personal_sign`). The recovered address = your account.
- `drop` — `{ type }` (drops one coin for you; costs `dropCost` $SWOGE)
- `balance` — `{ type }` (ask for your balance)
- `setClientSeed` — `{ type, seed }` (provably-fair client seed)
- `withdraw` — `{ type, amount }` (amount in whole $SWOGE, ≥ minWithdraw)
- `betBalance` — `{ type }` (ask for your $SWOGEBET balance)
- `betWithdraw` — `{ type, amount }` (whole $SWOGEBET, ≥ `betMinWithdraw` from `hello`)
- `betWithdrawPending` / `betWithdrawVoucher` — the bet-vault twins of
  `withdrawPending` / `withdrawVoucher`

## Sports bets are played in $SWOGEBET only

`hello` also carries `betVault`, `betToken` and `betMinWithdraw`. The betting
page deposits and withdraws on `betVault` (SwogeBetVault, same ABI and the
same EIP-712 voucher shape as SwogePusherVault, domain name `SwogeBetVault`).
`parie` debits the $SWOGEBET balance and winnings return to it; the $SWOGE
balance is never touched by a bet. While `betVault` is `null` the vault is not
deployed yet and bets cannot be funded.

## Deposit → play → cash-out flow

1. Wallet: `approve(vault, amount)` then `vault.deposit(amount)` on-chain.
2. Server sees the `Deposit` event → sends you `deposit` with your new balance.
3. Tap anywhere → client sends `drop` → the coin appears on the shared table
   for **everyone**. When it's pushed off the front, you get a `win`.
4. Withdraw → client sends `withdraw` → server replies with a `voucher` →
   client calls `vault.withdraw(cumulative, deadline, v, r, s)` → the contract
   pays you automatically.

## Verifying provably-fair
`serverSeedHash = sha256(serverSeed)` is published up front. Each drop's value is
`POOL[ int(HMAC_SHA256(serverSeed, clientSeed + ":" + nonce)[:15hex]) mod POOL.length ]`.
When the server rotates its seed it reveals the old `serverSeed`, so you can
recompute every past drop and confirm it wasn't tampered with.
