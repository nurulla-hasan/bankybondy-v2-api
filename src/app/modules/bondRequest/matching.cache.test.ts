import assert from 'node:assert/strict';
import { selectMatchingCache } from './matching.cache';

export function runMatchingCacheTests() {
    const now = 10_000_000;
    const settings = { computeRevision: 2, cacheTtlMinutes: 60, serveTtlMinutes: 120 };
    const row = (revision: number, score = 0.8, age = 1000, ids = ['a', 'b']) => ({
        bonds: ids, score, computeRevision: revision, computedAt: new Date(now - age),
    });
    const cases: [string, () => void][] = [
        ['new lower scores replace legacy high scores', () => {
            const result = selectMatchingCache([row(0, 0.9), row(2, 0.5)], settings, {}, now);
            assert.equal(result.records.length, 1);
            assert.equal(result.records[0].score, 0.5);
            assert.equal(result.shouldRefresh, false);
        }],
        ['same revision retains highest scoring discovery', () => {
            const result = selectMatchingCache([row(2, 0.5), row(2, 0.8, 1000, ['b', 'a'])], settings, {}, now);
            assert.equal(result.records[0].score, 0.8);
        }],
        ['old revision is served while queuing a refresh', () => {
            const result = selectMatchingCache([row(1)], settings, {}, now);
            assert.equal(result.records.length, 1);
            assert.equal(result.shouldRefresh, true);
        }],
        ['every row observes serving TTL, not only first', () => {
            const result = selectMatchingCache([row(2), row(2, 0.9, 121 * 60000, ['a', 'c'])], settings, {}, now);
            assert.equal(result.records.length, 1);
        }],
        ['expired refresh TTL queues recomputation with servable data', () => {
            const result = selectMatchingCache([row(2, 0.8, 61 * 60000)], settings, {}, now);
            assert.equal(result.records.length, 1);
            assert.equal(result.shouldRefresh, true);
        }],
        ['current zero-result seal suppresses old discoveries', () => {
            const result = selectMatchingCache([row(1)], settings, {
                matchesComputeRevision: 2, matchesComputedAt: new Date(now - 1000),
            }, now);
            assert.equal(result.records.length, 0);
            assert.equal(result.shouldRefresh, false);
        }],
        ['old zero-result seal cannot block recomputation', () => {
            assert.equal(selectMatchingCache([], settings, {
                matchesComputeRevision: 1, matchesComputedAt: new Date(now - 1000),
            }, now).shouldRefresh, true);
        }],
        ['missing revision metadata is legacy zero', () => {
            const { computeRevision: _revision, ...legacy } = row(0);
            assert.equal(selectMatchingCache([legacy], settings, {}, now).shouldRefresh, true);
        }],
        ['invalidated seal does not hide old servable records', () => {
            const result = selectMatchingCache([row(1)], settings, { matchesComputeRevision: 2 }, now);
            assert.equal(result.records.length, 1);
            assert.equal(result.shouldRefresh, true);
        }],
        ['newer worker results are not downgraded by cached API settings', () => {
            assert.equal(selectMatchingCache([row(3)], settings, {}, now).shouldRefresh, false);
        }],
        ['zero refresh TTL always schedules refresh', () => {
            assert.equal(selectMatchingCache([row(2)], { ...settings, cacheTtlMinutes: 0 }, {}, now).shouldRefresh, true);
        }],
    ];
    let pass = 0, fail = 0;
    for (const [name, test] of cases) {
        try { test(); pass++; } catch (error) { console.error('FAIL:', name, error); fail++; }
    }
    return { pass, fail };
}
