/** Operator-only compiled tool. Index creation is explicit: apply --create-index, never server/schema boot. */
import { runBondMaintenance, reportMaintenanceFailure } from './bondMaintenanceBootstrap';

if (require.main === module) runBondMaintenance('identity').catch(reportMaintenanceFailure);
