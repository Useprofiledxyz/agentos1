// Token contract heuristics from bytecode: which risky functions it exposes, whether it is a proxy, and whether an owner is live.
// A heuristic, not an audit: a function being present does not mean it will be abused, and absence proves nothing about logic.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { CHAINS, chainKey, knownToken } from "./chains.mjs";
import { rpc } from "./rpc.mjs";

const sel = (sig) => Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString("hex").slice(0, 8);

const GROUPS = {
  mint: ["mint(address,uint256)", "mint(uint256)", "_mint(address,uint256)"],
  pause: ["pause()", "unpause()"],
  blacklist: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "isBlacklisted(address)", "setBots(address[],bool)", "blockBots(address[])"],
  fees: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFeePercent(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setTax(uint256)", "setTaxes(uint256,uint256)", "updateFees(uint256,uint256)"],
  maxTx: ["setMaxTxAmount(uint256)", "setMaxWallet(uint256)", "setMaxTxPercent(uint256)"],
  tradingSwitch: ["enableTrading()", "setTradingEnabled(bool)", "openTrading()"],
};
const SELECTORS = Object.fromEntries(Object.entries(GROUPS).map(([g, sigs]) => [g, sigs.map((s) => ({ sig: s, sel: sel(s) }))]));
const OWNER = sel("owner()");
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** True when the selector appears as a PUSH4 operand (0x63 + 4 bytes) in the bytecode. */
const hasSelector = (code, s) => code.includes("63" + s);

export async function tokenHealth(chain, address) {
  const key = chainKey(chain);
  const known = knownToken(key, address);
  if (known) return { address, known: true, flags: [], score: 100, summary: `${known.symbol} is on the AgentOS known-token list for ${CHAINS[key].name}.` };

  const code = String(await rpc(key, "eth_getCode", [address, "latest"])).toLowerCase().replace(/^0x/, "");
  if (!code) return { address, known: false, flags: [{ id: "no_code", severity: "fail", text: "No contract code at this address." }], score: 0, summary: "Not a contract." };

  const flags = [];
  const minimalProxy = code.startsWith("363d3d373d3d3d363d73");
  let implSlot = null;
  try { implSlot = await rpc(key, "eth_getStorageAt", [address, EIP1967_IMPL, "latest"]); } catch {}
  const isProxy = minimalProxy || (implSlot && BigInt(implSlot) !== 0n);
  if (isProxy) flags.push({ id: "proxy", severity: "warn", text: "Upgradeable proxy: the code behind it can be replaced." });

  const labels = { mint: "Can mint new supply", pause: "Can pause transfers", blacklist: "Can blacklist wallets", fees: "Has fee or tax setters", maxTx: "Has max-transaction / max-wallet limits", tradingSwitch: "Has a trading on/off switch" };
  for (const [g, list] of Object.entries(SELECTORS)) {
    const found = list.filter((x) => hasSelector(code, x.sel)).map((x) => x.sig);
    if (found.length) flags.push({ id: g, severity: g === "fees" || g === "blacklist" || g === "mint" ? "warn" : "info", text: `${labels[g]} (${found.join(", ")})` });
  }

  let owner = null;
  if (hasSelector(code, OWNER)) {
    try {
      const r = await rpc(key, "eth_call", [{ to: address, data: "0x" + OWNER }, "latest"]);
      if (r && r.length >= 66) owner = "0x" + r.slice(-40);
    } catch {}
  }
  const ownerLive = owner && BigInt(owner) !== 0n;
  if (ownerLive) flags.push({ id: "owner", severity: flags.some((f) => f.severity === "warn") ? "warn" : "info", text: `Owner is live: ${owner}` });
  else if (owner) flags.push({ id: "renounced", severity: "info", text: "Ownership renounced (owner is the zero address)." });

  // Owner-only powers matter much less once ownership is renounced.
  const warnCount = flags.filter((f) => f.severity === "warn").length;
  const score = Math.max(0, 100 - warnCount * (ownerLive || isProxy ? 20 : 8));
  const summary = warnCount ? `${warnCount} risk flag${warnCount > 1 ? "s" : ""} in the bytecode${ownerLive ? " with a live owner" : ""}.` : "No risky functions found in the bytecode.";
  return { address, known: false, isProxy, owner, flags, score, summary };
}
