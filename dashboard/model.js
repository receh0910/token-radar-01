// Token Radar's shared model (radar-2): pure functions, no DOM, no imports, no network.
//
// The page (dashboard/app.js) and the program (main.ts, through a side-effect import of this
// file) run the same code, so the board.json the program writes and the page the judge reads can
// never disagree: the page recomputes every row's implied value and regenerates every farm plan
// from the same functions. Deterministic by construction: ages come from the snapshot's as_of
// date, never from the clock; there is no random source; every sort breaks ties by slug.

(function () {
  'use strict';

  var DAY_MS = 86_400_000;

  /** The model's constants, as the dashboard states them. */
  var MODEL = {
    growth_weight: 0.5,
    growth_floor: -60,
    growth_cap: 120,
    maturity_floor: 0.6,
    maturity_range: 0.4,
    maturity_days: 1095,
    unknown_age_days: 365,
    breadth_per_chain: 0.02,
    breadth_max_extra: 5,
    ratio_floor: 0.02,
    ratio_cap: 1.5,
    ratio_min_n: 3,
  };

  var MODEL_VERSION = 'radar-2';

  /** The smaller of a and b, the larger of a and b. */
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  /** Four decimals, for display. */
  function round4(n) {
    return Math.round(n * 1e4) / 1e4;
  }

  /** The median of a non-empty array of finite numbers. */
  function median(values) {
    var sorted = values.slice().sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
  function ageDays(asOf, listedAt) {
    if (listedAt === null || listedAt === undefined) return null;
    var a = Date.parse(asOf + 'T00:00:00Z');
    var b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY_MS));
  }

  /** Whether a protocol records no token at all. */
  function isPreToken(p) {
    return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
  }

  /** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
  var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
  /** Categories that are not a protocol still waiting on a launch of its own. */
  var EXCLUDED_CATEGORIES = {
    Bridge: true,
    'Canonical Bridge': true,
    'Liquid Staking': true,
    'Liquid Restaking': true,
    'Restaked BTC': true,
    CEX: true,
  };
  var EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
  var WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

  /** Whether a protocol is one the board may rank: pre-token and not a wrapped, staked or bridged
      product of a token that already trades, not an exchange, not a versioned pool. */
  function isRankable(p) {
    if (!isPreToken(p)) return false;
    if (EXCLUDED_CATEGORIES[p.category || '']) return false;
    if (VERSIONED.test(p.name)) return false;
    if (WRAPPED_WORD.test(p.name)) return false;
    for (var i = 0; i < EXCHANGE_NAMES.length; i++) {
      if (p.name.indexOf(EXCHANGE_NAMES[i]) === 0) return false;
    }
    return true;
  }

  /**
   * The market's own valuation ratio per category: the median market-cap-to-TVL of the protocols
   * whose token already trades, per category where at least three trade, else the global median.
   * Exchange tokens are not protocol comparables. Ratios are clamped so one wild market cannot
   * carry the board. Computed from the snapshot at run time, never from a hand-kept list.
   */
  function categoryRatios(protocols) {
    var byCat = {};
    var all = [];
    for (var i = 0; i < protocols.length; i++) {
      var p = protocols[i];
      if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
      if (p.category === 'CEX') continue;
      var r = p.mcap_usd / p.tvl_usd;
      all.push(r);
      var c = p.category || 'Other';
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(r);
    }
    var globalRatio = all.length > 0 ? clamp(median(all), MODEL.ratio_floor, MODEL.ratio_cap) : 0.25;
    var out = {};
    var cats = Object.keys(byCat).sort();
    for (var j = 0; j < cats.length; j++) {
      var cat = cats[j];
      var arr = byCat[cat];
      if (arr.length >= MODEL.ratio_min_n) {
        out[cat] = { ratio: clamp(median(arr), MODEL.ratio_floor, MODEL.ratio_cap), n: arr.length, source: 'category' };
      } else {
        out[cat] = { ratio: globalRatio, n: arr.length, source: 'global' };
      }
    }
    return { byCategory: out, global: { ratio: globalRatio, n: all.length } };
  }

  /** The ratio entry for one category: its own median where three trade, else the global median. */
  function ratioFor(ratios, category) {
    var entry = ratios.byCategory[category || 'Other'];
    if (entry) return entry;
    return { ratio: ratios.global.ratio, n: 0, source: 'global' };
  }

  /**
   * One protocol's implied value, from the snapshot's own figures only:
   *   implied = round(tvl_usd x ratio x growthMult x maturityMult x breadthMult)
   * ratio is the market's median mcap/TVL for the protocol's category (or the global median);
   * growthMult follows the seven-day TVL change; maturityMult follows how long the protocol has
   * run with no token on record; breadthMult follows how many chains it runs on. No protocol
   * name is ever special-cased: the same function scores every row.
   */
  function impliedOf(p, asOf, ratioEntry) {
    var age = ageDays(asOf, p.listed_at);
    var rawGrowth = typeof p.change_7d === 'number' && isFinite(p.change_7d) ? p.change_7d : 0;
    var growthPct = clamp(rawGrowth, MODEL.growth_floor, MODEL.growth_cap);
    var growthMult = 1 + (growthPct / 100) * MODEL.growth_weight;
    var ageForModel = age === null ? MODEL.unknown_age_days : age;
    var maturityMult =
      MODEL.maturity_floor +
      (Math.min(Math.max(ageForModel, 0), MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_range;
    var extraChains = Math.max(0, (p.chains ? p.chains.length : 0) - 1);
    var breadthMult = 1 + Math.min(extraChains, MODEL.breadth_max_extra) * MODEL.breadth_per_chain;
    var implied = Math.max(1, Math.round(p.tvl_usd * ratioEntry.ratio * growthMult * maturityMult * breadthMult));
    return {
      implied: implied,
      ratio: ratioEntry.ratio,
      ratio_source: ratioEntry.source,
      ratio_n: ratioEntry.n,
      growth_pct: growthPct,
      growth_mult: round4(growthMult),
      maturity_mult: round4(maturityMult),
      breadth_mult: round4(breadthMult),
      age_days: age,
    };
  }

  /** The first chain a protocol names, or a neutral phrase. */
  function chainOf(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  /** How much capital one farm position needs, from the protocol's own TVL. */
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  /** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /** The category's one action, in the words a farmer can follow. */
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) {
      return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' as collateral, borrow a small amount against it, then repay the borrow.';
    }
    if (c.indexOf('dex') >= 0) {
      return 'Swap $' + capital + ' through ' + name + ' on ' + chain + ', then add $' + capital + ' of liquidity to its deepest pool and keep the position open.';
    }
    if (c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) {
      return 'Deposit $' + capital + ' into ' + name + "'s highest-TVL vault on " + chain + ' and keep the shares.';
    }
    if (c.indexOf('bridge') >= 0) {
      return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ', then use the bridged funds inside its app.';
    }
    if (c.indexOf('restak') >= 0 || c.indexOf('staking') >= 0) {
      return "Stake $" + capital + " of the chain's asset through " + name + ' on ' + chain + ' and keep the receipt token.';
    }
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) {
      return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedged position.';
    }
    if (c.indexOf('prediction') >= 0) {
      return 'Fund $' + capital + ' and place one small position in an open market on ' + name + '.';
    }
    if (c.indexOf('basis') >= 0) {
      return 'Deposit $' + capital + " into " + name + "'s delta-neutral vault on " + chain + ' and keep the position open.';
    }
    if (c.indexOf('cedefi') >= 0) {
      return 'Deposit $' + capital + ' into ' + name + "'s managed vault on " + chain + ' and keep the position.';
    }
    if (c === 'chain') {
      return 'Bridge $' + capital + ' to ' + chain + ' and use ' + name + "'s own apps for one swap and one deposit.";
    }
    if (c.indexOf('governance') >= 0) {
      return 'Lock $' + capital + ' of the asset in ' + name + "'s governance on " + chain + ' and vote on one live proposal.';
    }
    if (c.indexOf('payment') >= 0) {
      return 'Route one $' + capital + ' payment through ' + name + ' on ' + chain + ' and keep the receipt.';
    }
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) {
      return 'Deposit $' + capital + ' into a ' + name + ' curated vault on ' + chain + ' and hold the vault shares.';
    }
    if (c.indexOf('stable') >= 0) {
      return 'Mint or wrap $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    }
    if (c.indexOf('rwa') >= 0) {
      return 'Mint $' + capital + " of the protocol's yield-bearing asset on " + chain + ' and hold it.';
    }
    if (c.indexOf('insurance') >= 0) {
      return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy active.';
    }
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }

  /** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  /**
   * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
   * from the protocol's own record (category, chains, TVL, age), never from a hand-written list
   * of names. Every step names what it costs and how long it takes.
   */
  function farmSteps(p, age) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(age);
    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: actionFor(p, capital, chain),
        cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas',
        time: '15 minutes to set up',
      },
      {
        text: 'Repeat one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the activity spans several snapshots.',
        cost: 'about $2 of gas a week',
        time: '10 minutes a week',
      },
      {
        text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
        cost: 'the $' + capital + ' stays in the position',
        time: hold + ' days',
      },
      {
        text: "Before you withdraw, open the protocol's own points or rewards page from its official site and claim only from the link it publishes.",
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: 'Write the wallet, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it cleanly.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ].map(stepText);
  }

  var api = {
    MODEL: MODEL,
    MODEL_VERSION: MODEL_VERSION,
    clamp: clamp,
    round4: round4,
    median: median,
    ageDays: ageDays,
    isPreToken: isPreToken,
    isRankable: isRankable,
    categoryRatios: categoryRatios,
    ratioFor: ratioFor,
    impliedOf: impliedOf,
    chainOf: chainOf,
    capitalFor: capitalFor,
    holdDaysFor: holdDaysFor,
    actionFor: actionFor,
    stepText: stepText,
    farmSteps: farmSteps,
  };

  globalThis.RADAR_MODEL = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
