import mongoose from 'mongoose';
import { ensureBondReferenceIndex } from '../app/modules/bondLink/bondLink.indexes';
import { maintenanceDatabaseName, reportMaintenanceFailure } from './bondMaintenanceBootstrap';

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        console.log('dry-run|apply|verify --collection NAME [--confirm-database NAME]\nRequires explicit BONDS_MAINTENANCE_DATABASE_URL; never drops/replaces indexes.');
        return;
    }
    const mode = args[0] || 'dry-run';
    if (!['dry-run', 'apply', 'verify'].includes(mode)) throw new Error('Unknown index operation');
    const option = (key: string) => { const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1]; };
    const collection = option('--collection');
    if (!collection || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(collection)) throw new Error('Explicit collection name required');
    const uri = process.env.BONDS_MAINTENANCE_DATABASE_URL;
    const name = maintenanceDatabaseName(uri);
    if (mode === 'apply' && option('--confirm-database') !== name) throw new Error('Confirm exact target database before creating index');
    const connection = await mongoose.createConnection(uri!, { autoCreate: false, autoIndex: false, maxPoolSize: 2, serverSelectionTimeoutMS: 10000 }).asPromise();
    try {
        if (connection.db!.databaseName !== name) throw new Error('Connected database does not match confirmed target');
        if (!(await connection.db!.listCollections({ name: collection }).hasNext())) throw new Error('Target collection does not exist');
        const result = await ensureBondReferenceIndex(connection.db!.collection(collection), mode === 'apply');
        console.log(JSON.stringify(result));
        if (mode === 'verify' && !result.present) process.exitCode = 2;
    } finally { await connection.close(); }
}

if (require.main === module) void main().catch(reportMaintenanceFailure);
