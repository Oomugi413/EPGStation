export interface BangumiSubject {
  id: number
  name: string
  nameCn: string
  date: string
  coverUrl?: string
  romaji?: string
}

export interface RomajiResult {
  romaji: string
  isRomajiFallback: boolean
}

export interface BangumiProgram {
  id: number
  name?: string
  channelId?: number
  startAt?: number
  genre1?: number
  subGenre1?: number
  genre2?: number
  subGenre2?: number
  genre3?: number
  subGenre3?: number
}

export interface BangumiChannel {
  id: number
  name: string
  channel?: string
  channelType?: string
  networkId?: number
  remoteControlKeyId?: number
}

export interface Candidate {
  channelId: number
  weekday: number
  startSeconds: number
  program: BangumiProgram
  programs: BangumiProgram[]
}

export interface BangumiRulePayload {
  isTimeSpecification: false
  bangumiId: number
  searchOption: {
    keyword: string
    keyCS: false
    keyRegExp: false
    name: true
    description: false
    extended: false
    channelIds: number[]
    times: Array<{ start: number; range: number; week: number }>
  }
  reserveOption: {
    enable: true
    allowEndLack: true
    removeDataBroadcast: true
    avoidDuplicate: true
  }
  saveOption: { directory: string }
}

export interface DuplicateRuleShape {
  isTimeSpecification: boolean
  searchOption: {
    keyword?: string
    channelIds?: number[]
    times?: Array<{ start?: number; range?: number; week: number }>
  }
}

export function nextQuarter(now?: Date): string
export function currentQuarter(now?: Date): string
export function defaultQuarter(now?: Date): string
export function quarterMonths(month: string): string[]
export function quarterLabel(month: string): string
export function fetchBangumiWatching(
  user: string,
  request?: typeof fetch,
): Promise<BangumiSubject[]>
export function resolveRomaji(
  subject: BangumiSubject,
  request?: typeof fetch,
): Promise<RomajiResult>
export function filterQuarter(subjects: BangumiSubject[], month: string): BangumiSubject[]
export function keywordVariants(title: string): string[]
export function scanWithConcurrency<T, R>(
  subjects: T[],
  limit: number,
  scan: (subject: T) => Promise<R>,
  publish: (result: R) => void,
): Promise<void>
export function searchTitle(
  title: string,
  search: (keyword: string) => Promise<BangumiProgram[]>,
): Promise<{ keyword: string; programs: BangumiProgram[] }>
export function candidateGroups(programs: BangumiProgram[]): Candidate[]
export function isTokyoMxChannel(channel?: BangumiChannel): boolean
export function hasSubtitles(program: BangumiProgram): boolean
export function defaultCandidateIndices(
  groups: Candidate[],
  channels: Map<number, BangumiChannel>,
  alreadyLinked?: boolean,
): number[]
export function directorySlug(subject: BangumiSubject): string
export function isValidDirectory(value: string | undefined): boolean
export function createRule(
  subject: BangumiSubject,
  keyword: string,
  candidate: Candidate,
  channel: BangumiChannel | undefined,
  month: string,
  rangeSeconds?: number,
): BangumiRulePayload
export function hasDuplicateRule(
  existingRules: DuplicateRuleShape[],
  rule: DuplicateRuleShape,
): boolean
