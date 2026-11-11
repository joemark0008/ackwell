import type { Channel, CreateChannelInput, MessageListQuery, UpdateChannel } from '@ackwell/schemas';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type MessageFilters = Pick<MessageListQuery, 'status' | 'q'>;

export const keys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  channels: ['channels'] as const,
  channel: (id: string) => ['channels', id] as const,
  messages: (channelId: string, filters: MessageFilters = {}) => ['channels', channelId, 'messages', filters] as const,
  message: (id: string) => ['messages', id] as const,
};

/** Poll interval for the message log while a channel is running (until SSE lands). */
export const LIVE_POLL_MS = 4000;

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health, refetchInterval: 15_000 });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: Infinity });
export const useChannels = () => useQuery({ queryKey: keys.channels, queryFn: api.channels.list });
export const useChannel = (id: string) => useQuery({ queryKey: keys.channel(id), queryFn: () => api.channels.get(id) });

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChannelInput) => api.channels.create(input),
    onSuccess: (ch) => {
      qc.setQueryData(keys.channel(ch.id), ch);
      void qc.invalidateQueries({ queryKey: keys.channels });
    },
  });
}

export function useUpdateChannel(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateChannel) => api.channels.update(id, patch),
    onSuccess: (ch) => {
      qc.setQueryData(keys.channel(id), ch);
      void qc.invalidateQueries({ queryKey: keys.channels });
    },
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.channels.remove(id),
    onSuccess: (_v, id) => {
      qc.removeQueries({ queryKey: keys.channel(id) });
      void qc.invalidateQueries({ queryKey: keys.channels });
    },
  });
}

function useChannelStatusMutation(id: string, fn: (id: string) => Promise<Channel>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fn(id),
    onSuccess: (ch) => {
      qc.setQueryData(keys.channel(id), ch);
      void qc.invalidateQueries({ queryKey: keys.channels });
    },
    onError: () => {
      // A failed start can leave the channel in `error`; refresh so the badge is right.
      void qc.invalidateQueries({ queryKey: keys.channel(id) });
      void qc.invalidateQueries({ queryKey: keys.channels });
    },
  });
}

export const useStartChannel = (id: string) => useChannelStatusMutation(id, api.channels.start);
export const useStopChannel = (id: string) => useChannelStatusMutation(id, api.channels.stop);

/** Message log of a channel, newest first, cursor-paged; polls while `live` is true. */
export function useMessages(channelId: string, filters: MessageFilters, live: boolean) {
  return useInfiniteQuery({
    queryKey: keys.messages(channelId, filters),
    queryFn: ({ pageParam }) => api.channels.messages(channelId, { ...filters, limit: 50, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? LIVE_POLL_MS : false,
  });
}

export const useMessage = (id: string | null) =>
  useQuery({ queryKey: keys.message(id ?? ''), queryFn: () => api.messages.get(id!), enabled: id !== null });
