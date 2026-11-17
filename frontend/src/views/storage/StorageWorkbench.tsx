import { useCallback, useEffect, useMemo, useState } from 'react'

import { applyBatchStrategy, commitMappingBatch, landedRecords, loadStorageManifest, strategyLabel } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { StorageManifest } from '@/data/mapping-types'

type Props = {
  configs: EntryRow[]
  onNotify: (message: string, isError?: boolean) => void
}

export default function StorageWorkbench({ configs, onNotify }: Props) {
  const [configNo, setConfigNo] = useState('')
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)

  const manifest: StorageManifest = useMemo(
    () => loadStorageManifest(configNo),
    [configNo, version],
  )

  useEffect(() => {
    if (!configNo && configs.length > 0) {
      const enabled = configs.find((row) => String(row.status) === '已启用')
      setConfigNo(String((enabled ?? configs[0])['配置编号'] ?? ''))
    }
  }, [configs, configNo])

  const landed = useMemo(
    () => (manifest.batch ? landedRecords(manifest.batch.id, configNo) : []),
    [manifest, configNo, version],
  )

  const refresh = useCallback(() => setVersion((value) => value + 1), [])

  function handleCommit() {
    if (!manifest.batch) {
      onNotify('尚未执行字段映射，数据落盘没有可接收的结果明细', true)
      return
    }
    setBusy(true)
    try {
      const result = commitMappingBatch(configNo)
      refresh()
      onNotify(result.message, !result.ok)
    } catch (error) {
      onNotify(error instanceof Error ? error.message : '数据落盘失败', true)
    } finally {
      setBusy(false)
    }
  }

  function handleIsolate() {
    if (!manifest.batch) return
    setBusy(true)
    try {
      const result = applyBatchStrategy(manifest.batch.id, 'isolate')
      refresh()
      onNotify(result.message, !result.ok)
    } finally {
      setBusy(false)
    }
  }

  function handleReload() {
    refresh()
    onNotify('已重新读取字段映射结果明细')
  }

  return (
    <section className="storage-workbench" data-testid="storage-workbench">
      <header className="section-head">
        <div>
          <h3>待处理区 · 字段映射结果明细</h3>
          <p className="page-desc">
            数据落盘只接收字段映射结果明细中已通过的记录；冲突记录保留原因并停在映射阶段，源记录状态原样保留。
          </p>
        </div>
        <div className="page-actions">
          <label className="inline-field">
            <span>存储配置</span>
            <select value={configNo} onChange={(event) => setConfigNo(event.target.value)}>
              <option value="">未选择配置</option>
              {configs.map((row) => (
                <option key={String(row.id)} value={String(row['配置编号'] ?? '')}>
                  {String(row['配置编号'] ?? '')}（{String(row['输出路径'] ?? '')}）
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="button" disabled={busy} onClick={handleReload}>
            重新读取结果明细
          </button>
          {manifest.paused && manifest.blocked.length > 0 && (
            <button className="btn" type="button" disabled={busy} onClick={handleIsolate}>
              改为隔离冲突处理
            </button>
          )}
          <button className="btn primary" type="button" disabled={busy || !manifest.ready} onClick={handleCommit}>
            确认落盘
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">映射批次</span>
          <strong className="stat-value small">{manifest.batch ? manifest.batch.id : '未执行'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">落盘状态</span>
          <strong className="stat-value small">
            {manifest.ready ? '待确认' : manifest.storageRun ? '已落盘' : '不可落盘'}
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待处理区记录</span>
          <strong className="stat-value">{manifest.accepted.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">冲突停映射</span>
          <strong className="stat-value">{manifest.blocked.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已落盘记录</span>
          <strong className="stat-value">{landed.length}</strong>
        </article>
      </div>

      <div className={`batch-banner ${manifest.paused ? 'batch-已暂停' : ''}`} data-testid="storage-manifest">
        <div>
          <strong>{manifest.paused ? '暂停整批映射直到冲突修复' : '数据落盘联动'}</strong>
          {manifest.batch && (
            <span>
              批次 {manifest.batch.id} · 处置 {strategyLabel(manifest.batch.strategy)} · 状态 {manifest.batch.status}
            </span>
          )}
        </div>
        <p>{manifest.message}</p>
        {manifest.error && <p className="error-text">{manifest.error}</p>}
      </div>

      {manifest.comparison.length > 0 && (
        <>
          <h3 className="subsection-title">两种处置比较（判定数据落盘状态）</h3>
          <div className="strategy-grid" data-testid="storage-compare">
            {manifest.comparison.map((scope) => (
              <article
                key={scope.strategy}
                className={`strategy-card ${manifest.batch && scope.strategy === manifest.batch.strategy ? 'active' : ''}`}
              >
                <h4>{scope.label}</h4>
                <p>{scope.description}</p>
                <dl>
                  <div><dt>可落盘</dt><dd>{scope.accepted}</dd></div>
                  <div><dt>停映射</dt><dd>{scope.blocked}</dd></div>
                  <div><dt>判定</dt><dd>{manifest.batch && scope.strategy === manifest.batch.strategy ? '当前生效' : '备选'}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        </>
      )}

      <div className="strategy-grid">
        <article className="strategy-card">
          <h4>待处理区（已通过）</h4>
          <p>来自字段映射结果明细的最后成功结果，暂停时清空。</p>
          <ul className="record-list" data-testid="accepted-records">
            {manifest.accepted.map((record) => (
              <li key={record.recordNo}>
                <code>{record.recordNo}</code>
                <span>{Object.entries(record.target).map(([key, value]) => `${key}=${value}`).join(' · ')}</span>
              </li>
            ))}
            {manifest.accepted.length === 0 && <li className="muted-cell">暂无待落盘记录</li>}
          </ul>
        </article>
        <article className="strategy-card">
          <h4>冲突记录（停在映射阶段）</h4>
          <p>保留具体原因，不进入目标数据。</p>
          <ul className="record-list" data-testid="blocked-records">
            {manifest.blocked.map((record) => (
              <li key={record.recordNo}>
                <code>{record.recordNo}</code>
                <span className="error-text">{record.reasons.join('；')}</span>
              </li>
            ))}
            {manifest.blocked.length === 0 && <li className="muted-cell">没有冲突记录</li>}
          </ul>
        </article>
      </div>

      <h3 className="subsection-title">数据落盘清单</h3>
      <div className="table-scroll">
        <table className="data-table compact" data-testid="landed-table">
          <thead>
            <tr>
              <th>源记录编号</th>
              <th>源记录状态</th>
              {manifest.targetFields.map((field) => <th key={field}>{field}</th>)}
            </tr>
          </thead>
          <tbody>
            {landed.map((record) => (
              <tr key={record.recordNo}>
                <td>{record.recordNo}</td>
                <td>{record.sourceStatus}</td>
                {manifest.targetFields.map((field) => (
                  <td key={field}>{record.target[field] ?? '—'}</td>
                ))}
              </tr>
            ))}
            {landed.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={manifest.targetFields.length + 2}>
                  本批次还没有记录落盘
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="page-desc">落盘完成后源记录状态保持不变，未通过的记录不会出现在这张清单里。</p>
    </section>
  )
}
