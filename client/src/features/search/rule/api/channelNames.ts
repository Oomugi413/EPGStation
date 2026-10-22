import type { ReserveListItem as ReserveListItemModel } from '@/features/reserves/reservesApi'
import type { SearchRuleDetail } from '../query'
import { isNonNegativeSafeInteger, isRecord, isSafeInteger } from './guards'
import type { RuleListResponse, SearchChannelOption, SearchProgram } from './types'

function adaptChannelName(
  value: Record<string, unknown>,
  isHalfWidth: boolean,
): string | undefined {
  return isHalfWidth && typeof value.halfWidthName === 'string'
    ? value.halfWidthName
    : typeof value.name === 'string'
      ? value.name
      : typeof value.halfWidthName === 'string'
        ? value.halfWidthName
        : undefined
}

export function adaptSearchChannelOptions(
  value: unknown,
  isHalfWidth: boolean,
): SearchChannelOption[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((channel): SearchChannelOption[] => {
    if (!isRecord(channel) || !isNonNegativeSafeInteger(channel.id)) {
      return []
    }

    const name = adaptChannelName(channel, isHalfWidth)
    if (name === undefined) {
      return []
    }

    const option: SearchChannelOption = { id: channel.id, name }
    if (typeof channel.channel === 'string') option.channel = channel.channel
    if (typeof channel.channelType === 'string') option.channelType = channel.channelType
    if (isNonNegativeSafeInteger(channel.networkId)) option.networkId = channel.networkId
    if (isNonNegativeSafeInteger(channel.remoteControlKeyId)) {
      option.remoteControlKeyId = channel.remoteControlKeyId
    }

    return [option]
  })
}

export function adaptChannelIndex(value: unknown, isHalfWidth: boolean): Map<number, string> {
  return new Map(
    adaptSearchChannelOptions(value, isHalfWidth).map((channel) => [channel.id, channel.name]),
  )
}

export function hydrateRuleChannelNames(
  response: RuleListResponse,
  channelIndex: ReadonlyMap<number, string>,
): RuleListResponse {
  return {
    ...response,
    rules: response.rules.map((rule) => {
      const channelIds = rule.searchOption.channelIds ?? []
      if (channelIds.length === 0) {
        return rule
      }

      return {
        ...rule,
        searchOption: {
          ...rule.searchOption,
          channelNames: channelIds.map(
            (channelId) => channelIndex.get(channelId) ?? String(channelId),
          ),
        },
      }
    }),
  }
}

export function hydrateRuleDetailChannelNames(
  rule: SearchRuleDetail,
  channelIndex: ReadonlyMap<number, string>,
): SearchRuleDetail {
  const channelIds = rule.searchOption.channelIds ?? []

  if (channelIds.length === 0) {
    return rule
  }

  return {
    ...rule,
    searchOption: {
      ...rule.searchOption,
      channelNames: channelIds.map((channelId) => channelIndex.get(channelId) ?? String(channelId)),
    },
  }
}

export function hydrateSearchProgramChannelNames(
  programs: readonly SearchProgram[],
  channelIndex: ReadonlyMap<number, string>,
): SearchProgram[] {
  return programs.map((program) => {
    if (program.channelName !== undefined || program.channelId === undefined) {
      return program
    }

    const channelName = channelIndex.get(program.channelId)

    return channelName === undefined ? program : { ...program, channelName }
  })
}

export function hydrateRuleReserveChannelNames(
  reserves: readonly ReserveListItemModel[],
  channelIndex: ReadonlyMap<number, string>,
): ReserveListItemModel[] {
  return reserves.map((reserve) => {
    if (reserve.channelName !== undefined || reserve.channelId === undefined) {
      return reserve
    }

    const channelName = channelIndex.get(reserve.channelId)

    return channelName === undefined ? reserve : { ...reserve, channelName }
  })
}

function adaptRuleReserveItem(value: unknown): ReserveListItemModel | null {
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.id)) {
    return null
  }

  const item: ReserveListItemModel = { id: value.id }

  if (isNonNegativeSafeInteger(value.programId)) item.programId = value.programId
  if (typeof value.name === 'string') item.name = value.name
  if (isNonNegativeSafeInteger(value.channelId)) item.channelId = value.channelId
  if (typeof value.channelName === 'string') item.channelName = value.channelName
  if (isSafeInteger(value.startAt)) item.startAt = value.startAt
  if (isSafeInteger(value.endAt)) item.endAt = value.endAt
  if (typeof value.description === 'string') item.description = value.description
  if (isNonNegativeSafeInteger(value.ruleId)) item.ruleId = value.ruleId
  if (typeof value.isConflict === 'boolean') item.isConflict = value.isConflict
  if (typeof value.isSkip === 'boolean') item.isSkip = value.isSkip
  if (typeof value.isOverlap === 'boolean') item.isOverlap = value.isOverlap
  if (typeof value.isTimeSpecified === 'boolean') item.isTimeSpecified = value.isTimeSpecified

  return item
}

export function adaptRuleReserveList(value: unknown): ReserveListItemModel[] | null {
  const source = isRecord(value) && Array.isArray(value.reserves) ? value.reserves : value

  if (!Array.isArray(source)) {
    return null
  }

  const items = source.map(adaptRuleReserveItem)

  return items.every((item): item is ReserveListItemModel => item !== null) ? items : null
}
