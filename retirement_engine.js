/*
 * Retirement projection engine.
 *
 * This is the ONLY place where pots are projected. Every dashboard tab calls
 * RetirementEngine.project(); the test suite runs this exact file under Node.
 * Plain JavaScript, no DOM access, no dependencies.
 *
 * Model (annual steps, whole-age snapshots):
 *  - Two buckets: pension (SIPP / workplace) and ISA (plus any other accessible money).
 *  - Contributions go into the pension monthly until retirement.
 *  - Pension money cannot be touched before `pensionAccessAge` (UK normal minimum
 *    pension age rises to 57 from 6 April 2028). Before that age, spending comes from
 *    the ISA bucket only; if it runs out, the year is recorded as a shortfall.
 *  - Each year's spending target is NET (after tax). Withdrawal order:
 *      1. Pension, up to the amount whose taxable 75% fits in the unused personal
 *         allowance (after State Pension) -> tax-free. With no State Pension this
 *         is the familiar £16,760 UFPLS.
 *      2. ISA (tax-free).
 *      3. More pension, grossed up for income tax at the marginal rate.
 *  - Pension withdrawals are UFPLS-style: 25% tax-free (capped by the Lump Sum
 *    Allowance), 75% taxable. State Pension is taxable income.
 *  - Withdrawals happen at the start of each year of age, then the remaining
 *    balances grow for the year.
 *  - Tax bands are England/Wales/NI rates. Bands grow at `taxBandGrowth`
 *    (default: same as inflation, i.e. constant in real terms). The Lump Sum
 *    Allowance is a fixed cash amount.
 */
(function (root) {
  'use strict';

  const UK_TAX = {
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    additionalThreshold: 125140,
    basicRate: 0.20,
    higherRate: 0.40,
    additionalRate: 0.45,
    taxFreeFraction: 0.25,
    lumpSumAllowance: 268275
  };

  const NORMAL_MINIMUM_PENSION_AGE = 57;

  function personalAllowance(income, scale) {
    const pa = UK_TAX.personalAllowance * scale;
    const taper = UK_TAX.paTaperThreshold * scale;
    if (income <= taper) return pa;
    return Math.max(0, pa - (income - taper) / 2);
  }

  /** UK income tax on total taxable income. `scale` indexes the thresholds. */
  function incomeTax(income, scale) {
    const s = scale || 1;
    if (income <= 0) return 0;
    const pa = personalAllowance(income, s);
    const band = UK_TAX.basicRateBand * s;
    const addThr = UK_TAX.additionalThreshold * s;
    const basic = Math.max(0, Math.min(income - pa, band));
    const higher = Math.max(0, Math.min(income, addThr) - pa - band);
    const additional = Math.max(0, income - addThr);
    return basic * UK_TAX.basicRate + higher * UK_TAX.higherRate + additional * UK_TAX.additionalRate;
  }

  /** Split a gross pension withdrawal into tax-free and taxable parts. */
  function splitPensionDraw(gross, lsaRemaining) {
    const taxFree = Math.min(gross * UK_TAX.taxFreeFraction, Math.max(0, lsaRemaining));
    return { taxFree: taxFree, taxable: gross - taxFree };
  }

  /** Largest gross pension draw whose taxable part fits inside `room`. */
  function grossFillingRoom(room, lsaRemaining) {
    if (room <= 0) return 0;
    const g = room / (1 - UK_TAX.taxFreeFraction);
    if (g * UK_TAX.taxFreeFraction <= lsaRemaining) return g;
    return room + Math.max(0, lsaRemaining);
  }

  function currentAgeFromDob(dob, today) {
    const birth = (dob instanceof Date) ? dob : new Date(dob + 'T00:00:00Z');
    const now = today ? ((today instanceof Date) ? today : new Date(today + 'T00:00:00Z')) : new Date();
    return (now.getTime() - birth.getTime()) / (365.2425 * 24 * 3600 * 1000);
  }

  const DEFAULTS = {
    currentAge: null,           // required (or pass dob)
    dob: null,
    today: null,
    pension: 0,                 // starting pension balance
    isa: 0,                     // starting ISA / accessible balance
    monthlyContribution: 0,     // into pension, until retirement
    retirementAge: 57,
    pensionAccessAge: NORMAL_MINIMUM_PENSION_AGE,
    endAge: 85,
    annualReturn: 0.04,         // real if inflation = 0, nominal otherwise
    inflation: 0,
    spend: 35000,               // NET annual spending target
    spendBaseAge: null,         // age at which `spend` is expressed (default: retirementAge)
    statePension: 12548,        // gross annual, in today's money (Statutory GOV.UK forecast: £241.30/wk)
    statePensionAge: 67,
    statePensionGrowth: null,   // default: inflation
    statePensionMultiplier: null, // optional fn(age) -> multiplier (legacy spreadsheet mode)
    otherNetIncome: 0,          // untaxed household income from statePensionAge (e.g. partner's SP)
    crashAtRetirement: 0,       // fractional fall applied to both buckets at retirement
    lumpSum: 0,                 // one-off NET outlay
    lumpSumAge: 60,
    applyTax: true,
    taxBandGrowth: null,        // default: inflation
    guardrails: false           // Guyton-Klinger dynamic spending rules (±10% spending belt-tightening)
  };

  function project(input) {
    const p = Object.assign({}, DEFAULTS, input || {});
    let a0 = p.currentAge;
    if (a0 === null || a0 === undefined) {
      if (!p.dob) throw new Error('project() needs currentAge or dob');
      a0 = currentAgeFromDob(p.dob, p.today);
    }
    const inflation = p.inflation || 0;
    const spGrowth = (p.statePensionGrowth === null || p.statePensionGrowth === undefined) ? inflation : p.statePensionGrowth;
    const bandGrowth = (p.taxBandGrowth === null || p.taxBandGrowth === undefined) ? inflation : p.taxBandGrowth;
    const firstAge = Math.ceil(a0 - 1e-9);
    const retAge = Math.max(firstAge, Math.round(p.retirementAge));
    const spendBaseAge = (p.spendBaseAge === null || p.spendBaseAge === undefined) ? retAge : p.spendBaseAge;
    const r = p.annualReturn;
    const mRate = Math.pow(1 + r, 1 / 12) - 1;
    const taxFn = p.applyTax ? incomeTax : function () { return 0; };

    let pension = Math.max(0, p.pension);
    let isa = Math.max(0, p.isa);
    let lsaRemaining = UK_TAX.lumpSumAllowance;

    function accumulate(years, contribute) {
      const months = Math.round(years * 12);
      let contributed = 0;
      for (let m = 0; m < months; m++) {
        if (contribute) { pension += p.monthlyContribution; contributed += p.monthlyContribution; }
        pension *= (1 + mRate);
        isa *= (1 + mRate);
      }
      return contributed;
    }

    // Partial first period: today -> next birthday.
    const totalContributions0 = accumulate(firstAge - a0, firstAge <= retAge);
    let totalContributions = totalContributions0;

    const rows = [];
    let potAtRetirement = null;
    let pensionAtRetirement = null;
    let isaAtRetirement = null;
    let depletionAge = null;
    let firstShortfallAge = null;
    let shortfallReason = null;
    let totalShortfall = 0;
    let lifetimeTax = 0;
    let lifetimeTaxFree = 0;
    let iwr = 0;

    for (let age = firstAge; age <= p.endAge; age++) {
      if (age === retAge) {
        potAtRetirement = pension + isa;
        pensionAtRetirement = pension;
        isaAtRetirement = isa;
        if (p.crashAtRetirement > 0) {
          pension *= (1 - p.crashAtRetirement);
          isa *= (1 - p.crashAtRetirement);
        }
        const openingRetPot = pension + isa;
        iwr = openingRetPot > 0 ? (p.spend / openingRetPot) : 0;
      }

      const row = {
        age: age,
        pension: pension,
        isa: isa,
        total: pension + isa,
        phase: age < retAge ? 'accumulation' : (age < p.statePensionAge ? 'bridge' : 'state_pension'),
        pensionAccessible: age >= p.pensionAccessAge,
        contribution: 0,
        spend: 0,
        statePension: 0,
        otherIncome: 0,
        pensionGross: 0,
        pensionTaxFree: 0,
        isaWithdrawal: 0,
        tax: 0,
        netIncome: 0,
        shortfall: 0
      };
      rows.push(row);
      if (age === p.endAge) break;

      if (age < retAge) {
        row.contribution = accumulate(1, true);
        totalContributions += row.contribution;
        continue;
      }

      // ---- Decumulation year ----
      const bandScale = Math.pow(1 + bandGrowth, age - a0);
      let baseSpend = p.spend * Math.pow(1 + inflation, age - spendBaseAge);
      if (p.guardrails && age > retAge && iwr > 0) {
        const currentPot = pension + isa;
        const currentWr = currentPot > 0 ? (baseSpend / currentPot) : 1.0;
        if (currentWr > 1.20 * iwr) {
          baseSpend *= 0.90; // Capital preservation rule: trim spending by 10%
        } else if (currentWr < 0.80 * iwr) {
          baseSpend *= 1.10; // Prosperity rule: expand spending by 10%
        }
      }
      const spendNeed = baseSpend
        + ((p.lumpSum > 0 && age === p.lumpSumAge) ? p.lumpSum * Math.pow(1 + inflation, age - a0) : 0);
      let sp = 0;
      let other = 0;
      if (age >= p.statePensionAge) {
        const mult = p.statePensionMultiplier ? p.statePensionMultiplier(age) : 1;
        sp = p.statePension * Math.pow(1 + spGrowth, age - a0) * mult;
        other = p.otherNetIncome * Math.pow(1 + spGrowth, age - a0);
      }

      const taxOnSp = taxFn(sp, bandScale);
      let remaining = spendNeed - (sp - taxOnSp) - other;
      let pensionGross = 0;
      let isaDraw = 0;

      if (remaining < 0) {
        // Guaranteed income exceeds spending: reinvest surplus in the ISA bucket.
        isa += -remaining;
        remaining = 0;
      }

      const accessible = age >= p.pensionAccessAge;

      // 1. Tax-free pension slice (fills unused personal allowance).
      if (accessible && remaining > 0 && pension > 0) {
        const room = p.applyTax ? Math.max(0, personalAllowance(sp, bandScale) - sp) : Infinity;
        const g1 = Math.min(grossFillingRoom(room, lsaRemaining), pension, remaining);
        pensionGross += g1;
        remaining -= g1;
      }

      // 2. ISA.
      if (remaining > 0 && isa > 0) {
        isaDraw = Math.min(isa, remaining);
        remaining -= isaDraw;
      }

      // 3. Further pension, grossed up for tax.
      if (accessible && remaining > 1e-9 && pension - pensionGross > 0) {
        const base = pensionGross;
        const netOf = function (extra) {
          const before = splitPensionDraw(base, lsaRemaining);
          const after = splitPensionDraw(base + extra, lsaRemaining);
          return extra - (taxFn(sp + after.taxable, bandScale) - taxFn(sp + before.taxable, bandScale));
        };
        const maxExtra = pension - base;
        let extra;
        if (netOf(maxExtra) <= remaining) {
          extra = maxExtra;
        } else {
          let lo = 0, hi = maxExtra;
          for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (netOf(mid) < remaining) lo = mid; else hi = mid;
          }
          extra = hi;
        }
        remaining -= netOf(extra);
        pensionGross += extra;
      }

      const split = splitPensionDraw(pensionGross, lsaRemaining);
      const tax = taxFn(sp + split.taxable, bandScale);
      lsaRemaining -= split.taxFree;
      pension -= pensionGross;
      isa -= isaDraw;
      if (pension < 1e-6) pension = 0;
      if (isa < 1e-6) isa = 0;

      const shortfall = Math.max(0, remaining);
      row.spend = spendNeed;
      row.statePension = sp;
      row.otherIncome = other;
      row.pensionGross = pensionGross;
      row.pensionTaxFree = split.taxFree;
      row.isaWithdrawal = isaDraw;
      row.tax = tax;
      row.netIncome = sp + other + pensionGross + isaDraw - tax;
      row.shortfall = shortfall;
      lifetimeTax += tax;
      lifetimeTaxFree += split.taxFree;

      if (shortfall > 0.5) {
        totalShortfall += shortfall;
        const fractionCovered = spendNeed > 0 ? Math.max(0, Math.min(1, 1 - shortfall / spendNeed)) : 1;
        if (firstShortfallAge === null) {
          firstShortfallAge = Number((age + fractionCovered).toFixed(1));
          shortfallReason = (!accessible && pension > 0) ? 'pension_locked' : 'exhausted';
        }
        if (depletionAge === null && pension <= 0 && isa <= 0) {
          depletionAge = Number((age + fractionCovered).toFixed(1));
        }
      }

      pension *= (1 + r);
      isa *= (1 + r);
    }

    const last = rows[rows.length - 1];
    return {
      currentAge: a0,
      retirementAge: retAge,
      potAtRetirement: potAtRetirement === null ? last.total : potAtRetirement,
      pensionAtRetirement: pensionAtRetirement,
      isaAtRetirement: isaAtRetirement,
      potAfterCrash: potAtRetirement === null ? last.total : potAtRetirement * (1 - (p.crashAtRetirement || 0)),
      endPot: last.total,
      depletionAge: depletionAge,
      firstShortfallAge: firstShortfallAge,
      shortfallReason: shortfallReason,
      totalShortfall: totalShortfall,
      solvent: firstShortfallAge === null,
      lifetimeTax: lifetimeTax,
      lifetimeTaxFree: lifetimeTaxFree,
      totalContributions: totalContributions,
      rows: rows,
      rowAt: function (age) {
        for (let i = 0; i < rows.length; i++) if (rows[i].age === age) return rows[i];
        return null;
      }
    };
  }

  /** Highest NET annual spend with no shortfall in any year up to endAge. */
  function maxSustainableSpend(input) {
    let lo = 0, hi = 300000;
    if (!project(Object.assign({}, input, { spend: lo })).solvent) return 0;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (project(Object.assign({}, input, { spend: mid })).solvent) lo = mid; else hi = mid;
    }
    return lo;
  }

  function mulberry32(a) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function randn(prng) {
    let u = 0, v = 0;
    while (u === 0) u = prng();
    while (v === 0) v = prng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Monte Carlo Stochastic Simulation (1,000 randomized market paths).
   * Models annual market volatility (e.g. sigma = 12%), sequence of returns risk,
   * UK pension drawdown tax rules, and evaluates empirical plan success probability %.
   */
  function monteCarlo(input, options) {
    options = options || {};
    const paths = options.paths || 1000;
    const vol = (options.volatility !== undefined) ? options.volatility : 0.12;
    const prng = (options.seed !== undefined && options.seed !== null) ? mulberry32(options.seed) : Math.random;

    const p = Object.assign({}, DEFAULTS, input || {});
    if (options.guardrails !== undefined) p.guardrails = options.guardrails;
    let a0 = p.currentAge;
    if (a0 === null || a0 === undefined) {
      if (!p.dob) throw new Error('monteCarlo needs currentAge or dob');
      a0 = currentAgeFromDob(p.dob, p.today);
    }
    const firstAge = Math.ceil(a0 - 1e-9);
    const retAge = Math.max(firstAge, Math.round(p.retirementAge));
    const endAge = p.endAge || 85;
    const mu = p.annualReturn;

    const inflation = p.inflation || 0;
    const spendBaseAge = (p.spendBaseAge === null || p.spendBaseAge === undefined) ? retAge : p.spendBaseAge;
    const spGrowth = (p.statePensionGrowth === null || p.statePensionGrowth === undefined) ? inflation : p.statePensionGrowth;
    const pensionAccessAge = (p.pensionAccessAge === null || p.pensionAccessAge === undefined) ? NORMAL_MINIMUM_PENSION_AGE : p.pensionAccessAge;

    const ageLabels = [];
    for (let a = firstAge; a <= endAge; a++) ageLabels.push(a);

    const trajectoryMatrix = Array.from({ length: ageLabels.length }, () => new Float64Array(paths));
    let solventCount = 0;

    for (let k = 0; k < paths; k++) {
      let pension = Math.max(0, p.pension);
      let isa = Math.max(0, p.isa);

      const fracYears = firstAge - a0;
      const fracMonths = Math.round(fracYears * 12);
      for (let m = 0; m < fracMonths; m++) {
        if (firstAge <= retAge) pension += p.monthlyContribution;
        const mR = Math.pow(1 + Math.max(-0.9, mu + vol * randn(prng)), 1 / 12) - 1;
        pension *= (1 + mR);
        isa *= (1 + mR);
      }

      let pathDepleted = false;
      let pathIwr = 0;

      for (let idx = 0; idx < ageLabels.length; idx++) {
        const age = ageLabels[idx];

        if (age < retAge) {
          trajectoryMatrix[idx][k] = pension + isa;
          for (let m = 0; m < 12; m++) {
            pension += p.monthlyContribution;
            const mR = Math.pow(1 + Math.max(-0.9, mu + vol * randn(prng)), 1 / 12) - 1;
            pension *= (1 + mR);
            isa *= (1 + mR);
          }
        } else {
          if (age === retAge && p.crashAtRetirement > 0) {
            pension *= (1 - p.crashAtRetirement);
            isa *= (1 - p.crashAtRetirement);
          }

          const totalOpening = pension + isa;
          trajectoryMatrix[idx][k] = totalOpening;

          if (age === retAge) {
            pathIwr = totalOpening > 0 ? (p.spend / totalOpening) : 0;
          }

          if (totalOpening <= 0 && !pathDepleted) {
            pathDepleted = true;
          }

          if (!pathDepleted) {
            let spIncome = 0;
            if (age >= p.statePensionAge) {
              spIncome = p.statePension * Math.pow(1 + spGrowth, age - a0);
            }
            let baseSpend = p.spend * Math.pow(1 + inflation, age - spendBaseAge);
            if (p.guardrails && age > retAge && pathIwr > 0) {
              const currentPot = pension + isa;
              const currentWr = currentPot > 0 ? (baseSpend / currentPot) : 1.0;
              if (currentWr > 1.20 * pathIwr) {
                baseSpend *= 0.90; // Capital preservation rule: trim spending by 10%
              } else if (currentWr < 0.80 * pathIwr) {
                baseSpend *= 1.10; // Prosperity rule: expand spending by 10%
              }
            }
            let netTarget = baseSpend;
            if (age === p.lumpSumAge && p.lumpSum > 0) {
              netTarget += p.lumpSum * Math.pow(1 + inflation, age - a0);
            }
            const netNeeded = Math.max(0, netTarget - spIncome);

            const canAccessPension = (age >= pensionAccessAge);
            let shortfall = 0;

            if (!canAccessPension) {
              if (isa >= netNeeded) {
                isa -= netNeeded;
              } else {
                shortfall = netNeeded - isa;
                isa = 0;
              }
            } else {
              const paRoom = Math.max(0, UK_TAX.personalAllowance * Math.pow(1 + inflation, age - a0) - spIncome);
              const ufplsGross = paRoom / (1 - UK_TAX.taxFreeFraction);
              const p1 = Math.min(pension, Math.min(netNeeded, ufplsGross));
              pension -= p1;
              let netRemaining = netNeeded - p1;

              if (netRemaining > 0) {
                const fromIsa = Math.min(isa, netRemaining);
                isa -= fromIsa;
                netRemaining -= fromIsa;
              }

              if (netRemaining > 0) {
                const grossNeeded = netRemaining / 0.85;
                if (pension >= grossNeeded) {
                  pension -= grossNeeded;
                  netRemaining = 0;
                } else {
                  shortfall = netRemaining - pension * 0.85;
                  pension = 0;
                }
              }
            }

            if (shortfall > 0 || (pension <= 0 && isa <= 0)) {
              pathDepleted = true;
            } else {
              const r_t = mu + vol * randn(prng);
              pension = Math.max(0, pension * (1 + r_t));
              isa = Math.max(0, isa * (1 + r_t));
            }
          }
        }
      }

      if (!pathDepleted) solventCount++;
    }

    const p10 = [], p25 = [], p50 = [], p75 = [], p90 = [];
    for (let idx = 0; idx < ageLabels.length; idx++) {
      const sorted = Array.from(trajectoryMatrix[idx]).sort((a, b) => a - b);
      p10.push(Math.round(sorted[Math.floor(paths * 0.10)]));
      p25.push(Math.round(sorted[Math.floor(paths * 0.25)]));
      p50.push(Math.round(sorted[Math.floor(paths * 0.50)]));
      p75.push(Math.round(sorted[Math.floor(paths * 0.75)]));
      p90.push(Math.round(sorted[Math.floor(paths * 0.90)]));
    }

    const rows = ageLabels.map((age, i) => ({
      age: age,
      p10: p10[i],
      p25: p25[i],
      p50: p50[i],
      p75: p75[i],
      p90: p90[i]
    }));

    const successRate = (solventCount / paths) * 100;
    return {
      paths: paths,
      volatility: vol,
      successRate: Number(successRate.toFixed(1)),
      solventPaths: solventCount,
      depletedPaths: paths - solventCount,
      medianEndPot: p50[p50.length - 1],
      p10EndPot: p10[p10.length - 1],
      p90EndPot: p90[p90.length - 1],
      ageLabels: ageLabels,
      rows: rows,
      p10: p10,
      p25: p25,
      p50: p50,
      p75: p75,
      p90: p90
    };
  }

  const API = {
    UK_TAX: UK_TAX,
    NORMAL_MINIMUM_PENSION_AGE: NORMAL_MINIMUM_PENSION_AGE,
    DEFAULTS: DEFAULTS,
    incomeTax: incomeTax,
    personalAllowance: personalAllowance,
    splitPensionDraw: splitPensionDraw,
    currentAgeFromDob: currentAgeFromDob,
    project: project,
    maxSustainableSpend: maxSustainableSpend,
    monteCarlo: monteCarlo
  };

  root.RetirementEngine = API;
  if (typeof globalThis !== 'undefined') globalThis.RetirementEngine = API;
  if (typeof window !== 'undefined') window.RetirementEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

var RetirementEngine = (typeof window !== 'undefined' && window.RetirementEngine) || (typeof globalThis !== 'undefined' && globalThis.RetirementEngine) || (typeof this !== 'undefined' && this.RetirementEngine);

