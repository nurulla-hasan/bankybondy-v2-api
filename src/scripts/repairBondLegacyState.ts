/** Operator-only compiled tool. See --help; importing this file never connects or loads application config. */
import { runBondMaintenance, reportMaintenanceFailure } from './bondMaintenanceBootstrap';

if (require.main === module) runBondMaintenance('repair').catch(reportMaintenanceFailure);
