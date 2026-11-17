/** 字段映射执行的领域类型：与提取规则、源记录、结果明细和数据落盘清单共用。 */

export type MappingRuleDef = {
  ruleNo: string
  sourceField: string
  targetField: string
  transform: string
  defaultValue: string
  expression: string
  required: boolean
  unique: boolean
}

export type SourceRecord = {
  id: number
  recordNo: string
  /** 源记录自己的状态，映射执行和落盘都不会改写它。 */
  sourceStatus: string
  values: Record<string, string>
}

export type FieldErrorType = '' | 'required' | 'type' | 'unique' | 'rule'

export type FieldMappingResult = {
  ruleNo: string
  sourceField: string
  targetField: string
  transform: string
  rawValue: string
  /** 只有转换成功才有值；失败时一定为 null，避免留下目标字段半成品。 */
  value: string | null
  ok: boolean
  /** 源值为空且没有默认值、非必填时为 true：跳过而不写入目标字段。 */
  skipped: boolean
  errorType: FieldErrorType
  error: string
  /** 字段级处置说明：转换成功、默认值回填、源值为空跳过或失败原因。 */
  note: string
}

export type RecordMappingStatus = '通过' | '冲突'

export type RecordMappingResult = {
  sourceId: number
  recordNo: string
  sourceStatus: string
  status: RecordMappingStatus
  /** 仅包含转换成功的字段，冲突字段不会以任何形式写入目标数据。 */
  target: Record<string, string>
  fields: FieldMappingResult[]
  reasons: string[]
}

export type ConflictStrategy = 'pause' | 'isolate'

export type MappingBatchStatus = '处理中' | '已中断' | '已暂停' | '待落盘' | '已完成'

export type MappingBatch = {
  id: string
  createdAt: string
  finishedAt: string
  /** 批次固定执行时的规则快照，规则编号可追溯到当时版本。 */
  rules: MappingRuleDef[]
  /** 源记录快照：批次内的转换与恢复都以这份数据为准，源记录状态原样保留。 */
  sources: SourceRecord[]
  strategy: ConflictStrategy
  status: MappingBatchStatus
  sourceTotal: number
  processedCount: number
  /** 最后一次成功的源记录编号，中断后从这里之后继续。 */
  lastSuccessRecordNo: string
  results: RecordMappingResult[]
}

export type LandedRecord = {
  recordNo: string
  sourceStatus: string
  target: Record<string, string>
}

export type StorageRun = {
  id: string
  batchId: string
  configNo: string
  writtenAt: string
  strategy: ConflictStrategy
  recordNos: string[]
  records: LandedRecord[]
}

export type MappingState = {
  sourceRecords: SourceRecord[]
  batches: MappingBatch[]
  activeBatchId: string | null
  storageRuns: StorageRun[]
}

export type MappingExecutionResult = {
  ok: boolean
  message: string
  interrupted: boolean
  batch: MappingBatch | null
}

export type StrategyScope = {
  strategy: ConflictStrategy
  label: string
  accepted: number
  blocked: number
  writable: boolean
  description: string
}

export type StorageManifest = {
  batch: MappingBatch | null
  accepted: RecordMappingResult[]
  blocked: RecordMappingResult[]
  targetFields: string[]
  storageRun: StorageRun | null
  paused: boolean
  ready: boolean
  /** 冲突修复后重新复核得到的最终形态，供字段映射用户核对。 */
  comparison: StrategyScope[]
  message: string
  /** 映射执行中断或结果明细复核未通过时的页面级错误。 */
  error: string
}
