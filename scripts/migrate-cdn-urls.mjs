#!/usr/bin/env node
/**
 * Standalone MongoDB CDN URL Migration Script.
 * 
 * Replaces occurrences of the old CloudFront CDN URL with the new CLOUDFRONT_URL
 * across all collections, documents, nested objects, and arrays.
 * 
 * Usage:
 *   node scripts/migrate-cdn-urls.mjs
 *   node scripts/migrate-cdn-urls.mjs --dry-run
 */

import mongoose from 'mongoose';
const { MongoClient } = mongoose.mongo;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root if available
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const OLD_CDN = (process.env.OLD_CDN_URL || 'https://d19ily4n4ue4ad.cloudfront.net').replace(/\/+$/, '');
const NEW_CDN = (process.env.NEW_CDN_URL || process.env.CLOUDFRONT_URL || '').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL;
const isDryRun = process.argv.includes('--dry-run');

if (!DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL environment variable is required.');
    process.exit(1);
}

if (!NEW_CDN) {
    console.error('❌ Error: CLOUDFRONT_URL environment variable is required.');
    process.exit(1);
}

if (OLD_CDN === NEW_CDN) {
    console.log(`ℹ️  OLD_CDN (${OLD_CDN}) and NEW_CDN (${NEW_CDN}) are identical. Nothing to migrate.`);
    process.exit(0);
}

console.log('====================================================');
console.log('🔄 MongoDB CDN URL Migration');
console.log('====================================================');
console.log(`Target DB URL : ${DATABASE_URL.replace(/(:\/\/)([^@]+)@/, '$1***:***@')}`);
console.log(`Replacing     : ${OLD_CDN}`);
console.log(`With          : ${NEW_CDN}`);
console.log(`Dry Run Mode  : ${isDryRun ? 'YES (No writes will be performed)' : 'NO (Live update)'}`);
console.log('====================================================\n');

function replaceUrlsInObject(obj) {
    if (!obj || typeof obj !== 'object') return false;
    let changed = false;

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            if (typeof obj[i] === 'string' && obj[i].includes(OLD_CDN)) {
                obj[i] = obj[i].replaceAll(OLD_CDN, NEW_CDN);
                changed = true;
            } else if (typeof obj[i] === 'object' && obj[i] !== null) {
                if (replaceUrlsInObject(obj[i])) changed = true;
            }
        }
    } else {
        for (const key of Object.keys(obj)) {
            if (typeof obj[key] === 'string' && obj[key].includes(OLD_CDN)) {
                obj[key] = obj[key].replaceAll(OLD_CDN, NEW_CDN);
                changed = true;
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                if (replaceUrlsInObject(obj[key])) changed = true;
            }
        }
    }

    return changed;
}

async function run() {
    const client = new MongoClient(DATABASE_URL);
    await client.connect();
    console.log('✅ Connected to MongoDB successfully.\n');

    const db = client.db();
    const collections = await db.listCollections().toArray();

    let totalUpdatedDocs = 0;
    const stats = {};

    for (const colInfo of collections) {
        const colName = colInfo.name;
        if (colName.startsWith('system.') || colName.startsWith('fs.')) continue;

        const collection = db.collection(colName);
        let updatedInCol = 0;

        const cursor = collection.find({});
        while (await cursor.hasNext()) {
            const doc = await cursor.next();
            if (!doc) break;

            const docCopy = JSON.parse(JSON.stringify(doc));
            const hasChanges = replaceUrlsInObject(docCopy);

            if (hasChanges) {
                updatedInCol++;
                totalUpdatedDocs++;
                if (!isDryRun) {
                    const { _id, ...updatePayload } = docCopy;
                    await collection.replaceOne({ _id }, docCopy);
                }
            }
        }

        if (updatedInCol > 0) {
            stats[colName] = updatedInCol;
            console.log(`📦 [${colName}]: ${updatedInCol} document(s) ${isDryRun ? 'contain matching URLs' : 'migrated'}`);
        }
    }

    console.log('\n====================================================');
    console.log(`🏁 Migration Completed! Total documents affected: ${totalUpdatedDocs}`);
    if (isDryRun) {
        console.log('⚠️  Dry run mode was active. Run without --dry-run to commit changes to MongoDB.');
    }
    console.log('====================================================');

    await client.close();
}

run().catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
});
