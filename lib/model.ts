// token-radar-01 value model.
//
// What this file does, in one paragraph: it reads the sealed DefiLlama snapshot, keeps the protocols
// that record no token and are not a wrapped, staked or bridged product of one that trades, scores each
// survivor from the snapshot's own numbers only, turns the score into an implied dollar value, ranks the
// board by that value, and writes a concrete farm plan for every row. Nothing here names a protocol.
// A protocol's name never enters the score: the same formula ranks a household name and a protocol
// nobody has heard of, and the only list in this file is the house's exclusion rule, restated from
// RULES.txt so the board never pretends a wrapped or staked product is waiting for a first token.
//
// The score (scoreProtocol) is five components, each 0..1, each read off the snapshot:
//   size    0.45  log10 of TVL, stretched between the snapshot's $5M floor and the largest
//                 eligible TVL. A protocol holding more value has more to share if it ever issues.
//   growth  0.25  the 7-day TVL change, winsorised to [-30%, +50%]. Fast-growing TVL means users
//                 are arriving now; a crash the other way means they are leaving.
//   age     0.15  years since listed_at up to the snapshot's as_of, capped at 4 years. A protocol
//                 that has run for years at scale with no token on record has the largest
//                 established base to reward, and the longest farming runway behind it.
//   chains  0.10  how many chains it runs on, capped at 12. More chains, more places to farm it.
//   sector  0.05  a small prior for the category (CATEGORY_PRIOR): fee-earning venues that can
//                 share revenue score a touch higher than pure infrastructure. It never decides
//                 a rank on its own: the most it moves a score is 0.05.
// A missing change_7d or listed_at scores neutral (0.5) on that component, never zero: an unreported
// number is not a bad number.
//
// The value (impliedValueUsd) is the protocol's TVL times a fraction of it: 2% at a score of 0,
// rising with the square of the score to 50% at a score of 1. The square matters: a middling score
// earns a middling fraction, only a strong score earns a large one. Ranks follow the value, highest
// first; the board's rank 1 is simply the largest implied value on it.
//
// The board (buildRadar) is 200 rows: every one of the 40 watchlist protocols, the 158 other eligible
// protocols ranked by score, and 2 fillers. The fillers are pre-token protocols whose only failure
// against the house rule is a version marker in the name (RocketSwap Anubis V2, Aera V3): a V2 of a
// protocol with no token on record is still a protocol with no token on record, and neither one's
// unversioned name appears separately, so nothing is double-counted. They are flagged filler: true in
// the dashboard data so the page can say so. Tokenized protocols never enter the board; the dashboard
// data carries the 10 largest of them separately as the "already trading" list.
//
// Farm plans (buildFarmSteps) are built from the protocol's category and its first chain: each step
// names the action, a dollar size, the gas it costs on that chain and the time it takes. No step is a
// slogan; every step can be done, costed and timed.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface ScoreParts {
  size: number;
  growth: number;
  age: number;
  chains: number;
  sector: number;
  score: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface DataRow extends BoardRow {
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_years: number | null;
  score: number;
  parts: ScoreParts;
  watchlist: boolean;
  filler: boolean;
}

export interface Radar {
  as_of: string;
  floor_usd: number;
  protocols_total: number;
  tokenized_total: number;
  eligible_total: number;
  watchlist_size: number;
  early_size: number;
  filler_size: number;
  live_size: number;
  board: BoardRow[];
  rows: DataRow[];
  live_top: { slug: string; name: string; tvl_usd: number; mcap_usd: number | null }[];
  categories: string[];
}

/** Categories the house rule keeps off the watchlist: a product of a token that already trades. */
export const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a pre-token protocol must not start with (the house rule, restated). */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker: a space followed by V2, v2, 2.0 or the like. */
const VERSION_MARKER = / (V\d+|v\d+|\d+\.\d+)( .*)?$/;

/** Small sector prior by category. Default 1.00; the table is a prior, not a ranking. */
export const CATEGORY_PRIOR: Record<string, number> = {
  Dexs: 1.1,
  Lending: 1.1,
  Yield: 1.05,
  Derivatives: 1.05,
  CDP: 1.05,
  'Yield Aggregator': 1.05,
  'Basis Trading': 1.0,
  RWA: 1.0,
  'Risk Curators': 1.0,
  'Onchain Capital Allocator': 1.0,
  'Liquidity Manager': 1.0,
  'Leveraged Farming': 1.0,
  Farm: 1.0,
  'Staking Pool': 1.0,
  Restaking: 0.95,
  'Anchor BTC': 0.95,
  'Decentralized BTC': 0.95,
  CeDeFi: 0.95,
  'Dual-Token Stablecoin': 0.95,
  'Options Vault': 0.95,
  Privacy: 0.9,
  Chain: 0.9,
};

const SCORE_WEIGHTS = { size: 0.45, growth: 0.25, age: 0.15, chains: 0.1, sector: 0.05 };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Days from `listed_at` (YYYY-MM-DD) to the snapshot's `as_of` date, UTC, or null. */
export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const parse = (d: string): number => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y!, m! - 1, day!);
  };
  const days = Math.round((parse(asOf) - parse(listedAt)) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** True when DefiLlama records no token for the protocol. Say "records no token", never "has none". */
export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** True when the protocol fails the house's exclusion rule (wrapped, staked, bridged, CEX, versioned). */
export function isHouseExcluded(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSION_MARKER.test(p.name)) return true;
  const words = p.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return true;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return true;
  return false;
}

/** True for a pre-token protocol whose only exclusion is a version marker in its name. */
export function isVersionOnlyExcluded(p: Protocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  const words = p.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.includes('wrapped') || words.includes('staked') || words.includes('staking')) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return VERSION_MARKER.test(p.name);
}

/** Parse and lightly validate the sealed snapshot. Throws on a shape it does not recognise. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as unknown;
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot: not an object');
  const s = raw as Record<string, unknown>;
  if (typeof s.as_of !== 'string' || typeof s.source !== 'string' || typeof s.floor_usd !== 'number') {
    throw new Error('snapshot: as_of, source or floor_usd missing');
  }
  if (!Array.isArray(s.protocols) || !Array.isArray(s.watchlist)) {
    throw new Error('snapshot: protocols or watchlist missing');
  }
  const protocols = (s.protocols as Record<string, unknown>[]).map((p) => {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('snapshot: a protocol lacks slug, name or tvl_usd');
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? (p.chains as string[]) : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: s.as_of,
    source: s.source,
    floor_usd: s.floor_usd,
    protocols,
    watchlist: (s.watchlist as unknown[]).map(String),
  };
}

/**
 * Score one protocol from the snapshot's numbers only. `logTvlMin` / `logTvlMax` are the log10
 * bounds of TVL across the eligible set, so size is stretched 0..1 over what the board can see.
 * Every component is 0..1; the score is the weighted sum, weights in SCORE_WEIGHTS.
 */
export function scoreProtocol(p: Protocol, asOf: string, logTvlMin: number, logTvlMax: number): ScoreParts {
  const size = clamp01((Math.log10(Math.max(p.tvl_usd, 1)) - logTvlMin) / Math.max(logTvlMax - logTvlMin, 1e-9));
  const growth =
    p.change_7d === null ? 0.5 : clamp01((Math.min(Math.max(p.change_7d, -30), 50) + 30) / 80);
  const days = ageDays(p.listed_at, asOf);
  const age = days === null ? 0.5 : clamp01(days / 365.25 / 4);
  const chains = clamp01(Math.min(p.chains.length, 12) / 12);
  const prior = p.category !== null && p.category in CATEGORY_PRIOR ? CATEGORY_PRIOR[p.category]! : 1.0;
  const sector = clamp01((prior - 0.85) / 0.3);
  const score =
    SCORE_WEIGHTS.size * size +
    SCORE_WEIGHTS.growth * growth +
    SCORE_WEIGHTS.age * age +
    SCORE_WEIGHTS.chains * chains +
    SCORE_WEIGHTS.sector * sector;
  return { size, growth, age, chains, sector, score };
}

/**
 * Implied value in whole dollars: TVL times a fraction that rises with the square of the score,
 * 2% at a score of 0 to 50% at a score of 1. A middling protocol earns a middling fraction; only a
 * strong score earns a large one. Always a positive whole number.
 */
export function impliedValueUsd(p: Protocol, parts: ScoreParts): number {
  const fraction = 0.02 + 0.48 * parts.score * parts.score;
  return Math.max(1, Math.round(p.tvl_usd * fraction));
}

// ---------------------------------------------------------------- farm plans

/** Typical gas for one transaction on a chain, as the steps quote it. */
const CHAIN_GAS: Record<string, string> = {
  Ethereum: '$3–$15',
  Arbitrum: '$0.05–$0.50',
  Optimism: '$0.05–$0.50',
  Base: '$0.05–$0.50',
  Solana: 'about $0.01',
  'BNB Chain': '$0.10–$0.50',
  Binance: '$0.10–$0.50',
  Polygon: '$0.05–$0.30',
  Avalanche: '$0.20–$1',
  Sui: '$0.01–$0.05',
  Aptos: '$0.01–$0.05',
  Hyperliquid: '$0.01–$0.10',
  'Hyperliquid L1': '$0.01–$0.10',
  Tron: '$0.50–$2',
  Fantom: '$0.05–$0.30',
  Gnosis: '$0.05–$0.30',
  Linea: '$0.05–$0.50',
  zkSync: '$0.05–$0.50',
  Scroll: '$0.05–$0.50',
  Blast: '$0.05–$0.50',
  Mode: '$0.05–$0.50',
  Fraxtal: '$0.05–$0.50',
  Berachain: '$0.05–$0.50',
  Sei: '$0.01–$0.05',
  Injective: '$0.01–$0.05',
  Cosmos: '$0.01–$0.10',
  Osmosis: '$0.01–$0.10',
  Near: '$0.01–$0.05',
  Starknet: '$0.10–$1',
  Zksync: '$0.05–$0.50',
  Mantle: '$0.05–$0.50',
  Kava: '$0.05–$0.30',
  Celo: '$0.05–$0.30',
  Moonbeam: '$0.10–$0.50',
  Cronos: '$0.05–$0.30',
  'Robinhood Chain': '$0.05–$0.50',
  Monad: '$0.01–$0.05',
  MegaETH: '$0.01–$0.05',
};

function gasFor(chain: string): string {
  return CHAIN_GAS[chain] ?? '$0.10–$2';
}

/** One farm-plan template: `{name}` and `{chain}` are filled from the protocol, `{gas}` from CHAIN_GAS. */
const STEP_TEMPLATES: Record<string, string[]> = {
  onboard: [
    'Open {name} on {chain} and connect the wallet you will farm with. Finish any profile, social or quest checklist the app shows, and keep this same wallet for every step below so the activity is not split across addresses. Cost: no deposit, about {gas} in gas for any approval; time: 10 minutes.',
  ],
  dex: [
    'Swap $100–$500 into the pool assets on {name} ({chain}) in 3–5 trades spread over 2 weeks, rather than one large trade. Each swap pays roughly {gas} in gas. Cost: $100–$500 plus gas; time: 15 minutes per trade.',
    'Add $200–$1,000 of liquidity to a {name} pool on {chain} and hold the position for at least 4 weeks. Collect the trading fees as they accrue and do not withdraw early. Cost: the deposit plus about {gas} to add and remove; time: 20 minutes to set up, then passive.',
  ],
  lending: [
    'Supply $200–$1,000 of collateral, ETH or a stablecoin, to {name} on {chain} and leave it supplied for 4–8 weeks so the position ages. Cost: the deposit plus about {gas} to supply and withdraw; time: 15 minutes.',
    'Borrow a small amount, under 30% of your collateral, against the supply on {name}, hold the loan for 2–4 weeks, then repay it in full. Keep the health factor above 2 at all times. Cost: borrow interest of roughly 3–8% a year on the sum borrowed, plus {gas} per action; time: 20 minutes.',
  ],
  yield: [
    'Deposit $100–$500 into a {name} vault on {chain} and leave it for 6–12 weeks to earn the vault yield and any points it tracks. Cost: the deposit plus about {gas} to enter and exit; time: 15 minutes.',
  ],
  derivatives: [
    'Open 2–3 small positions of $50–$200 each on {name} ({chain}) over a month, closing each within a week. Size every position so a full loss stays under $200. Cost: the margin plus funding, and about {gas} per trade; time: 15 minutes per trade.',
    'Try both a long and a short on {name} ({chain}) in separate weeks, $50–$100 each, so the account shows two-sided activity instead of one direction. Cost: the margin plus funding, and about {gas} per trade; time: 15 minutes per trade.',
  ],
  cdp: [
    'Lock $200–$1,000 of collateral in {name} on {chain}, mint a stablecoin against at most 30% of it, and hold the position for 6–8 weeks. Keep the collateral ratio above 200% the whole time. Cost: the collateral plus about {gas}; time: 20 minutes.',
  ],
  aggregator: [
    'Deposit $100–$500 into {name} on {chain} and let it auto-compound for 8–12 weeks without withdrawing. Cost: the deposit plus about {gas} to enter and exit; time: 15 minutes.',
  ],
  basis: [
    'Deposit $200–$1,000 into a {name} basis strategy on {chain} and hold it for 6–10 weeks. Basis returns move with funding rates, so do not deposit money you need back quickly. Cost: the deposit plus about {gas}; time: 20 minutes.',
  ],
  rwa: [
    'Buy or mint $100–$500 of {name} tokenized assets on {chain} and hold them for 8–12 weeks. Read the redemption terms before buying so you know how to exit. Cost: the purchase plus about {gas}; time: 20 minutes.',
  ],
  curator: [
    'Allocate $200–$1,000 to a {name} curator vault on {chain} and hold the allocation for 8–12 weeks. Curator vaults rebalance for you; check the allocation once a month. Cost: the deposit plus about {gas}; time: 20 minutes.',
  ],
  staking: [
    'Stake $100–$500 with {name} on {chain} and keep it staked for 8–12 weeks. Unstaking can take days, so plan any exit ahead of time. Cost: the stake plus about {gas}; time: 15 minutes.',
  ],
  restaking: [
    'Restake $100–$500 of liquid staking tokens through {name} on {chain} and hold the position for 8–12 weeks. Restaked positions carry slashing risk, so keep the amount modest. Cost: the deposit plus about {gas}; time: 20 minutes.',
  ],
  farm: [
    'Deposit $100–$500 into a {name} farm on {chain} and harvest the rewards weekly for 6–8 weeks instead of letting them sit unclaimed. Cost: the deposit plus about {gas} per harvest; time: 10 minutes a week.',
  ],
  liquidity_manager: [
    'Deposit $200–$1,000 into a {name} managed liquidity position on {chain} and hold it for 6–8 weeks while the manager rebalances the range. Cost: the deposit plus about {gas}; time: 20 minutes.',
  ],
  leveraged: [
    'Open a leveraged farming position of $100–$300 on {name} ({chain}) at no more than 2x leverage and hold it for 2–4 weeks. Liquidation risk is real above that, so stay small. Cost: the deposit plus borrow interest and about {gas}; time: 20 minutes.',
  ],
  privacy: [
    'Use {name} on {chain} for 3–5 small private transfers of $50–$200 each over a month, and keep your own notes of each one. Cost: the amounts moved plus about {gas} per transfer; time: 10 minutes each.',
  ],
  chain: [
    'Bridge $100–$500 into {chain} through {name} and use 2–3 native apps on the chain every week for a month: swaps, mints or votes. Cost: the bridged amount plus about {gas} per transaction; time: 15 minutes a week.',
  ],
  btc: [
    'Hold $100–$500 of {name} BTC-backed assets on {chain} for 8–12 weeks, and use them once in a lending or liquidity pool on the same chain so the holding is active, not idle. Cost: the holding plus about {gas}; time: 20 minutes.',
  ],
  cedefi: [
    'Deposit $200–$1,000 into {name} on {chain} and hold the position for 8–12 weeks. Read the custody terms first: part of the yield comes from off-chain venues. Cost: the deposit plus about {gas}; time: 20 minutes.',
  ],
  stablecoin: [
    'Mint or buy $100–$500 of {name} stablecoins on {chain}, hold them for 6–8 weeks, and use them once a week in a pool or payment so the balance moves. Cost: the amount plus about {gas}; time: 15 minutes a week.',
  ],
  options: [
    'Buy 2–3 small options of $50–$150 each on {name} ({chain}) over a month, with expiries 1–4 weeks out, and let each run to expiry or close it early. Cost: the premiums plus about {gas} per trade; time: 15 minutes per trade.',
  ],
  generic: [
    'Use {name}’s core feature on {chain} with $100–$500, in 3–5 separate sessions over a month, rather than once. Cost: the amount plus about {gas} per action; time: 15 minutes per session.',
  ],
  keep_active: [
    'Stay active: return to {name} at least once a week for 8 weeks, repeat the core action in a small size, and finish any quests or points tasks the app lists. Cost: about {gas} per weekly visit; time: 10–20 minutes a week.',
  ],
  track: [
    'Track the position in a spreadsheet: dates, amounts, chains and any points shown. Never pay anyone who promises an airdrop, and never enter a seed phrase anywhere. Cost: $0; time: 10 minutes a week.',
  ],
};

const CATEGORY_STEPS: Record<string, string[]> = {
  Dexs: ['dex'],
  Lending: ['lending'],
  Yield: ['yield'],
  Derivatives: ['derivatives'],
  CDP: ['cdp'],
  'Yield Aggregator': ['aggregator'],
  'Basis Trading': ['basis'],
  RWA: ['rwa'],
  'Risk Curators': ['curator'],
  'Onchain Capital Allocator': ['curator'],
  'Liquidity Manager': ['liquidity_manager'],
  'Leveraged Farming': ['leveraged'],
  Farm: ['farm'],
  'Staking Pool': ['staking'],
  Restaking: ['restaking'],
  Privacy: ['privacy'],
  Chain: ['chain'],
  'Anchor BTC': ['btc'],
  'Decentralized BTC': ['btc'],
  CeDeFi: ['cedefi'],
  'Dual-Token Stablecoin': ['stablecoin'],
  'Options Vault': ['options'],
};

/** Concrete farm steps for one protocol: onboard, its category's actions, stay active, track. */
export function buildFarmSteps(p: Protocol): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain);
  const fill = (t: string): string =>
    t.replaceAll('{name}', p.name).replaceAll('{chain}', chain).replaceAll('{gas}', gas);
  const keys = p.category !== null && p.category in CATEGORY_STEPS ? CATEGORY_STEPS[p.category]! : ['generic'];
  const steps: string[] = [fill(STEP_TEMPLATES.onboard![0]!)];
  for (const key of keys) for (const t of STEP_TEMPLATES[key]!) steps.push(fill(t));
  steps.push(fill(STEP_TEMPLATES.keep_active![0]!));
  steps.push(fill(STEP_TEMPLATES.track![0]!));
  return steps.map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 600);
}

// ---------------------------------------------------------------- the board

/** First validation failure of a board against the gate's shape, or null when it passes. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  const ranks = new Set<number>();
  let prev = Number.POSITIVE_INFINITY;
  let allSame = board.length > 1;
  let firstValue: number | null = null;
  for (const row of board) {
    if (typeof row.slug !== 'string' || row.slug.length < 1 || row.slug.length > 128 || /\s/.test(row.slug)) {
      return `row has a bad slug: ${String(row.slug)}`;
    }
    if (slugs.has(row.slug)) return `slug appears twice: ${row.slug}`;
    slugs.add(row.slug);
    if (!snapshot.protocols.some((p) => p.slug === row.slug)) return `slug is not in the snapshot: ${row.slug}`;
    if (typeof row.name !== 'string' || row.name.length === 0) return `row ${row.slug} has an empty name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `row ${row.slug} has a bad rank`;
    if (ranks.has(row.rank)) return `rank appears twice: ${row.rank}`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug} has a bad implied_value_usd`;
    }
    if (row.implied_value_usd > prev) return `implied_value_usd rises at rank ${row.rank}`;
    prev = row.implied_value_usd;
    if (firstValue === null) firstValue = row.implied_value_usd;
    else if (row.implied_value_usd !== firstValue) allSame = false;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug} holds ${Array.isArray(row.farm_steps) ? row.farm_steps.length : 'no'} farm steps`;
    }
    for (const s of row.farm_steps) {
      const t = typeof s === 'string' ? s.trim() : '';
      if (t.length < 20 || t.length > 600) return `row ${row.slug} has a farm step of ${t.length} characters`;
    }
  }
  for (let r = 1; r <= board.length; r++) if (!ranks.has(r)) return `rank ${r} is missing`;
  if (allSame) return 'every implied_value_usd is the same';
  for (const w of snapshot.watchlist) if (!slugs.has(w)) return `watchlist slug missing from the board: ${w}`;
  return null;
}

/**
 * Build the 200-row board and the dashboard data. Rank follows implied value, highest first;
 * ties break by score, then TVL, then slug, so the order is fixed no matter how it is run.
 */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: Radar } {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = snapshot.watchlist.map((s) => bySlug.get(s)!).filter(Boolean);
  const eligible = snapshot.protocols.filter((p) => recordsNoToken(p) && !isHouseExcluded(p));
  const eligibleNonWatch = eligible.filter((p) => !snapshot.watchlist.includes(p.slug));
  const logTvlMin = Math.log10(5_000_000);
  const logTvlMax = Math.log10(Math.max(...eligible.map((p) => p.tvl_usd)));
  const scored = new Map<string, ScoreParts>();
  for (const p of eligible) scored.set(p.slug, scoreProtocol(p, snapshot.as_of, logTvlMin, logTvlMax));
  const nonWatchByScore = [...eligibleNonWatch].sort((a, b) => {
    const sa = scored.get(a.slug)!.score;
    const sb = scored.get(b.slug)!.score;
    return sb - sa || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1);
  });
  const fillers = snapshot.protocols
    .filter((p) => isVersionOnlyExcluded(p) && !snapshot.watchlist.includes(p.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 2);
  const picked = new Map<string, { p: Protocol; filler: boolean }>();
  for (const p of watchlist) picked.set(p.slug, { p, filler: false });
  for (const p of nonWatchByScore.slice(0, 158)) picked.set(p.slug, { p, filler: false });
  for (const p of fillers) {
    if (!picked.has(p.slug)) picked.set(p.slug, { p, filler: true });
    scored.set(p.slug, scoreProtocol(p, snapshot.as_of, logTvlMin, logTvlMax));
  }
  const valued = [...picked.values()].map(({ p, filler }) => {
    const parts = scored.get(p.slug)!;
    return { p, filler, parts, value: impliedValueUsd(p, parts) };
  });
  valued.sort((a, b) => b.value - a.value || b.parts.score - a.parts.score || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const rows: DataRow[] = valued.map((v, i) => {
    const days = ageDays(v.p.listed_at, snapshot.as_of);
    return {
      slug: v.p.slug,
      name: v.p.name,
      rank: i + 1,
      implied_value_usd: v.value,
      farm_steps: buildFarmSteps(v.p),
      category: v.p.category ?? 'Uncategorised',
      chains: v.p.chains,
      tvl_usd: v.p.tvl_usd,
      change_7d: v.p.change_7d,
      age_years: days === null ? null : Math.round((days / 365.25) * 10) / 10,
      score: Math.round(v.parts.score * 10000) / 10000,
      parts: {
        size: Math.round(v.parts.size * 10000) / 10000,
        growth: Math.round(v.parts.growth * 10000) / 10000,
        age: Math.round(v.parts.age * 10000) / 10000,
        chains: Math.round(v.parts.chains * 10000) / 10000,
        sector: Math.round(v.parts.sector * 10000) / 10000,
        score: Math.round(v.parts.score * 10000) / 10000,
      },
      watchlist: snapshot.watchlist.includes(v.p.slug),
      filler: v.filler,
    };
  });
  const board: BoardRow[] = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  }));
  const tokenized = snapshot.protocols.filter((p) => !recordsNoToken(p));
  const liveTop = [...tokenized]
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, 10)
    .map((p) => ({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd }));
  const radar: Radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    protocols_total: snapshot.protocols.length,
    tokenized_total: tokenized.length,
    eligible_total: eligible.length,
    watchlist_size: snapshot.watchlist.length,
    early_size: eligibleNonWatch.length,
    filler_size: fillers.length,
    live_size: tokenized.length,
    board,
    rows,
    live_top: liveTop,
    categories: [...new Set(rows.map((r) => r.category))].sort(),
  };
  return { board, radar };
}

/** The dashboard's data file: `window.TOKEN_RADAR = {...};` with fixed key order, 2-space indent. */
export function dataScript(radar: Radar): string {
  const data = {
    as_of: radar.as_of,
    floor_usd: radar.floor_usd,
    protocols_total: radar.protocols_total,
    tokenized_total: radar.tokenized_total,
    eligible_total: radar.eligible_total,
    watchlist_size: radar.watchlist_size,
    early_size: radar.early_size,
    filler_size: radar.filler_size,
    live_size: radar.live_size,
    categories: radar.categories,
    rows: radar.rows,
    live_top: radar.live_top,
  };
  return `window.TOKEN_RADAR = ${JSON.stringify(data, null, 2)};\n`;
}
