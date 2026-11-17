import { listRows } from './local-store'
import { MAPPING_SOURCES } from './mapping-seed'
import type { EntryRow } from './types'
import type {
  ConflictStrategy,
  FieldErrorType,
  FieldMappingResult,
  LandedRecord,
  MappingBatch,
  MappingExecutionResult,
  MappingRuleDef,
  MappingState,
  RecordMappingResult,
  SourceRecord,
  StorageManifest,
  StorageRun,
  StrategyScope,
} from './mapping-types'

// 字段映射执行的数据层：规则快照 -> 逐条转换 -> 唯一性归并 -> 结果明细 -> 数据落盘。
// 所有状态都持久化在 localStorage，刷新后仍能按最后一次成功位置继续。
const MAPPING_KEY = 'scraper-strategy-studio:mapping'

const STRATEGY_LABEL: Record<ConflictStrategy, string> = {
  pause: '暂停整批映射直到冲突修复',
  isolate: '隔离冲突记录并继续处理有效记录',
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowIso(): string {
  return new Date().toISOString()
}

function today(): string {
  return nowIso().slice(0, 10)
}

function seedState(): MappingState {
  return {
    sourceRecords: clone(MAPPING_SOURCES),
    batches: [],
    activeBatchId: null,
    storageRuns: [],
  }
}

function readStorage(): MappingState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(MAPPING_KEY)
  if (!raw) {
    window.localStorage.setItem(MAPPING_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as MappingState
    return {
      sourceRecords: Array.isArray(parsed.sourceRecords) && parsed.sourceRecords.length > 0
        ? parsed.sourceRecords
        : fallback.sourceRecords,
      batches: Array.isArray(parsed.batches) ? parsed.batches : [],
      activeBatchId: parsed.activeBatchId ?? null,
      storageRuns: Array.isArray(parsed.storageRuns) ? parsed.storageRuns : [],
    }
  } catch {
    window.localStorage.setItem(MAPPING_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: MappingState | null = null

export function loadMappingState(): MappingState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function saveMappingState(state: MappingState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(MAPPING_KEY, JSON.stringify(state))
  }
}

export function getMappingSnapshot(): MappingState {
  return clone(loadMappingState())
}

export function resetMappingState(): MappingState {
  const state = seedState()
  saveMappingState(state)
  return clone(state)
}

function isAffirmative(value: string): boolean {
  return ['是', '必填', '唯一', 'true', 'y', 'yes', '1'].includes(value.trim().toLowerCase())
}

/** 映射规则的主数据来自字段映射模块：规则编号、字段映射与映射规则都从登记行读取。 */
export function rulesFromEntries(rows: EntryRow[]): MappingRuleDef[] {
  const rules: MappingRuleDef[] = []
  for (const row of rows) {
    const ruleNo = String(row['规则编号'] ?? '').trim()
    const sourceField = String(row['源字段名称'] ?? '').trim()
    const targetField = String(row['目标字段名称'] ?? '').trim()
    if (!ruleNo || !sourceField || !targetField) continue
    rules.push({
      ruleNo,
      sourceField,
      targetField,
      transform: String(row['数据类型转换'] ?? 'string').trim(),
      defaultValue: String(row['默认填充值'] ?? '').trim(),
      expression: String(row['清洗表达式'] ?? '').trim(),
      required: isAffirmative(String(row['必填标识'] ?? '')),
      unique: isAffirmative(String(row['唯一性校验'] ?? '')),
    })
  }
  return rules
}

export function enabledMappingRules(): MappingRuleDef[] {
  return rulesFromEntries(listRows('extractor').filter((row) => String(row.status) === '已启用'))
}

/** 页面展示的映射规则主数据：当前已启用的规则。 */
export function listMappingRules(): MappingRuleDef[] {
  return enabledMappingRules()
}

/** 批次执行时冻结的规则快照，结果明细与规则编号都按这份数据追溯。 */
export function batchRuleSnapshot(batchId?: string): MappingRuleDef[] {
  const batch = batchId ? loadMappingState().batches.find((item) => item.id === batchId) : latestMappingBatch()
  return clone(batch ? batch.rules : [])
}

export function listSourceRecords(): SourceRecord[] {
  return clone(loadMappingState().sourceRecords)
}

export function listMappingBatches(): MappingBatch[] {
  return clone(loadMappingState().batches)
}

export function latestMappingBatch(): MappingBatch | null {
  const state = loadMappingState()
  if (state.activeBatchId) {
    const batch = state.batches.find((item) => item.id === state.activeBatchId)
    if (batch) {
      return clone(batch)
    }
  }
  const latest = state.batches[state.batches.length - 1]
  return latest ? clone(latest) : null
}

export function strategyLabel(strategy: ConflictStrategy): string {
  return STRATEGY_LABEL[strategy]
}

/* ------------------------------ 字段转换 ------------------------------ */

type Converted = { ok: true; value: string } | { ok: false; error: string }

function applyExpression(value: string, expression: string): string {
  let next = value
  const parts = expression
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  for (const part of parts) {
    if (part === 'trim') next = next.trim()
    if (part === 'upper') next = next.toUpperCase()
    if (part === 'lower') next = next.toLowerCase()
    if (part === 'compact') next = next.replace(/\s+/g, ' ')
  }
  return next
}

function convertValue(raw: string, transform: string): Converted {
  const kind = transform.trim().toLowerCase()
  if (kind === '' || kind === 'string' || kind === 'text') {
    return { ok: true, value: raw }
  }
  if (kind === 'integer' || kind === 'int') {
    if (!/^[+-]?\d+$/.test(raw)) {
      return { ok: false, error: `值「${raw}」不是合法整数` }
    }
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: `整数「${raw}」超出安全范围` }
    }
    return { ok: true, value: String(parsed) }
  }
  if (kind === 'decimal' || kind === 'number' || kind === 'float') {
    if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) {
      return { ok: false, error: `值「${raw}」不是合法数值` }
    }
    return { ok: true, value: Number(raw).toFixed(2) }
  }
  if (kind === 'date') {
    const matched = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(raw)
    if (!matched) {
      return { ok: false, error: `值「${raw}」不是 YYYY-MM-DD 或 YYYY/MM/DD 格式` }
    }
    const year = Number(matched[1])
    const month = Number(matched[2])
    const day = Number(matched[3])
    const date = new Date(Date.UTC(year, month - 1, day))
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
    ) {
      return { ok: false, error: `值「${raw}」不是真实存在的日期` }
    }
    return { ok: true, value: `${matched[1]}-${matched[2]}-${matched[3]}` }
  }
  if (kind === 'boolean' || kind === 'bool') {
    const lowered = raw.toLowerCase()
    if (['true', '1', '是', 'y', 'yes'].includes(lowered)) return { ok: true, value: 'true' }
    if (['false', '0', '否', 'n', 'no'].includes(lowered)) return { ok: true, value: 'false' }
    return { ok: false, error: `值「${raw}」不是合法布尔值` }
  }
  return { ok: false, error: `数据类型转换「${transform}」未登记，无法执行` }
}

function emptyField(rule: MappingRuleDef, raw: string, type: FieldErrorType, error: string): FieldMappingResult {
  return {
    ruleNo: rule.ruleNo,
    sourceField: rule.sourceField,
    targetField: rule.targetField,
    transform: rule.transform,
    rawValue: raw,
    value: null,
    ok: false,
    skipped: false,
    errorType: type,
    error,
    note: '目标字段未写入，避免留下半成品',
  }
}

export function mapField(rule: MappingRuleDef, rawInput: string): FieldMappingResult {
  const raw = rawInput ?? ''
  const working = applyExpression(raw, rule.expression)
  if (working === '') {
    if (rule.defaultValue !== '') {
      const converted = convertValue(rule.defaultValue, rule.transform)
      if (!converted.ok) {
        return emptyField(rule, raw, 'type', `默认填充值无法转换：${converted.error}`)
      }
      return {
        ruleNo: rule.ruleNo,
        sourceField: rule.sourceField,
        targetField: rule.targetField,
        transform: rule.transform,
        rawValue: raw,
        value: converted.value,
        ok: true,
        skipped: false,
        errorType: '',
        error: '',
        note: `源值为空，按默认填充值「${rule.defaultValue}」写入`,
      }
    }
    if (rule.required) {
      return emptyField(rule, raw, 'required', `必填字段缺失：${rule.sourceField} 没有值（规则 ${rule.ruleNo}）`)
    }
    return {
      ruleNo: rule.ruleNo,
      sourceField: rule.sourceField,
      targetField: rule.targetField,
      transform: rule.transform,
      rawValue: raw,
      value: null,
      ok: true,
      skipped: true,
      errorType: '',
      error: '',
      note: '源值为空且没有默认填充值，跳过该目标字段',
    }
  }
  const converted = convertValue(working, rule.transform)
  if (!converted.ok) {
    return emptyField(rule, raw, 'type', `类型转换失败：${converted.error}（规则 ${rule.ruleNo}）`)
  }
  return {
    ruleNo: rule.ruleNo,
    sourceField: rule.sourceField,
    targetField: rule.targetField,
    transform: rule.transform,
    rawValue: raw,
    value: converted.value,
    ok: true,
    skipped: false,
    errorType: '',
    error: '',
    note: converted.value === working ? '类型转换通过' : `类型转换通过，写入「${converted.value}」`,
  }
}

/* ------------------------------ 记录归并 ------------------------------ */

function buildRecordResult(source: SourceRecord, fields: FieldMappingResult[]): RecordMappingResult {
  const target: Record<string, string> = {}
  const reasons: string[] = []
  for (const field of fields) {
    if (field.ok && !field.skipped && field.value !== null) {
      target[field.targetField] = field.value
    }
    if (!field.ok) {
      reasons.push(field.error)
    }
  }
  return {
    sourceId: source.id,
    recordNo: source.recordNo,
    sourceStatus: source.sourceStatus,
    status: reasons.length > 0 ? '冲突' : '通过',
    target,
    fields: clone(fields),
    reasons,
  }
}

function evaluateRecord(source: SourceRecord, rules: MappingRuleDef[]): RecordMappingResult {
  const fields = rules.map((rule) => mapField(rule, source.values[rule.sourceField] ?? ''))
  return buildRecordResult(source, fields)
}

function rebuildFromFields(record: RecordMappingResult): RecordMappingResult {
  const source: SourceRecord = {
    id: record.sourceId,
    recordNo: record.recordNo,
    sourceStatus: record.sourceStatus,
    values: {},
  }
  return buildRecordResult(source, record.fields)
}

/** 唯一性冲突覆盖整批记录：先归并全部转换成功的值，再回写到每条记录。 */
function finalizeUniqueness(records: RecordMappingResult[], rules: MappingRuleDef[]): RecordMappingResult[] {
  const uniqueRules = rules.filter((rule) => rule.unique)
  for (const record of records) {
    record.fields = record.fields.map((field) => {
      if (field.errorType === 'unique') {
        return { ...field, ok: true, errorType: '' as FieldErrorType, error: '', note: '唯一性校验通过' }
      }
      return field
    })
  }
  for (const rule of uniqueRules) {
    const buckets = new Map<string, RecordMappingResult[]>()
    for (const record of records) {
      const field = record.fields.find((item) => item.ruleNo === rule.ruleNo)
      if (!field || !field.ok || field.skipped || field.value === null || field.value === '') continue
      const key = field.value
      const bucket = buckets.get(key) ?? []
      bucket.push(record)
      buckets.set(key, bucket)
    }
    for (const [value, bucket] of buckets) {
      if (bucket.length < 2) continue
      const recordNos = bucket.map((item) => item.recordNo).join('、')
      for (const record of bucket) {
        record.fields = record.fields.map((field) => {
          if (field.ruleNo !== rule.ruleNo) return field
          return {
            ...field,
            ok: false,
            errorType: 'unique' as FieldErrorType,
            error: `唯一性冲突：目标字段 ${rule.targetField}=「${value}」同时出现在 ${recordNos}（规则 ${rule.ruleNo}）`,
            note: '冲突记录不会写入目标数据，需修复源值后复核',
          }
        })
      }
    }
  }
  return records.map((record) => rebuildFromFields(record))
}

/* ------------------------------ 批次执行 ------------------------------ */

function nextBatchId(state: MappingState): string {
  const date = today().replace(/-/g, '')
  const prefix = `MAP-${date}-`
  const used = state.batches
    .filter((batch) => batch.id.startsWith(prefix))
    .map((batch) => Number(batch.id.slice(prefix.length)) || 0)
  const seq = String(Math.max(0, ...used) + 1).padStart(3, '0')
  return `${prefix}${seq}`
}

function findConflicts(batch: MappingBatch): RecordMappingResult[] {
  return batch.results.filter((record) => record.status === '冲突')
}

function settle(batch: MappingBatch, strategy: ConflictStrategy): string {
  batch.strategy = strategy
  const conflicts = findConflicts(batch)
  if (conflicts.length > 0 && strategy === 'pause') {
    batch.status = '已暂停'
    return `批次 ${batch.id} 已暂停整批映射，${conflicts.length} 条冲突记录停在映射阶段，数据落盘不接受本批任何记录`
  }
  batch.status = '待落盘'
  const accepted = batch.results.filter((record) => record.status === '通过')
  return conflicts.length > 0
    ? `批次 ${batch.id} 已隔离 ${conflicts.length} 条冲突记录，${accepted.length} 条有效记录进入待处理区等待落盘`
    : `批次 ${batch.id} 全部转换通过，${accepted.length} 条记录进入待处理区等待落盘`
}

function persistBatch(batch: MappingBatch, activeBatchId: string | null): void {
  const state = loadMappingState()
  const index = state.batches.findIndex((item) => item.id === batch.id)
  const batches = [...state.batches]
  if (index >= 0) {
    batches[index] = batch
  } else {
    batches.push(batch)
  }
  saveMappingState({ ...state, batches, activeBatchId })
}

export type RunMappingOptions = {
  strategy?: ConflictStrategy
  /** 演示中断：处理到第 N 条后停下，结果与最后成功位置会留存。 */
  interruptAfter?: number
  batchId?: string
  rules?: MappingRuleDef[]
}

export function runMapping(options: RunMappingOptions = {}): MappingExecutionResult {
  const state = loadMappingState()
  const resume = options.batchId
    ? state.batches.find((item) => item.id === options.batchId) ?? null
    : null
  // 续跑沿用中断批次的处置，避免恢复时悄悄换掉落盘范围。
  const strategy = options.strategy ?? resume?.strategy ?? 'pause'
  if (options.batchId && !resume) {
    return { ok: false, message: `没有找到批次 ${options.batchId}`, interrupted: false, batch: null }
  }
  if (resume && (resume.status === '已完成' || resume.status === '待落盘')) {
    return { ok: false, message: `批次 ${resume.id} 已处理完（${resume.status}），请新建批次`, interrupted: false, batch: clone(resume) }
  }

  const batch: MappingBatch = resume
    ? clone(resume)
    : {
        id: nextBatchId(state),
        createdAt: nowIso(),
        finishedAt: '',
        rules: clone(options.rules ?? enabledMappingRules()),
        sources: clone(state.sourceRecords),
        strategy,
        status: '处理中',
        sourceTotal: state.sourceRecords.length,
        processedCount: 0,
        lastSuccessRecordNo: '',
        results: [],
      }
  if (batch.rules.length === 0) {
    return { ok: false, message: '没有已启用的字段映射规则，先启用规则再执行映射', interrupted: false, batch: null }
  }
  batch.strategy = strategy
  batch.status = '处理中'
  batch.finishedAt = ''

  const remaining = batch.sources.slice(batch.processedCount)
  let processed = 0
  for (const source of remaining) {
    batch.results.push(evaluateRecord(source, batch.rules))
    batch.processedCount += 1
    batch.lastSuccessRecordNo = source.recordNo
    processed += 1
    if (options.interruptAfter && processed >= options.interruptAfter) {
      batch.status = '已中断'
      persistBatch(batch, batch.id)
      return {
        ok: true,
        message: `映射处理在 ${source.recordNo} 后中断，已留存 ${batch.results.length}/${batch.sourceTotal} 条结果，可从 ${source.recordNo} 之后继续`,
        interrupted: true,
        batch: clone(batch),
      }
    }
  }

  batch.results = finalizeUniqueness(batch.results, batch.rules)
  const issues = auditMappingBatch(batch)
  if (issues.length > 0) {
    batch.status = '已中断'
    persistBatch(batch, batch.id)
    return { ok: false, message: `映射结果复核未通过：${issues[0]}`, interrupted: true, batch: clone(batch) }
  }
  batch.finishedAt = nowIso()
  const message = settle(batch, strategy)
  persistBatch(batch, batch.id)
  return { ok: true, message, interrupted: false, batch: clone(batch) }
}

export function resumeMapping(batchId: string, strategy?: ConflictStrategy): MappingExecutionResult {
  return runMapping({ batchId, strategy })
}

/** 复核：批次结果条数、每条源记录唯一结果、错误字段不得残留到目标数据。 */
export function auditMappingBatch(batch: MappingBatch): string[] {
  const issues: string[] = []
  if (batch.results.length !== batch.processedCount) {
    issues.push(`结果明细 ${batch.results.length} 条与已处理 ${batch.processedCount} 条不一致`)
  }
  if (batch.status !== '已中断' && batch.results.length !== batch.sourceTotal) {
    issues.push(`结果明细 ${batch.results.length} 条与源记录 ${batch.sourceTotal} 条不一致，存在丢失`)
  }
  const seen = new Set<string>()
  for (const record of batch.results) {
    if (seen.has(record.recordNo)) {
      issues.push(`源记录 ${record.recordNo} 出现多个映射结果`)
    }
    seen.add(record.recordNo)
    for (const field of record.fields) {
      if (!field.ok && field.targetField in record.target) {
        issues.push(`源记录 ${record.recordNo} 的冲突字段 ${field.targetField} 残留到目标数据`)
      }
      if (field.ok && !field.skipped && field.value === null) {
        issues.push(`源记录 ${record.recordNo} 的字段 ${field.targetField} 显示成功但没有转换值`)
      }
      if (field.errorType === 'type' && field.value !== null) {
        issues.push(`源记录 ${record.recordNo} 的字段 ${field.targetField} 类型转换失败却留下半成品值`)
      }
    }
  }
  return issues
}

/* ------------------------------ 处置比较 ------------------------------ */

export function previewStrategyScopes(batch: MappingBatch): StrategyScope[] {
  const conflicts = findConflicts(batch)
  return [
    {
      strategy: 'pause',
      label: STRATEGY_LABEL.pause,
      accepted: conflicts.length > 0 ? 0 : batch.results.length,
      blocked: conflicts.length > 0 ? batch.results.length : 0,
      writable: conflicts.length === 0,
      description: conflicts.length > 0
        ? `整批停在映射阶段：${batch.results.length} 条记录都不落盘，${conflicts.length} 条冲突需修复后复核`
        : '当前没有冲突，整批记录都可以落盘',
    },
    {
      strategy: 'isolate',
      label: STRATEGY_LABEL.isolate,
      accepted: batch.results.filter((record) => record.status === '通过').length,
      blocked: conflicts.length,
      writable: true,
      description: `只落盘通过的记录，${conflicts.length} 条冲突记录保留原因并停留在映射阶段`,
    },
  ]
}

/** 对已有结果重新复核并切换处置：暂停整批或隔离冲突，落盘范围随即变化。 */
export function applyBatchStrategy(
  batchId: string,
  strategy: ConflictStrategy,
): MappingExecutionResult {
  const state = loadMappingState()
  const found = state.batches.find((item) => item.id === batchId)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchId}`, interrupted: false, batch: null }
  }
  if (found.status === '已中断' || found.status === '处理中') {
    return { ok: false, message: `批次 ${batchId} 尚未处理完，请先继续映射`, interrupted: true, batch: clone(found) }
  }
  if (found.status === '已完成') {
    return { ok: false, message: `批次 ${batchId} 已落盘，不能再切换处置`, interrupted: false, batch: clone(found) }
  }
  const batch = clone(found)
  batch.results = finalizeUniqueness(batch.results, batch.rules)
  const issues = auditMappingBatch(batch)
  if (issues.length > 0) {
    return { ok: false, message: `映射结果复核未通过：${issues[0]}`, interrupted: false, batch: clone(batch) }
  }
  batch.finishedAt = nowIso()
  const message = settle(batch, strategy)
  persistBatch(batch, batch.id)
  return { ok: true, message, interrupted: false, batch: clone(batch) }
}

export function repairConflictRecord(
  batchId: string,
  recordNo: string,
  values: Record<string, string>,
): MappingExecutionResult {
  const state = loadMappingState()
  const found = state.batches.find((item) => item.id === batchId)
  if (!found) {
    return { ok: false, message: `没有找到批次 ${batchId}`, interrupted: false, batch: null }
  }
  if (found.status === '已中断' || found.status === '处理中') {
    return { ok: false, message: `批次 ${batchId} 尚未处理完，请先继续映射再修复冲突`, interrupted: true, batch: clone(found) }
  }
  if (found.status === '已完成') {
    return { ok: false, message: `批次 ${batchId} 已落盘，源记录状态已定稿，不能再改映射值`, interrupted: false, batch: clone(found) }
  }
  const source = found.sources.find((item) => item.recordNo === recordNo)
  if (!source) {
    return { ok: false, message: `批次里没有源记录 ${recordNo}`, interrupted: false, batch: clone(found) }
  }
  const batch = clone(found)
  const batchSource = batch.sources.find((item) => item.recordNo === recordNo)!
  batchSource.values = { ...batchSource.values, ...values }
  const index = batch.results.findIndex((item) => item.recordNo === recordNo)
  if (index < 0) {
    return { ok: false, message: `源记录 ${recordNo} 还没有映射结果，先执行映射`, interrupted: false, batch: clone(found) }
  }
  batch.results[index] = evaluateRecord(batchSource, batch.rules)
  batch.results = finalizeUniqueness(batch.results, batch.rules)
  const conflicts = findConflicts(batch)
  batch.finishedAt = nowIso()
  const message = settle(batch, batch.strategy)
  // 修复值同步回源记录（只改值，不改源记录状态），下一批次能读到同样的源数据。
  const sourceRecords = state.sourceRecords.map((item) =>
    item.recordNo === recordNo ? { ...item, values: { ...item.values, ...values } } : item)
  persistBatch(batch, batch.id)
  saveMappingState({ ...loadMappingState(), sourceRecords })
  return {
    ok: true,
    message: conflicts.length > 0
      ? `${recordNo} 已按新源值复核，仍有 ${conflicts.length} 条冲突；${message}`
      : `${recordNo} 已修复，整批冲突清零；${message}`,
    interrupted: false,
    batch: clone(batch),
  }
}

/* ------------------------------ 数据落盘清单 ------------------------------ */

export function loadStorageManifest(configNo = ''): StorageManifest {
  const state = loadMappingState()
  const batch = latestMappingBatch()
  if (!batch) {
    return {
      batch: null,
      accepted: [],
      blocked: [],
      targetFields: [],
      storageRun: null,
      paused: false,
      ready: false,
      comparison: [],
      message: '尚未执行字段映射，数据落盘没有可接收的结果明细',
      error: '',
    }
  }
  const conflicts = findConflicts(batch)
  const prepared = batch.status === '待落盘'
  const paused = batch.status === '已暂停' || (conflicts.length > 0 && batch.strategy === 'pause')
  // 暂停整批或处理中断时，待处理区不接收任何记录；只有复核通过后才同步通过记录。
  const accepted = paused || !prepared ? [] : batch.results.filter((record) => record.status === '通过')
  const ready = prepared && !paused && accepted.length > 0
  const storageRun = state.storageRuns.find((item) => item.batchId === batch.id && item.configNo === configNo) ?? null
  const comparison = batch.results.length === batch.sourceTotal
    ? previewStrategyScopes(batch)
    : []
  let message = ''
  let error = ''
  if (batch.status === '已中断') {
    error = `批次 ${batch.id} 中断在 ${batch.lastSuccessRecordNo}，仅留存 ${batch.results.length}/${batch.sourceTotal} 条结果，需继续映射`
    message = error
  } else if (paused) {
    message = `批次 ${batch.id} 已暂停整批映射直到冲突修复，待处理区没有记录可落盘`
  } else if (batch.status === '待落盘' && conflicts.length > 0) {
    message = `批次 ${batch.id} 按「${strategyLabel(batch.strategy)}」隔离冲突：待处理区已同步 ${accepted.length} 条有效记录，${conflicts.length} 条冲突停在映射阶段`
  } else if (batch.status === '待落盘') {
    message = `批次 ${batch.id} 冲突已修复，待处理区已同步 ${accepted.length} 条记录，确认后落盘`
  } else if (batch.status === '已完成' && storageRun) {
    message = `批次 ${batch.id} 已落盘 ${storageRun.recordNos.length} 条记录，源记录状态原样保留`
  } else if (batch.status === '处理中') {
    message = `批次 ${batch.id} 正在映射，待处理区暂不接收记录`
  } else {
    message = `批次 ${batch.id} 没有可落盘记录`
  }
  return {
    batch,
    accepted: clone(accepted),
    blocked: clone(conflicts),
    targetFields: batch.rules.map((rule) => rule.targetField),
    storageRun: clone(storageRun),
    paused,
    ready,
    comparison,
    message,
    error,
  }
}

/** 数据落盘确认：只写已通过记录；暂停整批时一条都不写。 */
export function commitMappingBatch(configNo = '', strategy?: ConflictStrategy): MappingExecutionResult {
  const state = loadMappingState()
  const batch = latestMappingBatch()
  if (!batch) {
    return { ok: false, message: '尚未执行字段映射，无法落盘', interrupted: false, batch: null }
  }
  if (batch.status === '已中断' || batch.status === '处理中') {
    return { ok: false, message: `批次 ${batch.id} 尚未处理完，不能落盘`, interrupted: true, batch }
  }
  if (batch.status === '已完成') {
    return { ok: false, message: `批次 ${batch.id} 已落盘，不能重复写入`, interrupted: false, batch }
  }
  const conflicts = findConflicts(batch)
  const chosen = strategy ?? batch.strategy
  if (batch.status === '已暂停' || (conflicts.length > 0 && chosen === 'pause')) {
    return {
      ok: false,
      message: `批次 ${batch.id} 存在 ${conflicts.length} 条冲突，按「${STRATEGY_LABEL.pause}」暂停整批，未写入数据落盘`,
      interrupted: false,
      batch,
    }
  }
  if (conflicts.length > 0 && batch.strategy === 'pause') {
    return {
      ok: false,
      message: `批次 ${batch.id} 停在映射阶段，需先切换为「${STRATEGY_LABEL.isolate}」或修复冲突`,
      interrupted: false,
      batch,
    }
  }
  const issues = auditMappingBatch(batch)
  if (issues.length > 0) {
    return { ok: false, message: `映射结果复核未通过，不能落盘：${issues[0]}`, interrupted: false, batch }
  }
  const accepted = batch.results.filter((record) => record.status === '通过')
  if (accepted.length === 0) {
    return {
      ok: false,
      message: `批次 ${batch.id} 没有通过复核的记录，数据落盘不接受任何记录`,
      interrupted: false,
      batch,
    }
  }
  const current = state.batches.find((item) => item.id === batch.id) ?? batch
  const landed: MappingBatch = { ...clone(current), status: '已完成', strategy: chosen, finishedAt: nowIso() }
  const run: StorageRun = {
    id: `LAND-${batch.id}-${configNo || 'DEFAULT'}`,
    batchId: batch.id,
    configNo,
    writtenAt: nowIso(),
    strategy: chosen,
    recordNos: accepted.map((record) => record.recordNo),
    records: accepted.map<LandedRecord>((record) => ({
      recordNo: record.recordNo,
      sourceStatus: record.sourceStatus,
      target: clone(record.target),
    })),
  }
  const batches = state.batches.map((item) => (item.id === batch.id ? landed : item))
  const storageRuns = [
    ...state.storageRuns.filter((item) => !(item.batchId === batch.id && item.configNo === configNo)),
    run,
  ]
  saveMappingState({ ...state, batches, storageRuns, activeBatchId: null })
  return {
    ok: true,
    message: `批次 ${batch.id} 已落盘 ${run.records.length} 条记录${conflicts.length > 0 ? `，${conflicts.length} 条冲突记录保留原因停在映射阶段` : ''}`,
    interrupted: false,
    batch: clone(landed),
  }
}

export function landedRecords(batchId: string, configNo = ''): LandedRecord[] {
  const state = loadMappingState()
  const run = state.storageRuns.find((item) => item.batchId === batchId && item.configNo === configNo)
  return clone(run ? run.records : [])
}
