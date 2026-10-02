import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ES module without type declarations
import * as funding from '../../scripts/funding.mjs';

const {
  CONFIG, MARK_START, MARK_END,
  sumGithub, sumBmcSupporters, sumBmcMemberships,
  buildState, phaseFor, renderBlock, inject, formatDate,
} = funding;

const notConfigured = { status: 'not-configured' };
const ok = (cents: number, supporters: number) => ({ status: 'ok', cents, supporters });
const during = new Date('2026-10-15T12:00:00Z');
const after = new Date('2026-11-05T12:00:00Z');

describe('sumGithub', () => {
  it('adds what each sponsor has paid and counts only paying sponsors', () => {
    expect(sumGithub([{ amountInCents: 700 }, { amountInCents: 2500 }, { amountInCents: 0 }]))
      .toEqual({ cents: 3200, supporters: 2 });
  });

  it('is zero for an account without sponsors', () => {
    expect(sumGithub([])).toEqual({ cents: 0, supporters: 0 });
  });

  it('refuses a response it does not understand instead of reading it as zero', () => {
    expect(() => sumGithub(undefined)).toThrow(/not a list/);
    expect(() => sumGithub([{ amount: 700 }])).toThrow(/amountInCents/);
  });
});

describe('sumBmcSupporters', () => {
  const base = { support_coffees: 3, support_coffee_price: '5.0000', support_currency: 'USD', support_created_on: '2026-10-03 09:00:00', is_refunded: null };

  it('multiplies coffees by price', () => {
    expect(sumBmcSupporters([base])).toEqual({ cents: 1500, supporters: 1 });
  });

  it('leaves out refunds and anything before the campaign started', () => {
    expect(sumBmcSupporters([
      { ...base, is_refunded: true },
      { ...base, support_created_on: '2026-09-30 23:59:59' },
    ])).toEqual({ cents: 0, supporters: 0 });
  });

  it('reads the refund flag in every form the API sends it', () => {
    const paid = [null, undefined, false, 0, '0'].map((is_refunded) => ({ ...base, is_refunded }));
    expect(sumBmcSupporters(paid)).toEqual({ cents: 7500, supporters: 5 });
    const refunded = [true, 1, '1'].map((is_refunded) => ({ ...base, is_refunded }));
    expect(sumBmcSupporters([...refunded, { ...base, refunded_at: '2026-10-04 10:00:00' }])).toEqual({ cents: 0, supporters: 0 });
  });

  it('does not count free downloads as supporters', () => {
    expect(sumBmcSupporters([{ ...base, support_coffee_price: '0.0000' }, { ...base, support_coffees: 0 }]))
      .toEqual({ cents: 0, supporters: 0 });
  });

  it('converts euros with the configured rate', () => {
    expect(sumBmcSupporters([{ ...base, support_coffees: 1, support_coffee_price: 10, support_currency: 'EUR' }]).cents)
      .toBe(Math.round(10 * CONFIG.usdPerUnit.EUR * 100));
  });

  it('fails on a currency without a rate', () => {
    expect(() => sumBmcSupporters([{ ...base, support_currency: 'GBP' }])).toThrow(/GBP/);
  });

  it('fails on a response without the expected fields', () => {
    expect(() => sumBmcSupporters([{ coffees: 3 }])).toThrow(/support_created_on/);
    expect(() => sumBmcSupporters([{ ...base, support_coffee_price: 'free' }])).toThrow(/support_coffee_price/);
  });
});

describe('sumBmcMemberships', () => {
  const monthly = { subscription_coffee_price: '7.0000', subscription_coffee_num: 1, subscription_currency: 'USD', subscription_duration_type: 'month', subscription_created_on: '2026-10-05 10:00:00', subscription_cancelled_on: null };

  it('counts one payment per started month', () => {
    expect(sumBmcMemberships([monthly], new Date('2026-10-20T00:00:00Z'))).toEqual({ cents: 700, supporters: 1 });
    expect(sumBmcMemberships([monthly], new Date('2026-12-06T00:00:00Z')).cents).toBe(2100);
  });

  it('counts a yearly membership once per year', () => {
    const yearly = { ...monthly, subscription_coffee_price: 60, subscription_duration_type: 'year' };
    expect(sumBmcMemberships([yearly], new Date('2027-03-01T00:00:00Z')).cents).toBe(6000);
  });

  it('stops counting at the cancellation date', () => {
    const cancelled = { ...monthly, subscription_cancelled_on: '2026-11-10 00:00:00' };
    expect(sumBmcMemberships([cancelled], new Date('2027-02-01T00:00:00Z')).cents).toBe(1400);
  });

  it('rejects an unreadable cancellation date instead of counting as active', () => {
    const broken = { ...monthly, subscription_cancelled_on: 'not a date' };
    expect(() => sumBmcMemberships([broken], new Date('2026-12-01T00:00:00Z'))).toThrow(/cancellation date/);
  });

  it('only counts payments from the campaign start on', () => {
    const older = { ...monthly, subscription_created_on: '2026-08-20 10:00:00' };
    // Charged 20 August, 20 September, 20 October: only October is in the campaign.
    expect(sumBmcMemberships([older], new Date('2026-10-25T00:00:00Z')).cents).toBe(700);
    const goneBefore = { ...older, subscription_cancelled_on: '2026-09-25 00:00:00' };
    expect(sumBmcMemberships([goneBefore], new Date('2026-10-25T00:00:00Z'))).toEqual({ cents: 0, supporters: 0 });
  });
});

describe('buildState', () => {
  it('has no amount when neither platform is connected', () => {
    const state = buildState({ github: notConfigured, bmc: notConfigured, now: during });
    expect(state.collectedCents).toBeNull();
    expect(state.phase).toBe('collecting');
  });

  it('adds both platforms', () => {
    const state = buildState({ github: ok(3200, 2), bmc: ok(1500, 1), now: during });
    expect(state).toMatchObject({ collectedCents: 4700, supporters: 3, goalCents: 67500, phase: 'collecting' });
  });

  it('uses the connected platform alone when the other has no token', () => {
    const state = buildState({ github: ok(3200, 2), bmc: notConfigured, now: during });
    expect(state.collectedCents).toBe(3200);
    expect(state.sources).toEqual({ githubSponsors: 'ok', buyMeACoffee: 'not-configured' });
  });

  it('subtracts the GitHub baseline from GitHub only and never goes below zero', () => {
    const config = { ...CONFIG, githubBaselineCents: 67500 };
    expect(buildState({ github: ok(70000, 9), bmc: ok(0, 0), now: during, config }).collectedCents).toBe(2500);
    expect(buildState({ github: ok(100, 1), bmc: ok(0, 0), now: during, config }).collectedCents).toBe(0);
    expect(buildState({ github: ok(70000, 9), bmc: ok(1500, 1), now: during, config }).collectedCents).toBe(4000);
    expect(buildState({ github: ok(100, 1), bmc: ok(1500, 1), now: during, config }).collectedCents).toBe(1500);
    expect(buildState({ github: notConfigured, bmc: ok(1500, 1), now: during, config }).collectedCents).toBe(1500);
  });
});

describe('phaseFor', () => {
  it('collects until the day the assessment has to start', () => {
    expect(phaseFor(1000, new Date('2026-11-01T23:00:00Z'))).toBe('collecting');
    expect(phaseFor(1000, new Date('2026-11-02T00:00:00Z'))).toBe('backstopped');
    expect(phaseFor(null, after)).toBe('backstopped');
  });

  it('is reached at the goal, before or after that day', () => {
    expect(phaseFor(67500, during)).toBe('reached');
    expect(phaseFor(90000, after)).toBe('reached');
  });
});

describe('renderBlock', () => {
  it('shows the goal and says the amount is not connected when there is no amount', () => {
    const html = renderBlock(buildState({ github: notConfigured, bmc: notConfigured, now: during }));
    expect(html).toContain('Goal: 675 US dollars');
    expect(html).toContain('not connected to this page yet');
    expect(html).not.toContain('<progress');
    expect(html).toContain('https://github.com/sponsors/marlinjai');
    expect(html).toContain('https://buymeacoffee.com/marlinjai');
  });

  it('shows a real zero as zero', () => {
    const html = renderBlock(buildState({ github: ok(0, 0), bmc: ok(0, 0), now: during }));
    expect(html).toContain('0 of 675 US dollars');
    expect(html).toContain('value="0"');
    expect(html).toContain('0 supporters, 0 percent');
  });

  it('shows amount, percent, supporters and the collecting note', () => {
    const html = renderBlock(buildState({ github: ok(13500, 1), bmc: ok(0, 0), now: during }));
    expect(html).toContain('135 of 675 US dollars');
    expect(html).toContain('max="67500" value="13500"');
    expect(html).toContain('1 supporter, 20 percent');
    expect(html).toContain('Collecting until 2 November 2026');
    expect(html).toContain('Updated 15 October 2026');
  });

  it('keeps cents when the amount is not a whole dollar', () => {
    expect(renderBlock(buildState({ github: ok(1130, 1), bmc: ok(0, 0), now: during }))).toContain('11.30 of 675');
  });

  it('caps the bar at the goal and thanks when it is reached', () => {
    const html = renderBlock(buildState({ github: ok(80000, 12), bmc: ok(0, 0), now: during }));
    expect(html).toContain('800 of 675 US dollars');
    expect(html).toContain('value="67500"');
    expect(html).toContain('100 percent');
    expect(html).toContain('Goal reached');
  });

  it('says who covers the rest after the start day', () => {
    const html = renderBlock(buildState({ github: ok(20000, 4), bmc: ok(0, 0), now: after }));
    expect(html).toContain('the maintainer covers what is missing');
    expect(html).not.toContain('Collecting until');
  });

  it('says so when one platform is missing or the amount is the last known one', () => {
    const partial = renderBlock(buildState({ github: ok(700, 1), bmc: notConfigured, now: during }));
    expect(partial).toContain('not connected yet, so the real amount may be higher');
    const stale = renderBlock({ ...buildState({ github: ok(700, 1), bmc: ok(0, 0), now: during }), stale: true });
    expect(stale).toContain('last known amount');
  });

  it('contains no long dashes', () => {
    for (const now of [during, after]) {
      for (const github of [notConfigured, ok(0, 0), ok(70000, 3)]) {
        expect(renderBlock(buildState({ github, bmc: notConfigured, now }))).not.toMatch(/[–—]/);
      }
    }
  });
});

describe('inject', () => {
  const page = `<section>\n    ${MARK_START}\n    old\n    ${MARK_END}\n  </section>`;

  it('replaces what is between the markers and keeps the rest', () => {
    const out = inject(page, '<div>new</div>');
    expect(out).toContain('<div>new</div>');
    expect(out).not.toContain('old');
    expect(out.startsWith('<section>')).toBe(true);
    expect(out.endsWith('</section>')).toBe(true);
  });

  it('gives the same page when run twice', () => {
    const once = inject(page, '<div>new</div>');
    expect(inject(once, '<div>new</div>')).toBe(once);
  });

  it('fails when the markers are missing', () => {
    expect(() => inject('<section></section>', 'x')).toThrow(/markers not found/);
  });

  it('the committed homepage carries the bar in its not-connected state', () => {
    const html = readFileSync(path.resolve(__dirname, '../../site/index.html'), 'utf8');
    const expected = renderBlock(buildState({ github: notConfigured, bmc: notConfigured, now: new Date('2026-10-02T00:00:00Z') }));
    expect(inject(html, expected)).toBe(html);
  });
});

describe('formatDate', () => {
  it('writes dates out', () => {
    expect(formatDate('2026-11-02')).toBe('2 November 2026');
    expect(formatDate('2026-10-15T12:00:00.000Z')).toBe('15 October 2026');
  });
});
