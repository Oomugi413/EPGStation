import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import MenuItem from '@mui/material/MenuItem'
import TextField from '@mui/material/TextField'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuleListItem, SearchChannelOption, SearchRuleApiRepository } from '../api'
import type { SearchRulePayload } from '../query'
import {
  type BangumiRulePayload,
  type BangumiSubject,
  type Candidate,
  candidateGroups,
  createRule,
  defaultCandidateIndices,
  defaultQuarter,
  fetchBangumiWatching,
  filterQuarter,
  hasDuplicateRule,
  isValidDirectory,
  quarterLabel,
  resolveRomaji,
  scanWithConcurrency,
  searchTitle,
} from '@/lib/bangumiImport.mjs'
import styles from '../SearchRulePage.module.css'

const BANGUMI_USER_STORAGE_KEY = 'bangumi-quarter-user'

type ChoiceResult = '' | 'creating' | 'created' | 'exists' | 'failed'

interface Choice {
  candidate: Candidate
  rule: SearchRulePayload
  channelLabel: string
  selected: boolean
  result: ChoiceResult
  detail: string
  defaultDirectory: string
}

interface ImportItem {
  subject: BangumiSubject
  keyword: string
  reason: string
  choices: Choice[]
  lookupFailed: boolean
  searching: boolean
  alreadyLinked: boolean
  linkedReserves: number | null
}

interface ScanCache {
  user: string
  quarter: string
  savedAt: number
  items: ImportItem[]
}

interface InitialState {
  user: string
  quarter: string
  items: ImportItem[]
  restored: boolean
  restoredInfo: string
  status: string
}

export interface BangumiQuarterImportProps {
  apiRepository: SearchRuleApiRepository
  onCreated: () => void
}

let scanCache: ScanCache | null = null

function cloneItems(items: ImportItem[]): ImportItem[] {
  return structuredClone(items).map((item) => ({ ...item, searching: false }))
}

function formatCacheDate(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function readStoredUser(): string {
  try {
    const stored = window.localStorage.getItem(BANGUMI_USER_STORAGE_KEY)
    if (stored === null) return ''
    try {
      const decoded: unknown = JSON.parse(stored)
      return typeof decoded === 'string' ? decoded : ''
    } catch {
      // v2's storage wrapper serialized strings, but accept an older plain value as well.
      return stored
    }
  } catch {
    return ''
  }
}

function writeStoredUser(user: string): void {
  try {
    window.localStorage.setItem(BANGUMI_USER_STORAGE_KEY, JSON.stringify(user))
  } catch {
    // The import remains usable in private/storage-restricted browser contexts.
  }
}

function initialState(): InitialState {
  const user = readStoredUser()
  const quarter = defaultQuarter()
  const cache = scanCache

  if (
    cache !== null &&
    cache.items.length > 0 &&
    cache.user === user &&
    cache.quarter === quarter
  ) {
    return {
      user,
      quarter,
      items: cloneItems(cache.items),
      restored: true,
      restoredInfo: `${formatCacheDate(cache.savedAt)} に照合した ${cache.items.length} 作品`,
      status: '前回の照合結果を表示しています。番組表を照合で取り直せます。',
    }
  }

  return { user, quarter, items: [], restored: false, restoredInfo: '', status: '' }
}

function normalizeRule(rule: BangumiRulePayload): SearchRulePayload {
  return {
    ...rule,
    reserveOption: {
      ...rule.reserveOption,
      periodToAvoidDuplicate: null,
    },
    saveOption: {
      parentDirectoryName: null,
      directory: rule.saveOption.directory,
      recordedFormat: null,
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '不明なエラー'
}

function formatDate(timestamp?: number): string {
  if (timestamp === undefined) return '日時不明'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function formatTime(seconds: number): string {
  return `${String(Math.floor((seconds % 86_400) / 3_600)).padStart(2, '0')}:${String(
    Math.floor((seconds % 3_600) / 60),
  ).padStart(2, '0')}`
}

function resultLabel(choice: Choice): string {
  const labels: Record<ChoiceResult, string> = {
    '': '',
    creating: '作成中',
    created: '作成済み',
    exists: '既存',
    failed: '失敗',
  }
  return `${labels[choice.result]}${choice.detail ? `: ${choice.detail}` : ''}`
}

export function BangumiQuarterImport({ apiRepository, onCreated }: BangumiQuarterImportProps) {
  const initial = useMemo(initialState, [])
  const [user, setUser] = useState(initial.user)
  const [quarter, setQuarter] = useState(initial.quarter)
  const [items, setItems] = useState(initial.items)
  const [restored, setRestored] = useState(initial.restored)
  const [restoredInfo, setRestoredInfo] = useState(initial.restoredInfo)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(0)
  const [confirmCount, setConfirmCount] = useState(0)
  const [status, setStatus] = useState(initial.status)
  const [error, setError] = useState('')
  const channelsRef = useRef(new Map<number, SearchChannelOption>())
  const linkedRulesRef = useRef(new Map<number, RuleListItem>())
  const subjectSummaryRefs = useRef(new Map<number, HTMLElement>())
  const busy = scanning || saving || retrying > 0

  const quarters = useMemo(() => {
    const year = new Date().getFullYear()
    return [year - 1, year, year + 1, year + 2].flatMap((targetYear) =>
      [1, 4, 7, 10].map((month) => {
        const value = `${targetYear}-${String(month).padStart(2, '0')}`
        return { value, label: quarterLabel(value) }
      }),
    )
  }, [])
  const selectableChoices = items.flatMap((item) =>
    item.choices.filter(
      (choice) => choice.selected && (choice.result === '' || choice.result === 'failed'),
    ),
  )
  const selectedCount = selectableChoices.length
  const invalidSelection = selectableChoices.some(
    (choice) => !isValidDirectory(choice.rule.saveOption.directory ?? undefined),
  )

  const persist = (nextItems: ImportItem[], nextUser = user, nextQuarter = quarter) => {
    if (nextItems.length === 0) return
    const savedAt =
      scanCache !== null && scanCache.user === nextUser && scanCache.quarter === nextQuarter
        ? scanCache.savedAt
        : Date.now()
    scanCache = {
      user: nextUser,
      quarter: nextQuarter,
      savedAt,
      items: cloneItems(nextItems),
    }
  }

  const replaceItems = (update: (current: ImportItem[]) => ImportItem[]) => {
    setItems((current) => {
      const next = update(current)
      persist(next)
      return next
    })
  }

  const loadAllRules = async (): Promise<RuleListItem[]> => {
    const rules: RuleListItem[] = []
    for (;;) {
      const result = await apiRepository.fetchRules({
        type: 'all',
        offset: rules.length,
        limit: 500,
        isHalfWidth: false,
      })
      if (!result.ok) throw new Error(result.message)
      rules.push(...result.value.rules)
      if (rules.length >= result.value.total || result.value.rules.length === 0) return rules
    }
  }

  const applyLinkedRules = (rules: RuleListItem[]) => {
    linkedRulesRef.current = new Map(
      rules.flatMap((rule) =>
        typeof rule.bangumiId === 'number' ? [[rule.bangumiId, rule] as const] : [],
      ),
    )
    replaceItems((current) =>
      current.map((item) => {
        const linked = linkedRulesRef.current.get(item.subject.id)
        return {
          ...item,
          alreadyLinked: linked !== undefined,
          linkedReserves: linked?.reservesCnt ?? null,
        }
      }),
    )
  }

  const refreshLinkedRules = async (): Promise<RuleListItem[]> => {
    const rules = await loadAllRules()
    applyLinkedRules(rules)
    return rules
  }

  useEffect(() => {
    if (!initial.restored) return
    void refreshLinkedRules().catch(() => {
      // Cached linked counts stay visible while the backend is temporarily unavailable.
    })
    // The restored snapshot is intentionally refreshed once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scanSubject = async (subject: BangumiSubject): Promise<ImportItem> => {
    const linked = linkedRulesRef.current.get(subject.id)
    const item: ImportItem = {
      subject,
      keyword: '',
      reason: '',
      choices: [],
      lookupFailed: false,
      searching: false,
      alreadyLinked: linked !== undefined,
      linkedReserves: linked?.reservesCnt ?? null,
    }
    if (!subject.date) {
      return { ...item, reason: '放送開始日が不明のため自動選択しません' }
    }
    if (!subject.name) return { ...item, reason: '作品名がありません' }

    try {
      const found = await searchTitle(subject.name, async (keyword) => {
        const result = await apiRepository.searchSchedules({
          option: {
            keyword,
            keyCS: false,
            keyRegExp: false,
            name: true,
            description: false,
            extended: false,
            times: [],
          },
          isHalfWidth: false,
          limit: 50,
        })
        if (!result.ok) throw new Error(result.message)
        return [...result.value]
      })
      const groups = candidateGroups(found.programs)
      if (groups.length === 0) {
        return { ...item, keyword: found.keyword, reason: '番組表に一致する番組がありません' }
      }
      const romaji = await resolveRomaji(subject)
      const withRomaji = { ...subject, romaji: romaji.romaji }
      const defaults = defaultCandidateIndices(groups, channelsRef.current, linked !== undefined)
      return {
        ...item,
        keyword: found.keyword,
        choices: groups.map((candidate, index) => {
          const channel = channelsRef.current.get(candidate.channelId)
          const rule = normalizeRule(
            createRule(withRomaji, found.keyword, candidate, channel, quarter),
          )
          return {
            candidate,
            channelLabel: channel
              ? `${channel.remoteControlKeyId ?? channel.channel ?? channel.id} ${channel.name}`
              : `ch:${candidate.channelId}`,
            rule,
            selected: defaults.includes(index),
            result: '',
            detail: '',
            defaultDirectory: rule.saveOption.directory ?? '',
          }
        }),
      }
    } catch (caught) {
      return {
        ...item,
        reason: `番組表の検索に失敗: ${errorMessage(caught)}`,
        lookupFailed: true,
      }
    }
  }

  const scan = async () => {
    const account = user.trim()
    if (busy || account === '') return
    setScanning(true)
    setRestored(false)
    setRestoredInfo('')
    setError('')
    setItems([])
    setStatus('既存ルールを確認しています…')
    try {
      const existing = await loadAllRules()
      linkedRulesRef.current = new Map(
        existing.flatMap((rule) =>
          typeof rule.bangumiId === 'number' ? [[rule.bangumiId, rule] as const] : [],
        ),
      )
      setStatus('Bangumi の作品を取得しています…')
      const subjects = filterQuarter(await fetchBangumiWatching(account), quarter)
      writeStoredUser(account)
      if (subjects.length === 0) {
        scanCache = null
        setStatus('対象期間の「見てる」作品はありません。')
        return
      }
      if (apiRepository.fetchSearchChannels === undefined) {
        throw new Error('放送局情報を取得できません')
      }
      const channelResult = await apiRepository.fetchSearchChannels(false)
      if (!channelResult.ok) throw new Error(channelResult.message)
      channelsRef.current = new Map(channelResult.value.map((channel) => [channel.id, channel]))
      const scanned: ImportItem[] = []
      setStatus(`0 / ${subjects.length} 作品を照合しました。`)
      await scanWithConcurrency(subjects, 3, scanSubject, (item) => {
        scanned.push(item)
        const snapshot = [...scanned]
        setItems(snapshot)
        persist(snapshot, account, quarter)
        setStatus(`${snapshot.length} / ${subjects.length} 作品を照合しました。`)
      })
      setUser(account)
      setStatus(`${scanned.length} 作品を確認しました。候補を選んでルールを作成できます。`)
    } catch (caught) {
      setError(`照合に失敗しました: ${errorMessage(caught)}`)
      setStatus('照合を完了できませんでした。')
    } finally {
      setScanning(false)
    }
  }

  const retry = async (subjectId: number) => {
    const target = items.find((item) => item.subject.id === subjectId)
    if (busy || target === undefined || !target.lookupFailed) return
    setRetrying((value) => value + 1)
    replaceItems((current) =>
      current.map((item) =>
        item.subject.id === subjectId
          ? { ...item, searching: true, reason: '番組表を再検索しています…' }
          : item,
      ),
    )
    const refreshed = await scanSubject(target.subject)
    replaceItems((current) =>
      current.map((item) =>
        item.subject.id === subjectId ? { ...refreshed, searching: false } : item,
      ),
    )
    if (!refreshed.lookupFailed) {
      requestAnimationFrame(() => subjectSummaryRefs.current.get(subjectId)?.focus())
    }
    setRetrying((value) => value - 1)
  }

  const updateChoice = (
    subjectId: number,
    choiceIndex: number,
    update: (choice: Choice) => Choice,
  ) => {
    replaceItems((current) =>
      current.map((item) =>
        item.subject.id === subjectId
          ? {
              ...item,
              choices: item.choices.map((choice, index) =>
                index === choiceIndex ? update(choice) : choice,
              ),
            }
          : item,
      ),
    )
  }

  const confirm = async () => {
    if (busy || selectedCount === 0 || invalidSelection) return
    setConfirmCount(selectedCount)
    setSaving(true)
    setError('')
    setStatus('選択したルールを作成しています…')
    try {
      const existing = await loadAllRules()
      let didCreate = false
      for (const item of items) {
        for (let choiceIndex = 0; choiceIndex < item.choices.length; choiceIndex += 1) {
          const choice = item.choices[choiceIndex]
          if (!choice.selected || (choice.result !== '' && choice.result !== 'failed')) continue
          if (hasDuplicateRule(existing, choice.rule)) {
            updateChoice(item.subject.id, choiceIndex, (current) => ({
              ...current,
              result: 'exists',
              detail: '同じキーワード・チャンネル・曜日・時刻のルールがあります',
            }))
            continue
          }
          updateChoice(item.subject.id, choiceIndex, (current) => ({
            ...current,
            result: 'creating',
            detail: '',
          }))
          let result: Awaited<ReturnType<SearchRuleApiRepository['addRule']>>
          try {
            result = await apiRepository.addRule(choice.rule)
          } catch (caught) {
            updateChoice(item.subject.id, choiceIndex, (current) => ({
              ...current,
              result: 'failed',
              detail: errorMessage(caught),
            }))
            continue
          }
          if (result.ok) {
            existing.push({
              id: result.value.ruleId,
              isTimeSpecification: choice.rule.isTimeSpecification,
              bangumiId: choice.rule.bangumiId ?? undefined,
              searchOption: choice.rule.searchOption,
              reserveOption: choice.rule.reserveOption,
            })
            updateChoice(item.subject.id, choiceIndex, (current) => ({
              ...current,
              result: 'created',
              detail: `ルール ID: ${result.value.ruleId}`,
            }))
            didCreate = true
            onCreated()
          } else {
            updateChoice(item.subject.id, choiceIndex, (current) => ({
              ...current,
              result: 'failed',
              detail: result.message,
            }))
          }
        }
      }
      if (didCreate) {
        try {
          await refreshLinkedRules()
        } catch {
          // The per-choice creation result remains authoritative if the linked count refresh fails.
        }
      }
      setStatus('作成結果を表示しています。失敗した項目は再度作成できます。')
    } catch (caught) {
      setError(`既存ルールの確認に失敗しました: ${errorMessage(caught)}`)
      setStatus('ルールを作成できませんでした。再試行してください。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={styles.bangumiImport} data-testid="bangumi-quarter-import">
      <h2>Bangumi 四半期作品からルールを作成</h2>
      <p>
        「見てる」に追加したアニメを、対象四半期の番組表と自動的に照合します。放送予定が見つかった作品は一覧に並ぶので、中身を確認・調整して録画ルールとしてまとめて登録できます。
      </p>
      <p className={styles.bangumiHelp}>
        照合しただけでは何も作成されません。「作成」ボタンで選択したルールだけを確定します。登録済みの作品は上書きしません。
      </p>
      <div className={styles.bangumiControls}>
        <TextField
          label="Bangumi アカウント"
          value={user}
          disabled={busy}
          onChange={(event) => {
            setUser(event.target.value)
            if (restored && scanCache?.user !== event.target.value) setRestored(false)
          }}
          size="small"
        />
        <TextField
          select
          label="対象四半期"
          value={quarter}
          disabled={busy}
          onChange={(event) => {
            setQuarter(event.target.value)
            setItems([])
            setRestored(false)
            setRestoredInfo('')
            setError('')
            setStatus('')
          }}
          size="small"
        >
          {quarters.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="contained"
          disabled={busy || user.trim() === ''}
          onClick={() => void scan()}
        >
          番組表を照合
        </Button>
      </div>
      <div className={styles.bangumiStatus} role="status" aria-live="polite">
        {status}
      </div>
      {restored ? (
        <div className={styles.bangumiInfo} role="note">
          前回の照合結果（{restoredInfo}）を復元しました。必要なら「番組表を照合」で取り直せます。
        </div>
      ) : null}
      {error ? (
        <div className={styles.bangumiError} role="alert">
          {error} アカウント名と通信状態を確認し、再度照合してください。
        </div>
      ) : null}
      {items.length === 0 ? null : (
        <>
          <div className={styles.bangumiSubjects}>
            {items.map((item) => (
              <details
                key={item.subject.id}
                className={styles.bangumiSubject}
                {...(item.lookupFailed ? { open: true } : {})}
              >
                <summary
                  ref={(node) => {
                    if (node === null) subjectSummaryRefs.current.delete(item.subject.id)
                    else subjectSummaryRefs.current.set(item.subject.id, node)
                  }}
                >
                  <span className={styles.bangumiCover}>
                    {item.subject.coverUrl ? (
                      <img
                        src={item.subject.coverUrl}
                        alt={`${item.subject.name} の表紙`}
                        onError={() =>
                          replaceItems((current) =>
                            current.map((currentItem) =>
                              currentItem.subject.id === item.subject.id
                                ? {
                                    ...currentItem,
                                    subject: { ...currentItem.subject, coverUrl: '' },
                                  }
                                : currentItem,
                            ),
                          )
                        }
                      />
                    ) : (
                      '表紙なし'
                    )}
                  </span>
                  <span className={styles.bangumiSubjectDetails}>
                    <strong>
                      {item.subject.name}
                      {item.subject.nameCn ? ` / ${item.subject.nameCn}` : ''}
                    </strong>
                    <span>
                      放送開始: {item.subject.date || '日付不明'}
                      {item.alreadyLinked ? ' · ルール登録済み' : ''}
                      {item.alreadyLinked
                        ? ` · 予約件数 ${item.linkedReserves ?? '?'}`
                        : item.choices.length > 0
                          ? ` · 候補 ${item.choices.length} 件`
                          : ''}
                      {item.reason ? ` — ${item.reason}` : ''}
                    </span>
                    {item.alreadyLinked && item.linkedReserves === 0 ? (
                      <span className={styles.bangumiWarning}>
                        登録済みのルールに現在一致する放送予定がありません。展開して候補を確認・再作成できます。
                      </span>
                    ) : null}
                  </span>
                </summary>
                <div className={styles.bangumiSubjectBody}>
                  {item.lookupFailed ? (
                    <Button
                      size="small"
                      disabled={busy}
                      onClick={() => void retry(item.subject.id)}
                    >
                      {item.searching ? '再検索中…' : 'この作品を再検索'}
                    </Button>
                  ) : null}
                  {item.choices.map((choice, choiceIndex) => {
                    const settled = choice.result === 'created' || choice.result === 'exists'
                    return (
                      <div
                        className={styles.bangumiChoice}
                        key={`${choice.candidate.channelId}-${choice.candidate.startSeconds}`}
                      >
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={choice.selected}
                              disabled={busy || settled}
                              onChange={(event) =>
                                updateChoice(item.subject.id, choiceIndex, (current) => ({
                                  ...current,
                                  selected: event.target.checked,
                                }))
                              }
                            />
                          }
                          label={`${choice.candidate.program.name ?? item.subject.name} · ${choice.channelLabel} · ${formatDate(choice.candidate.program.startAt)} · ${formatTime(choice.candidate.startSeconds)}–${formatTime(choice.candidate.startSeconds + 7_200)}`}
                        />
                        <span className={styles.bangumiChoiceDetail}>検索: {item.keyword}</span>
                        <div className={styles.bangumiDirectoryRow}>
                          <TextField
                            label="保存先"
                            value={choice.rule.saveOption.directory ?? ''}
                            disabled={busy || settled}
                            error={!isValidDirectory(choice.rule.saveOption.directory ?? undefined)}
                            helperText={
                              isValidDirectory(choice.rule.saveOption.directory ?? undefined)
                                ? ' '
                                : '空欄・絶対パス・親ディレクトリ参照は使えません'
                            }
                            onChange={(event) =>
                              updateChoice(item.subject.id, choiceIndex, (current) => ({
                                ...current,
                                rule: {
                                  ...current.rule,
                                  saveOption: {
                                    ...current.rule.saveOption,
                                    directory: event.target.value,
                                  },
                                },
                              }))
                            }
                            size="small"
                            fullWidth
                          />
                          <Button
                            size="small"
                            disabled={
                              busy ||
                              settled ||
                              choice.rule.saveOption.directory === choice.defaultDirectory
                            }
                            onClick={() =>
                              updateChoice(item.subject.id, choiceIndex, (current) => ({
                                ...current,
                                rule: {
                                  ...current.rule,
                                  saveOption: {
                                    ...current.rule.saveOption,
                                    directory: current.defaultDirectory,
                                  },
                                },
                              }))
                            }
                          >
                            リセット
                          </Button>
                        </div>
                        <span
                          className={
                            choice.result === 'failed'
                              ? styles.bangumiErrorText
                              : styles.bangumiChoiceDetail
                          }
                          role={choice.result === 'failed' ? 'alert' : undefined}
                        >
                          {resultLabel(choice)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </details>
            ))}
          </div>
          <div className={styles.bangumiConfirm}>
            <Button
              variant="contained"
              disabled={busy || selectedCount === 0 || invalidSelection}
              onClick={() => void confirm()}
            >
              選択した {saving ? confirmCount : selectedCount} 件のルールを作成
            </Button>
          </div>
          <div className={styles.bangumiValidation} role="status">
            {invalidSelection ? '選択した候補の保存先を確認してください。' : ''}
          </div>
        </>
      )}
    </section>
  )
}
