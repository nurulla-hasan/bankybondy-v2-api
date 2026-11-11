import assert from 'node:assert/strict';
import { feedUpsertUpdate, recordToFeedDocs } from './matching.feed';

function evaluate(expression: any, row: Record<string, any>): any {
    if (typeof expression === 'string' && expression.startsWith('$')) return row[expression.slice(1)];
    if (!expression || typeof expression !== 'object' || expression instanceof Date) return expression;
    if (Array.isArray(expression)) return expression.map((value) => evaluate(value, row));
    if ('$ifNull' in expression) {
        const [value, fallback] = evaluate(expression.$ifNull, row);
        return value ?? fallback;
    }
    if ('$cond' in expression) {
        const [condition, yes, no] = expression.$cond;
        return evaluate(evaluate(condition, row) ? yes : no, row);
    }
    if ('$or' in expression) return expression.$or.some((value: any) => evaluate(value, row));
    if ('$and' in expression) return expression.$and.every((value: any) => evaluate(value, row));
    for (const operator of ['$gt', '$gte', '$eq']) {
        if (operator in expression) {
            const [a, b] = evaluate(expression[operator], row);
            return operator === '$gt' ? a > b : operator === '$gte' ? a >= b : a === b;
        }
    }
    return expression;
}

export function runMatchingRevisionTests() {
    const record = { ids: ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'],
        users: ['111111111111111111111111', '222222222222222222222222'],
        score: 0.4, parts: { sem: 0.4, rep: 1, prox: 1, fresh: 1 }, type: 'surprise' as const, size: 2 };
    const incoming = recordToFeedDocs(record, record.ids[0], new Date(2000), 2)[0];
    const apply = (row: Record<string, any>) => {
        const fields = feedUpsertUpdate(incoming)[0].$set;
        return { ...row, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, evaluate(value, row)])) };
    };
    const cases: [string, () => void][] = [
        ['fanout pins revision', () => assert.equal(incoming.computeRevision, 2)],
        ['new revision can lower historical score', () => {
            const result = apply({ computeRevision: 1, score: 0.95, parts: { sem: 0.95 } });
            assert.equal(result.score, 0.4);
            assert.deepEqual(result.parts, incoming.parts);
            assert.equal(result.computeRevision, 2);
        }],
        ['same revision keeps highest score', () => {
            const result = apply({ computeRevision: 2, score: 0.95, parts: { sem: 0.95 } });
            assert.equal(result.score, 0.95);
            assert.equal(result.parts.sem, 0.95);
            assert.equal(result.computedAt, incoming.computedAt);
        }],
        ['old computation cannot overwrite newer metadata', () => {
            const newer = { computeRevision: 3, score: 0.2, parts: { sem: 0.2 },
                bonds: ['new'], users: ['new-owner'], sourceBond: 'new-source',
                type: 'empty', size: 3, computedAt: new Date(3000) };
            assert.deepEqual(apply(newer), newer);
        }],
        ['missing revision is legacy zero', () => assert.equal(apply({ score: 0.99 }).score, 0.4)],
        ['new row initializes all score metadata', () => {
            const result = apply({});
            assert.equal(result.computeRevision, 2);
            assert.equal(result.score, 0.4);
            assert.deepEqual(result.parts, incoming.parts);
        }],
    ];
    let pass = 0, fail = 0;
    for (const [name, test] of cases) {
        try { test(); pass++; } catch (error) { fail++; console.error('FAIL:', name, error); }
    }
    return { pass, fail };
}
