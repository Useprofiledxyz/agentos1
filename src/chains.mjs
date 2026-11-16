// Chains AgentOS can quote and build swaps on, and the tokens it knows by symbol.
// Any other token is accepted by contract address; its symbol and decimals are read from the chain.

export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export const CHAINS = {
  base: {
    id: 8453,
    name: "Base",
    kyberSlug: "base",
    rpc: process.env.BASE_RPC || "https://mainnet.base.org",
    explorer: "https://basescan.org",
    tokens: {
      ETH: { address: NATIVE, decimals: 18 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
      CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
    },
  },
  arbitrum: {
    id: 42161,
    name: "Arbitrum",
    kyberSlug: "arbitrum",
    rpc: process.env.ARBITRUM_RPC || "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    tokens: {
      ETH: { address: NATIVE, decimals: 18 },
      WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      USDT: { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
      ARB: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
      WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
    },
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    kyberSlug: "ethereum",
    rpc: process.env.ETHEREUM_RPC || "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    tokens: {
      ETH: { address: NATIVE, decimals: 18 },
      WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
      USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      USDT: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
      WBTC: { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
    },
  },
};

const BY_ID = Object.fromEntries(Object.entries(CHAINS).map(([k, c]) => [c.id, k]));

/** chainKey("base" | 8453 | "8453") → "base" */
export function chainKey(c) {
  if (c == null || c === "") return "base";
  const s = String(c).toLowerCase().trim();
  if (CHAINS[s]) return s;
  if (BY_ID[s]) return BY_ID[s];
  if (s === "arb") return "arbitrum";
  if (s === "eth" || s === "mainnet") return "ethereum";
  throw new Error(`Unknown chain "${c}". Supported: ${Object.keys(CHAINS).join(", ")}`);
}

export const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
export const isNative = (a) => String(a).toLowerCase() === NATIVE.toLowerCase();

/** Known token by symbol, or null. */
export function knownToken(chain, symbolOrAddress) {
  const c = CHAINS[chainKey(chain)];
  const s = String(symbolOrAddress || "").toUpperCase().trim();
  if (c.tokens[s]) return { symbol: s, ...c.tokens[s] };
  if (isAddress(symbolOrAddress)) {
    for (const [sym, t] of Object.entries(c.tokens)) if (t.address.toLowerCase() === s.toLowerCase()) return { symbol: sym, ...t };
  }
  return null;
}

export function publicChains() {
  return Object.entries(CHAINS).map(([key, c]) => ({ key, id: c.id, name: c.name, explorer: c.explorer, tokens: Object.keys(c.tokens) }));
}
