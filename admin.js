'use strict';
/*
 * Private owner dashboard (served at /admin?key=…). Shows vault pot, amount
 * owed to players, and the safe surplus, plus a one-click ownerWithdraw.
 * Access is gated by ADMIN_KEY (see server.js). Keep the URL private.
 */
const cfg = require('./config');

function page() {
  const V = cfg.VAULT_ADDRESS || '';
  const CHAIN_HEX = '0x' + Number(cfg.CHAIN_ID).toString(16);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SWOGE Vault — Admin</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:'Space Mono','Courier New',monospace}
  body{background:#0B0906;color:#F7EEDA;padding:20px;max-width:760px;margin:0 auto}
  h1{font-size:20px;color:#E6A537;margin-bottom:4px}
  .muted{color:#8a7f6a;font-size:12px;margin-bottom:18px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(230,165,55,.25);border-radius:14px;padding:16px}
  .card span{font-size:12px;color:#8a7f6a;display:block;margin-bottom:6px}
  .card b{font-size:26px;color:#F7EEDA}
  .card.hl{border-color:#7CFF9B;background:rgba(124,255,155,.08)}
  .card.hl b{color:#7CFF9B}
  .sub{font-size:13px;color:#c9bfa8;margin-bottom:22px;line-height:1.8}
  .sub b{color:#E6A537}
  .panel{background:rgba(255,255,255,.04);border:1px solid rgba(230,165,55,.25);border-radius:14px;padding:18px}
  .panel h2{font-size:15px;color:#E6A537;margin-bottom:12px}
  input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(230,165,55,.4);background:rgba(21,16,10,.9);color:#F7EEDA;font-family:inherit;font-size:15px;margin-bottom:10px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{font-family:inherit;font-weight:700;font-size:13px;padding:11px 16px;border:none;border-radius:10px;cursor:pointer;background:linear-gradient(135deg,#FFB84D,#E6A537);color:#0B0906}
  button.ghost{background:rgba(21,16,10,.9);color:#F7EEDA;border:1px solid rgba(230,165,55,.4)}
  button:disabled{opacity:.5;cursor:default}
  #msg{margin-top:12px;font-size:13px;min-height:20px}
  .warn{color:#FF8A5B}.ok{color:#7CFF9B}
  a{color:#E6A537}
</style></head><body>
<h1>🐕 SWOGE Vault — Admin</h1>
<div class="muted">Private. Vault <code>${V || '(not set)'}</code></div>

<div class="cards">
  <div class="card"><span>In the vault</span><b id="pot">—</b></div>
  <div class="card"><span>Owed to players</span><b id="owed">—</b></div>
  <div class="card hl"><span>Safe surplus (withdrawable)</span><b id="surplus">—</b></div>
</div>
<div class="sub">
  <b>Owed breakdown:</b> 💵 Balances <b id="ob">—</b> · 🔒 Staked <b id="os">—</b> · 📈 Yield <b id="oy">—</b> · 🎰 Jackpot reserve <b id="oj">—</b><br>
  👥 Players <b id="pl">—</b> · updated <span id="upd">—</span> · <a href="#" id="refresh">refresh</a>
</div>

<div class="panel">
  <h2>🏧 Owner withdraw</h2>
  <input id="amt" type="number" inputmode="decimal" placeholder="amount in $SWOGE">
  <div class="row">
    <button class="ghost" id="max">Fill safe surplus</button>
    <button class="ghost" id="conn">Connect owner wallet</button>
    <button id="go" disabled>Withdraw →</button>
  </div>
  <div id="msg"></div>
</div>

<div class="panel" style="margin-top:14px">
  <h2>⚙️ Owner controls</h2>
  <div style="font-size:12px;color:#8a7f6a;margin-bottom:10px">Connect the owner wallet above to enable these.</div>

  <label style="font-size:13px;color:#c9bfa8">Fund the vault (adds bankroll)</label>
  <input id="fundAmt" type="number" inputmode="decimal" placeholder="amount in $SWOGE">
  <div class="row" style="margin-bottom:14px"><button id="fund" disabled>Approve + Fund →</button></div>

  <label style="font-size:13px;color:#c9bfa8">Minimum withdraw — currently <b id="curMin" style="color:#E6A537">—</b></label>
  <input id="minAmt" type="number" inputmode="decimal" placeholder="new minimum in $SWOGE">
  <div class="row" style="margin-bottom:14px"><button class="ghost" id="setMin" disabled>Set minimum</button></div>

  <label style="font-size:13px;color:#c9bfa8">Pause / resume</label>
  <div class="row"><button class="ghost" id="pauseDep" disabled>Deposits: —</button><button class="ghost" id="pauseWd" disabled>Withdrawals: —</button></div>
  <div id="cmsg" style="margin-top:12px;font-size:13px"></div>
</div>

<script>
var KEY=new URLSearchParams(location.search).get('key')||'';
var VAULT="${V}";
var TOKEN="${cfg.SWOGE_TOKEN || ''}";
var CHAIN={hex:"${CHAIN_HEX}",name:"${cfg.CHAIN_ID===4663?'Robinhood Chain':'Chain'}",rpc:"${cfg.RPC_URL}"};
var ABI=[
  "function ownerWithdraw(address to,uint256 amount)",
  "function ownerDeposit(uint256 amount)",
  "function setDepositsPaused(bool paused)",
  "function setWithdrawalsPaused(bool paused)",
  "function setMinWithdraw(uint256 v)",
  "function totalPot() view returns (uint256)",
  "function depositsPaused() view returns (bool)",
  "function withdrawalsPaused() view returns (bool)",
  "function minWithdraw() view returns (uint256)"
];
var ERC20=["function approve(address s,uint256 a) returns (bool)","function allowance(address o,address s) view returns (uint256)"];
var provider,signer,myAddr,surplusNum=0;
function $(s){return document.querySelector(s);}
function fmt(v){var n=parseFloat(v||"0");if(isNaN(n))return "—";return n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":n.toFixed(2);}
function msg(t,c){$("#msg").textContent=t;$("#msg").className=c||"";}

async function load(){
  try{
    var r=await fetch("/stats?key="+encodeURIComponent(KEY));
    if(!r.ok){ msg("Wrong admin key or stats disabled ("+r.status+")","warn"); return; }
    var d=await r.json();
    $("#pot").textContent=fmt(d.vaultPot); $("#owed").textContent=fmt(d.owedToPlayers);
    $("#surplus").textContent=fmt(d.ownerSurplus); surplusNum=parseFloat(d.ownerSurplus||"0")||0;
    $("#ob").textContent=fmt(d.owedBalances); $("#os").textContent=fmt(d.owedStaked);
    $("#oy").textContent=fmt(d.owedPending); $("#oj").textContent=fmt(d.owedJackpot);
    $("#pl").textContent=d.players;
    $("#upd").textContent=new Date().toLocaleTimeString();
  }catch(e){ msg("Could not load stats: "+e.message,"warn"); }
}
load(); setInterval(load,10000);
$("#refresh").onclick=function(e){e.preventDefault();load();};
$("#max").onclick=function(){ $("#amt").value=surplusNum>0?String(Math.floor(surplusNum)):"0"; };

$("#conn").onclick=async function(){
  if(!window.ethereum){ msg("No wallet found (install MetaMask / Rabby)","warn"); return; }
  try{
    await window.ethereum.request({method:"eth_requestAccounts"});
    var cid=await window.ethereum.request({method:"eth_chainId"});
    if(cid!==CHAIN.hex){
      try{ await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN.hex}]}); }
      catch(sw){ if(sw&&sw.code===4902){ await window.ethereum.request({method:"wallet_addEthereumChain",params:[{chainId:CHAIN.hex,chainName:CHAIN.name,nativeCurrency:{name:"ETH",symbol:"ETH",decimals:18},rpcUrls:[CHAIN.rpc]}]}); } }
    }
    provider=new ethers.providers.Web3Provider(window.ethereum,"any"); signer=provider.getSigner();
    myAddr=await signer.getAddress();
    $("#conn").textContent=myAddr.slice(0,6)+"…"+myAddr.slice(-4);
    $("#go").disabled=false; msg("Wallet connected. Make sure it's the OWNER wallet.","ok");
    refreshOwnerState();
  }catch(e){ msg(String(e.message||e).slice(0,100),"warn"); }
};

function cmsg(t,c){ $("#cmsg").textContent=t; $("#cmsg").className=c||""; }
async function refreshOwnerState(){
  try{
    var c=new ethers.Contract(VAULT,ABI,provider);
    var dp=await c.depositsPaused(), wp=await c.withdrawalsPaused(), mw=await c.minWithdraw();
    $("#curMin").textContent=fmt(ethers.utils.formatUnits(mw,18));
    $("#pauseDep").textContent="Deposits: "+(dp?"PAUSED — resume":"live — pause"); $("#pauseDep").dataset.on=dp?"1":"0";
    $("#pauseWd").textContent="Withdrawals: "+(wp?"PAUSED — resume":"live — pause"); $("#pauseWd").dataset.on=wp?"1":"0";
    ["fund","setMin","pauseDep","pauseWd"].forEach(function(id){ $("#"+id).disabled=false; });
  }catch(e){ cmsg("Could not read contract state: "+(e.message||e),"warn"); }
}
async function tx(promise, okMsg){
  try{ cmsg("Confirm in your wallet…"); var t=await promise; cmsg("Sending…"); await t.wait(); cmsg("✅ "+okMsg,"ok"); refreshOwnerState(); load(); }
  catch(e){ cmsg("Failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
}
$("#fund").onclick=async function(){
  if(!signer) return cmsg("Connect wallet first","warn");
  var v=($("#fundAmt").value||"").replace(",",".").trim(); if(!(parseFloat(v)>0)) return cmsg("Enter an amount","warn");
  if(!TOKEN) return cmsg("Token address not set on server","warn");
  try{
    var amt=ethers.utils.parseUnits(v,18);
    var tok=new ethers.Contract(TOKEN,ERC20,signer);
    var al=await tok.allowance(myAddr,VAULT);
    if(al.lt(amt)){ cmsg("Approve $SWOGE…"); var ta=await tok.approve(VAULT,ethers.constants.MaxUint256); await ta.wait(); }
    await tx(new ethers.Contract(VAULT,ABI,signer).ownerDeposit(amt), "Vault funded with "+v+" $SWOGE"); $("#fundAmt").value="";
  }catch(e){ cmsg("Failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
};
$("#setMin").onclick=function(){
  if(!signer) return cmsg("Connect wallet first","warn");
  var v=($("#minAmt").value||"").replace(",",".").trim(); if(!(parseFloat(v)>=0)) return cmsg("Enter a value","warn");
  tx(new ethers.Contract(VAULT,ABI,signer).setMinWithdraw(ethers.utils.parseUnits(v,18)), "Min withdraw set to "+v); $("#minAmt").value="";
};
$("#pauseDep").onclick=function(){ if(!signer) return; var on=$("#pauseDep").dataset.on==="1"; tx(new ethers.Contract(VAULT,ABI,signer).setDepositsPaused(!on), on?"Deposits resumed":"Deposits paused"); };
$("#pauseWd").onclick=function(){ if(!signer) return; var on=$("#pauseWd").dataset.on==="1"; tx(new ethers.Contract(VAULT,ABI,signer).setWithdrawalsPaused(!on), on?"Withdrawals resumed":"Withdrawals paused"); };

$("#go").onclick=async function(){
  if(!signer){ msg("Connect your wallet first","warn"); return; }
  var v=($("#amt").value||"").replace(",",".").trim();
  var n=parseFloat(v); if(!(n>0)){ msg("Enter an amount","warn"); return; }
  if(n>surplusNum+0.0001){ if(!confirm("⚠️ "+n+" is MORE than the safe surplus ("+surplusNum.toFixed(2)+"). This can take player funds. Continue anyway?")) return; }
  try{
    msg("Confirm the transaction in your wallet…");
    var c=new ethers.Contract(VAULT,ABI,signer);
    var tx=await c.ownerWithdraw(myAddr, ethers.utils.parseUnits(v,18));
    msg("Sent, waiting for confirmation…");
    await tx.wait();
    msg("✅ Withdrawn "+n+" $SWOGE to your wallet","ok");
    $("#amt").value=""; load();
  }catch(e){ msg("Withdraw failed: "+String(e.reason||e.message||e).slice(0,120),"warn"); }
};
</script></body></html>`;
}

module.exports = { page };
