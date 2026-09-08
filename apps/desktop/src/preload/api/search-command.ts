import { ipcRenderer } from 'electron'
import type { AsyncIPCFunctions } from '../common/types/ipc'
import type { SearchCommandResult } from '../common/types/search'
import { parseSearchResult } from '../common/search/snapshot'

type SearchChannel = 'controlCharacterSearch' | 'notifyStableNicknameDetected'
export async function invokeSearchCommand<Channel extends SearchChannel>(
  channel: Channel,
  ...args: Parameters<AsyncIPCFunctions[Channel]>
): Promise<SearchCommandResult> {
  const value: unknown = await ipcRenderer.invoke(channel, ...args)
  const result = parseSearchResult(value)
  const isValid = result != null
  if (!isValid) {
    throw new Error('검색 연결의 응답을 확인하지 못했습니다.')
  }
  return result
}
