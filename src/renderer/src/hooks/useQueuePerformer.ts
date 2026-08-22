import { useCallback } from 'react'
import type { QueueListItemMetadata } from '@shared/smoip'
import { useIndexPools } from '@/hooks/useIndexPools'
import { performerFor, trackIndexFor } from '@/lib/queuePerformer'

/**
 * `performerOf(md)` for queue rows — the performer the library knows for a
 * compilation entry the streamer stored under its album artist, or null when
 * the device's string stands (see lib/queuePerformer). Cheap per row: the
 * title index is built once per pools snapshot.
 */
export function useQueuePerformer(): (md: QueueListItemMetadata | null | undefined) => string | null {
  const pools = useIndexPools()
  return useCallback((md) => performerFor(md, trackIndexFor(pools)), [pools])
}
