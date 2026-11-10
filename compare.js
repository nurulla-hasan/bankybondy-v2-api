#!/usr/bin/env node
/* Compara dos salidas de src/scripts/benchMatchCompute.ts.
 *
 * Uso: node compare.js bench-vector.json bench-knn.json
 *
 * Imprime las dos líneas de stats, y por cada vínculo común calcula el Jaccard
 * sobre el conjunto de matchKeys (calidad de resultado: 1 = mismos tratos).
 * Reporta los vínculos con Jaccard < 1, y al final promedio y peor caso.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) =>
    JSON.parse(fs.readFileSync(path.resolve(process.cwd(), p), 'utf8'));

const fmt = (s) => `${s.p50}/${s.p95}/${s.max}`;

const statsLine = (s) =>
    `${s.label} [${s.mode}] bonds=${s.bonds} runs=${s.runsPerBond} ` +
    `total p50/p95/max=${fmt(s.total_ms)}ms ` +
    `candidates p50/p95/max=${fmt(s.candidates_ms)}ms ` +
    `avgMatches=${s.avgMatches}`;

const keysOf = (rows) => new Set((rows || []).map((r) => r.key));

const jaccard = (a, b) => {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const k of a) if (b.has(k)) inter++;
    return inter / (a.size + b.size - inter);
};

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
    console.error('Uso: node compare.js <bench-a.json> <bench-b.json>');
    process.exit(2);
}

let a;
let b;
try {
    a = read(fileA);
    b = read(fileB);
} catch (e) {
    console.error(`[compare] no pude leer los JSON: ${e.message}`);
    process.exit(1);
}

console.log(statsLine(a.stats));
console.log(statsLine(b.stats));

const outA = a.out || {};
const outB = b.out || {};
const common = Object.keys(outA).filter((id) => Object.prototype.hasOwnProperty.call(outB, id));

if (!common.length) {
    console.error('[compare] no hay vínculos en común entre los dos archivos.');
    process.exit(1);
}

let sum = 0;
let worst = 1;
let worstId = null;
let differing = 0;

for (const id of common) {
    const j = jaccard(keysOf(outA[id]), keysOf(outB[id]));
    sum += j;
    if (j < worst) {
        worst = j;
        worstId = id;
    }
    if (j < 1) {
        differing++;
        const onlyA = [...keysOf(outA[id])].filter((k) => !keysOf(outB[id]).has(k));
        const onlyB = [...keysOf(outB[id])].filter((k) => !keysOf(outA[id]).has(k));
        console.log(
            `[compare] ${id} jaccard=${j.toFixed(4)} ` +
                `onlyA=${onlyA.length} onlyB=${onlyB.length}`
        );
    }
}

const avg = sum / common.length;
console.log(
    `[compare] comunes=${common.length} distintos=${differing} ` +
        `jaccard medio=${avg.toFixed(4)} peor=${worst.toFixed(4)}` +
        (worstId ? ` (${worstId})` : '')
);
