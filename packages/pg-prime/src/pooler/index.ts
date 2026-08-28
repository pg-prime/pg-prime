/** The pooler layer's internal barrel (design/07 §5). */

export {
  POOLER_MODES,
  POOLER_PROFILES,
  alterRoleHint,
  isTransactionPooled,
  profileOf,
} from './profiles.js'
export type { PoolerMode, PoolerProfile } from './profiles.js'

export { diagnose, diagnosePooler } from './diagnose.js'
export type {
  DbDiagnosis,
  DiagnoseInputs,
  DiagnosePoolerOptions,
  DiagnosticSignal,
  PoolerDiagnosis,
} from './diagnose.js'
