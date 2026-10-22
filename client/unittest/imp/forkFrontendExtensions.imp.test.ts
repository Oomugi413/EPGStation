import { describe, expect, it } from 'vitest'
import { BROADCAST_WAVE_ORDER } from '@/app/navigation'
import { buildGuideRequestUrls, createNormalScheduleRequest } from '@/features/guide/guideRequests'
import {
  buildManualReserveAddPayload,
  buildManualReserveEditPayload,
} from '@/features/reserves/lib/manualReservePayload'
import { adaptReserveItem } from '@/features/reserves/lib/reserveAdapters'
import { adaptRuleListResponse, adaptSearchRuleDetail } from '@/features/search/rule/api/adaptRules'
import { createRuleOptionDraft } from '@/features/search/rule/lib/ruleOptionDraft'
import { buildSearchRulePayload } from '@/features/search/rule/lib/rulePayload'
import { DefaultSettingsFactory } from '@/shared/settings/defaultSettings'
import {
  createRule,
  hasDuplicateRule,
  type BangumiSubject,
  type Candidate,
} from '@/lib/bangumiImport.mjs'

const settings = new DefaultSettingsFactory().create()
const searchBody = {
  option: { keyword: 'fork regression', times: [] },
  isHalfWidth: false,
  limit: 100,
}

describe('fork broadcast-wave contract', () => {
  it('keeps GR-ALT and every NW1..NW40 key in stable request order', () => {
    expect(BROADCAST_WAVE_ORDER).toHaveLength(46)
    expect(BROADCAST_WAVE_ORDER.slice(0, 6)).toStrictEqual([
      'GR',
      'GR-ALT',
      'BS',
      'BS4K',
      'CS',
      'SKY',
    ])
    expect(BROADCAST_WAVE_ORDER[6]).toBe('NW1')
    expect(BROADCAST_WAVE_ORDER[45]).toBe('NW40')

    const schedule = createNormalScheduleRequest({
      settings,
      type: 'NW40',
      startAt: 100,
      enabledBroadcastWaves: ['GR-ALT', 'NW1', 'NW40'],
    })
    const urls = buildGuideRequestUrls({
      requestSet: {
        guideQuery: { mode: 'normal', startAt: 100, isTimeQueryValid: true, type: 'NW40' },
        schedule,
        reserveIndex: { startAt: 100, endAt: 200 },
      },
    })
    const query = new URL(urls.schedule, 'https://example.test').searchParams

    expect(schedule.NW40).toBe(true)
    expect(schedule.GR).toBe(false)
    expect(query.get('GR-ALT')).toBe('false')
    expect(query.get('NW1')).toBe('false')
    expect(query.get('NW40')).toBe('true')
  })
})

describe('fork rule metadata contract', () => {
  it('loads a numeric Bangumi id and sends an explicit null after the user clears it', () => {
    const detail = adaptSearchRuleDetail({
      id: 8,
      bangumiId: 1234,
      isTimeSpecification: false,
      searchOption: { keyword: 'anime', times: [] },
      reserveOption: {
        enable: true,
        allowEndLack: true,
        removeDataBroadcast: true,
        avoidDuplicate: true,
        periodToAvoidDuplicate: null,
      },
      saveOption: {},
    })
    expect(detail?.bangumiId).toBe(1234)
    if (detail === null) throw new Error('fixture must adapt')

    const draft = createRuleOptionDraft({
      existingRule: detail,
      searchBody,
      settings,
      encodeModes: [],
    })
    expect(draft.bangumiId).toBe(1234)
    expect(
      buildSearchRulePayload({
        searchBody,
        settings,
        encodeModes: [],
        existingRule: detail,
        optionDraft: { ...draft, bangumiId: null },
      }).bangumiId,
    ).toBeNull()
  })

  it('defaults historical nullable fields safely and retains list metadata used for linking', () => {
    const response = adaptRuleListResponse({
      rules: [
        {
          id: 10,
          bangumiId: null,
          searchOption: { times: [] },
          reserveOption: { enable: true, allowEndLack: true },
        },
        {
          id: 11,
          bangumiId: 4321,
          isTimeSpecification: true,
          searchOption: { times: [] },
          reserveOption: { enable: true, allowEndLack: true, removeDataBroadcast: true },
          reservesCnt: 2,
        },
      ],
      total: 2,
    })

    expect(response?.rules[0]).toMatchObject({
      isTimeSpecification: false,
      reserveOption: { removeDataBroadcast: false },
    })
    expect(response?.rules[0]?.bangumiId).toBeUndefined()
    expect(response?.rules[1]).toMatchObject({
      bangumiId: 4321,
      isTimeSpecification: true,
      reservesCnt: 2,
      reserveOption: { removeDataBroadcast: true },
    })
  })
})

describe('fork reserve option contract', () => {
  it('carries removeDataBroadcast through manual add, edit, and historical reserve reads', () => {
    const add = buildManualReserveAddPayload({
      mode: { kind: 'program', programId: 90 },
      isTimeSpecification: false,
      timeSpecifiedOption: { name: null, channelId: null, startAt: null, endAt: null },
      reserveOption: { allowEndLack: true, removeDataBroadcast: true },
      saveOption: undefined,
      encodeOption: undefined,
    })
    expect(add).toStrictEqual({
      ok: true,
      value: { programId: 90, allowEndLack: true, removeDataBroadcast: true },
    })
    expect(
      buildManualReserveEditPayload({
        reserveOption: { allowEndLack: false, removeDataBroadcast: true },
        saveOption: undefined,
        encodeOption: undefined,
      }),
    ).toStrictEqual({ allowEndLack: false, removeDataBroadcast: true })
    expect(adaptReserveItem({ id: 1 })?.removeDataBroadcast).toBeUndefined()
    expect(adaptReserveItem({ id: 2, removeDataBroadcast: true })?.removeDataBroadcast).toBe(true)
  })
})

describe('Bangumi-generated rule contract', () => {
  it('links the subject, removes data broadcasts, and remains duplicate-safe', () => {
    const subject: BangumiSubject = {
      id: 500,
      name: 'Example Anime',
      nameCn: '',
      date: '2026-10-01',
      romaji: 'example-anime',
    }
    const candidate: Candidate = {
      channelId: 7,
      weekday: 4,
      startSeconds: 23 * 3600,
      program: { id: 1, channelId: 7, startAt: 1, name: 'Example Anime #1' },
      programs: [],
    }
    const rule = createRule(
      subject,
      'Example Anime',
      candidate,
      { id: 7, name: 'Example', channelType: 'GR-ALT', remoteControlKeyId: 9 },
      '2026-10',
    )

    expect(rule).toMatchObject({
      bangumiId: 500,
      reserveOption: { removeDataBroadcast: true },
      saveOption: { directory: '2026-10/9-example-anime' },
    })
    expect(
      hasDuplicateRule(
        [
          {
            isTimeSpecification: false,
            searchOption: rule.searchOption,
          },
        ],
        rule,
      ),
    ).toBe(true)
  })
})

describe('fork settings default', () => {
  it('keeps the fork rule page size at 100', () => {
    expect(settings.rulesLength).toBe(100)
  })
})
