#!/usr/bin/env node
/**
 * BankyBondy Matching Test & Verification Script
 * Runs inside the backend container to benchmark and inspect live matching
 * across the 5,000 newly seeded bonds.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL;

async function run() {
  console.log('====================================================');
  console.log('🔍 Testing Matching Engine with 5,000 Seeded Bonds');
  console.log('====================================================\n');

  await mongoose.connect(DATABASE_URL);
  console.log('✅ Connected to MongoDB successfully.');

  const db = mongoose.connection.db;
  const BondRequest = mongoose.model(
    'BondRequest',
    new mongoose.Schema({}, { strict: false }),
    'bondrequests'
  );

  // Import compiled backend matching compute
  const { computeMatchesForBond } = await import('../dist/app/modules/bondRequest/matching.compute.js');
  const { getMatchingSettings } = await import('../dist/app/modules/settings/matchingSettings.service.js');

  const settings = await getMatchingSettings(true);
  console.log(`\n⚙️ Current Settings:`);
  console.log(`   Candidate Mode : ${settings.candidateMode}`);
  console.log(`   Pair Gate      : ${settings.minScore}`);
  console.log(`   Serving Floor  : ${settings.minServeScore}`);
  console.log(`   Weights        : Sem=${settings.weightSem}, Rep=${settings.weightRep}, Prox=${settings.weightProx}, Fresh=${settings.weightFresh}`);

  // Fetch 10 sample bonds across various categories
  const sampleBonds = await BondRequest.find({
    status: 'WAITING_FOR_LINK',
    isPause: false,
    isLinked: false,
  })
    .limit(10)
    .populate('user')
    .lean();

  console.log(`\n🧪 Testing 10 distinct bonds for match quality & speed:\n`);

  const latencies = [];

  for (let i = 0; i < sampleBonds.length; i++) {
    const bond = sampleBonds[i];
    const userId = (bond.user?._id || bond.user)?.toString();

    const t0 = performance.now();
    const records = await computeMatchesForBond(bond, userId, settings);
    const duration = performance.now() - t0;
    latencies.push(duration);

    console.log(`────────────────────────────────────────────────────`);
    console.log(`📌 Bond #${i + 1}:`);
    console.log(`   Offer : "${bond.offer}" [${bond.modality}]`);
    console.log(`   Want  : "${bond.want}"`);
    console.log(`   Speed : ${duration.toFixed(2)} ms`);
    console.log(`   Matches Found: ${records.length}`);

    if (records.length > 0) {
      console.log(`   Top Matches:`);
      // Display top 3 matches
      for (let j = 0; j < Math.min(3, records.length); j++) {
        const match = records[j];
        const counterpartId = match.ids.find((id) => id !== bond._id.toString());
        const counterpart = await BondRequest.findById(counterpartId).lean();

        console.log(`     [${j + 1}] Score: ${match.score.toFixed(3)} | Type: ${match.type || 'pair'}`);
        if (counterpart) {
          console.log(`         Counterpart Offers: "${counterpart.offer}"`);
          console.log(`         Counterpart Wants : "${counterpart.want}"`);
        }
      }
    } else {
      console.log(`   (No matches above the current gate/floor)`);
    }
  }

  // Summary stats
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];

  console.log('\n====================================================');
  console.log('📊 PERFORMANCE SUMMARY (kNN Exact In-Memory):');
  console.log('====================================================');
  console.log(`   Average Compute Time : ${avg.toFixed(2)} ms`);
  console.log(`   Median (p50)         : ${p50.toFixed(2)} ms`);
  console.log(`   95th Percentile (p95): ${p95.toFixed(2)} ms`);
  console.log('====================================================\n');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
