import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  applyBatchStrategy,
  auditMappingBatch,
  batchRuleSnapshot,
  getMappingSnapshot,
  listMappingRules,
  latestMappingBatch,
  loadStorageManifest,
  repairConflictRecord,
  resumeMapping,
  runMapping,
  strategyLabel,
} from '@/api/local-service'
import type {
  ConflictStrategy,
  MappingBatch,
  MappingRuleDef,
  MappingState,
  RecordMappingResult,
  StrategyScope,
} from '@/data/mapping-types'

const STRATEGIES: ConflictStrategy[] = ['pause', 'isolate']

const ERROR_LABEL: Record<string, string> = {
  required: '必填缺失',
  type: '类型转换失败',
  unique: '唯一性冲突',
  rule: '规则错误',
}

function formatTime(value: string): string {
  if (!value) return '—'
  return value.replace('T', ' ').slice(0, 19)
}

function fieldCell(record: RecordMappingResult, targetField: string) {
  const field = record.fields.find((item) => item.targetField === targetField)
  if (!field) {
    return <span className="muted-cell">—</span>
  }
  if (!field.ok) {
    return (
      <span className="error-value" title={field.error}>
        {ERROR_LABEL[field.errorType] ?? '映射失败'}
      </span>
    )
  }
  if (field.skipped || field.value === null) {
    return <span className="muted-cell">（空）</span>
  }
  return <span>{field.value}</span>
}

type Props = {
  onNotify: (message: string, isError?: boolean) => void
  /** 上层规则清单变化（启用/停用规则）时递增，执行区重新读取规则主数据。 */
  refreshKey?: string
}

export default function MappingWorkbench({ onNotify, refreshKey = '' }: Props) {
  const [snapshot, setSnapshot] = useState<MappingState>(() => getMappingSnapshot())
  const [strategy, setStrategy] = useState<ConflictStrategy>('pause')
  const [interruptAfter, setInterruptAfter] = useState('4')
  const [repairRecordNo, setRepairRecordNo] = useState('')
  const [repairValues, setRepairValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const rules = useMemo<MappingRuleDef[]>(() => listMappingRules(), [snapshot])
  const batch: MappingBatch | null = useMemo(() => latestMappingBatch(), [snapshot])
  const manifest = useMemo(() => loadStorageManifest(), [snapshot])
  // 结果明细按批次规则快照渲染，规则后来启停不会让已留存的结果错列。
  const resultRules = useMemo<MappingRuleDef[]>(
    () => (batch ? batch.rules : batchRuleSnapshot()),
    [batch],
  )

  const refresh = useCallback(() => {
    setSnapshot(getMappingSnapshot())
  }, [])

  useEffect(() => {
    refresh()
  }, [refreshKey, refresh])

  const conflicts = batch ? batch.results.filter((record) => record.status === '冲突') : []
  const passed = batch ? batch.results.filter((record) => record.status === '通过') : []
  const fieldErrors = batch
    ? batch.results.flatMap((record) =>
        record.fields
          .filter((field) => !field.ok)
          .map((field) => ({ record, field })))
    : []

  useEffect(() => {
    if (batch) {
      setStrategy(batch.strategy)
    }
  }, [batch?.id])

  useEffect(() => {
    if (!batch) return
    const stillConflict = conflicts.some((record) => record.recordNo === repairRecordNo)
    if (!stillConflict) {
      setRepairRecordNo(conflicts[0]?.recordNo ?? '')
    }
  }, [batch, conflicts, repairRecordNo])

  useEffect(() => {
    if (!repairRecordNo) {
      setRepairValues({})
      return
    }
    const source = batch?.sources.find((item) => item.recordNo === repairRecordNo)
    if (source) {
      const next: Record<string, string> = {}
      for (const rule of rules) {
        next[rule.sourceField] = source.values[rule.sourceField] ?? ''
      }
      setRepairValues(next)
    }
  }, [repairRecordNo, batch?.id])

  const comparison: StrategyScope[] = manifest.comparison

  function handleRun(options: { interrupt?: boolean; resume?: boolean } = {}) {
    setBusy(true)
    try {
      let result
      if (options.resume && batch) {
        result = resumeMapping(batch.id, strategy)
      } else if (options.interrupt) {
        const limit = Number(interruptAfter)
        if (!Number.isFinite(limit) || limit <= 0) {
          onNotify('中断位置必须是大于 0 的整数', true)
          return
        }
        result = runMapping({ strategy, interruptAfter: limit })
      } else {
        result = runMapping({ strategy })
      }
      refresh()
      onNotify(result.message, !result.ok)
    } catch (error) {
      onNotify(error instanceof Error ? error.message : '映射执行失败', true)
    } finally {
      setBusy(false)
    }
  }

  function handleApplyStrategy() {
    if (!batch) {
      onNotify('尚未执行映射，无法切换处置', true)
      return
    }
    if (!['已暂停', '待落盘'].includes(batch.status)) {
      onNotify(`批次 ${batch.id} 当前为「${batch.status}」，处置只能调整已暂停或待落盘的批次`, true)
      return
    }
    setBusy(true)
    try {
      const result = applyBatchStrategy(batch.id, strategy)
      refresh()
      onNotify(result.message, !result.ok)
    } finally {
      setBusy(false)
    }
  }

  function handleRepair() {
    if (!batch || !repairRecordNo) {
      onNotify('请选择需要修复的冲突记录', true)
      return
    }
    setBusy(true)
    try {
      const result = repairConflictRecord(batch.id, repairRecordNo, repairValues)
      refresh()
      onNotify(result.message, !result.ok)
    } finally {
      setBusy(false)
    }
  }

  const repairTarget = conflicts.find((record) => record.recordNo === repairRecordNo) ?? null
  const reviewIssues = useMemo(() => (batch ? auditMappingBatch(batch) : []), [batch])
  const reviewPassed = batch !== null && batch.results.length === batch.sourceTotal && reviewIssues.length === 0

  return (
    <section className="mapping-workbench" data-testid="mapping-workbench">
      <header className="section-head">
        <div>
          <h3>字段映射执行</h3>
          <p className="page-desc">
            每条源记录逐条转换、归并为一个映射结果；唯一性冲突覆盖整批记录，冲突记录不进入目标数据。
          </p>
        </div>
        <div className="page-actions">
          <label className="inline-field">
            <span>处置方式</span>
            <select value={strategy} onChange={(event) => setStrategy(event.target.value as ConflictStrategy)}>
              {STRATEGIES.map((item) => (
                <option key={item} value={item}>{strategyLabel(item)}</option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" disabled={busy} onClick={handleApplyStrategy}>
            应用处置
          </button>
          <button className="btn primary" type="button" disabled={busy} onClick={() => handleRun()}>
            执行映射
          </button>
          <label className="inline-field">
            <span>中断位置</span>
            <input
              type="number"
              min={1}
              value={interruptAfter}
              onChange={(event) => setInterruptAfter(event.target.value)}
            />
          </label>
          <button className="btn" type="button" disabled={busy} onClick={() => handleRun({ interrupt: true })}>
            执行并在第 {interruptAfter || '4'} 条中断
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy || !batch || batch.status !== '已中断'}
            onClick={() => handleRun({ resume: true })}
          >
            从中断处继续
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">启用映射规则</span>
          <strong className="stat-value">{rules.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">源记录</span>
          <strong className="stat-value">{batch ? batch.sourceTotal : snapshot.sourceRecords.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已处理 / 结果明细</span>
          <strong className="stat-value">{batch ? `${batch.processedCount} / ${batch.results.length}` : '0 / 0'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">通过 / 冲突</span>
          <strong className="stat-value">{passed.length} / {conflicts.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">批次状态</span>
          <strong className="stat-value small">{batch ? batch.status : '未执行'}</strong>
        </article>
      </div>

      {batch && (
        <div className={`batch-banner batch-${batch.status}`} data-testid="batch-banner">
          <div>
            <strong>批次 {batch.id}</strong>
            <span>执行时间 {formatTime(batch.createdAt)}</span>
            <span>处置：{strategyLabel(batch.strategy)}</span>
            <span>最后成功位置：{batch.lastSuccessRecordNo || '—'}</span>
            <span>当天留存结果：{batch.results.length} 条（{formatTime(batch.createdAt).slice(0, 10)}）</span>
          </div>
          <p>{manifest.message}</p>
          {manifest.error && <p className="error-text">{manifest.error}</p>}
        </div>
      )}

      <h3 className="subsection-title">映射规则（主数据）</h3>
      <p className="page-desc">
        规则编号、字段映射与映射规则来自字段映射登记行，只有启用规则参与执行；批次内冻结快照，规则编号可追溯到当时版本。
      </p>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>规则编号</th>
            <th>字段映射（源字段 → 目标字段）</th>
            <th>映射规则</th>
            <th>类型转换</th>
            <th>必填</th>
            <th>唯一性</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.ruleNo}>
              <td>{rule.ruleNo}</td>
              <td>{rule.sourceField} → {rule.targetField}</td>
              <td>
                {rule.expression ? `清洗 ${rule.expression}` : '原值直取'}
                {rule.defaultValue ? `；空值填充 ${rule.defaultValue}` : ''}
              </td>
              <td>{rule.transform}</td>
              <td>{rule.required ? '必填' : '可选'}</td>
              <td>{rule.unique ? '唯一' : '不校验'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="subsection-title">字段映射结果明细</h3>
      <p className="page-desc">
        每条源记录只有一行结果；转换失败的单元格显示错误类型而不再展示原值，冲突字段不会写入目标数据。
      </p>
      <div className="table-scroll">
        <table className="data-table compact" data-testid="mapping-results">
          <thead>
            <tr>
              <th>源记录编号</th>
              <th>源记录状态</th>
              {resultRules.map((rule) => (
                <th key={rule.targetField}>{rule.targetField}</th>
              ))}
              <th>映射结果</th>
              <th>冲突原因</th>
            </tr>
          </thead>
          <tbody>
            {batch?.results.map((record) => (
              <tr key={record.recordNo} className={record.status === '冲突' ? 'row-conflict' : ''}>
                <td>{record.recordNo}</td>
                <td>{record.sourceStatus}</td>
                {resultRules.map((rule) => (
                  <td key={rule.targetField}>{fieldCell(record, rule.targetField)}</td>
                ))}
                <td>
                  <span className={record.status === '冲突' ? 'tag danger' : 'tag ok'}>{record.status}</span>
                </td>
                <td className="reason-cell">
                  {record.reasons.length === 0 ? '—' : record.reasons.map((reason) => (
                    <div key={reason} className="error-text">{reason}</div>
                  ))}
                </td>
              </tr>
            ))}
            {(!batch || batch.results.length === 0) && (
              <tr>
                <td className="empty-state" colSpan={resultRules.length + 4}>尚未执行映射，结果明细为空</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="subsection-title">结果复核</h3>
      <div className={`review-panel ${reviewIssues.length > 0 ? 'review-fail' : ''}`} data-testid="mapping-review">
        <div>
          <strong>
            {batch ? `复核依据：${strategyLabel(batch.strategy)}` : '等待执行映射'}
          </strong>
          <span>
            源记录 {batch ? batch.sourceTotal : snapshot.sourceRecords.length} 条 ·
            结果明细 {batch ? batch.results.length : 0} 条 ·
            每条源记录结果数 {batch && batch.results.length > 0
              ? (new Set(batch.results.map((item) => item.recordNo)).size === batch.results.length ? '1' : '存在重复')
              : '—'}
          </span>
        </div>
        {reviewIssues.length === 0 ? (
          <p className="success-text">
            {batch && batch.results.length === batch.sourceTotal
              ? '复核通过：没有错位或丢失，冲突字段均未写入目标数据'
              : '结果明细尚未覆盖全部源记录，继续映射后再复核'}
          </p>
        ) : (
          <ul className="review-issues">
            {reviewIssues.map((issue) => <li key={issue} className="error-text">{issue}</li>)}
          </ul>
        )}
        {!reviewPassed && batch && batch.results.length !== batch.sourceTotal && (
          <p className="error-text">
            错位/丢失原因：批次在 {batch.lastSuccessRecordNo || '开始处'} 中断，仅留存 {batch.results.length}/{batch.sourceTotal} 条，需从最后一次成功位置继续。
          </p>
        )}
      </div>

      <h3 className="subsection-title">字段级错误</h3>
      <table className="data-table compact" data-testid="field-errors">
        <thead>
          <tr>
            <th>规则编号</th>
            <th>源记录</th>
            <th>字段映射</th>
            <th>原始值</th>
            <th>错误类型</th>
            <th>原因</th>
            <th>目标字段处置</th>
          </tr>
        </thead>
        <tbody>
          {fieldErrors.map(({ record, field }) => (
            <tr key={`${record.recordNo}-${field.ruleNo}`}>
              <td>{field.ruleNo}</td>
              <td>{record.recordNo}</td>
              <td>{field.sourceField} → {field.targetField}</td>
              <td className="raw-value">{field.rawValue === '' ? '（空）' : field.rawValue}</td>
              <td><span className="tag danger">{ERROR_LABEL[field.errorType] ?? '映射失败'}</span></td>
              <td className="error-text">{field.error}</td>
              <td>{field.errorType === 'type' ? '未写入（不留半成品）' : '未写入'}</td>
            </tr>
          ))}
          {fieldErrors.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={7}>没有字段级错误</td>
            </tr>
          )}
        </tbody>
      </table>

      {comparison.length > 0 && (
        <>
          <h3 className="subsection-title">两种处置的落盘范围比较</h3>
          <div className="strategy-grid" data-testid="strategy-compare">
            {comparison.map((scope) => (
              <article key={scope.strategy} className={`strategy-card ${scope.strategy === batch?.strategy ? 'active' : ''}`}>
                <h4>{scope.label}</h4>
                <p>{scope.description}</p>
                <dl>
                  <div><dt>可落盘记录</dt><dd>{scope.accepted}</dd></div>
                  <div><dt>停在映射阶段</dt><dd>{scope.blocked}</dd></div>
                  <div><dt>落盘状态</dt><dd>{scope.writable && scope.accepted > 0 ? '可落盘' : '不落盘'}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </>
      )}

      {conflicts.length > 0 && (
        <>
          <h3 className="subsection-title">冲突修复与复核</h3>
          <div className="repair-panel">
            <label className="inline-field">
              <span>冲突记录</span>
              <select value={repairRecordNo} onChange={(event) => setRepairRecordNo(event.target.value)}>
                {conflicts.map((record) => (
                  <option key={record.recordNo} value={record.recordNo}>
                    {record.recordNo}（{record.reasons.length} 条原因）
                  </option>
                ))}
              </select>
            </label>
            {repairTarget && (
              <div className="repair-reasons">
                {repairTarget.reasons.map((reason) => (
                  <div key={reason} className="error-text">{reason}</div>
                ))}
              </div>
            )}
            <div className="repair-fields">
              {resultRules.map((rule) => (
                <label key={rule.sourceField} className="filter-item">
                  <span>{rule.sourceField} → {rule.targetField}</span>
                  <input
                    value={repairValues[rule.sourceField] ?? ''}
                    onChange={(event) => setRepairValues((prev) => ({ ...prev, [rule.sourceField]: event.target.value }))}
                  />
                </label>
              ))}
            </div>
            <button className="btn primary" type="button" disabled={busy} onClick={handleRepair}>
              按新源值复核
            </button>
          </div>
        </>
      )}

      <h3 className="subsection-title">数据落盘联动</h3>
      <div className="handoff-panel">
        <p>{manifest.message}</p>
        <dl className="handoff-stats">
          <div><dt>待处理区记录</dt><dd>{manifest.accepted.length}</dd></div>
          <div><dt>冲突停映射</dt><dd>{manifest.blocked.length}</dd></div>
          <div><dt>已落盘</dt><dd>{manifest.storageRun ? manifest.storageRun.records.length : 0}</dd></div>
          <div><dt>源记录状态</dt><dd>原样保留</dd></div>
        </dl>
        <p className="page-desc">
          待处理区只同步已通过复核的记录；批次暂停或中断时，待处理区为空，数据落盘不接受任何记录。
        </p>
      </div>
    </section>
  )
}
