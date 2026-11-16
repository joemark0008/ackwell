import type { Channel, CreateChannelInput, GlobalMessageListQuery, MessageList, MessageListQuery, SendRequestInput, UpdateChannel } from '@ackwell/schemas';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { overlayLiveRows, useLiveStatus } from './live-state';

export type MessageFilters = Pick<MessageListQuery, 'status' | 'q'>;
/** Filters of the global log (GET /api/messages); channel logs use the subset without channelId/direction. */
export type LogFilters = Pick<GlobalMessageListQuery, 'status' | 'q' | 'channelId' | 'direction'>;

/** A fetched page may be older than what the live stream already showed; keep the newer rows. */
const withLiveRows = (l: MessageList): MessageList => ({ ...l, items: overlayLiveRows(l.items) });

export const keys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  channels: ['channels'] as const,
  channel: (id: string) => ['channels', id] as const,
  messages: (channelId: string, filters: MessageFilters = {}) => ['channels', channelId, 'messages', filters] as const,
  allMessages: (filters: LogFilters = {}) => ['messages', 'all', filters] as const,
  message: (id: string) => ['messages', id] as const,
  webhookSecrets: (channelId: string) => ['channels', channelId, 'webhook-secrets'] as const,
  apiKeys: (channelId: string) => ['channels', channelId, 'api-keys'] as const,
};

/** Fallback poll interval for the message log while the live stream is NOT connected. */
export const LIVE_POLL_MS = 4000;

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health, refetchInterval: 15_000 });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings, staleTime: 60_000 });
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

/** Message log of a channel, newest first, cursor-paged. SSE keeps it fresh; polls only as a fallback while the stream is down. */
export function useMessages(channelId: string, filters: MessageFilters, live: boolean) {
  const stream = useLiveStatus();
  return useInfiniteQuery({
    queryKey: keys.messages(channelId, filters),
    queryFn: ({ pageParam }) => api.channels.messages(channelId, { ...filters, limit: 50, cursor: pageParam }).then(withLiveRows),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live && stream !== 'live' ? LIVE_POLL_MS : false,
  });
}

/** Cross-channel message log. */
export function useAllMessages(filters: LogFilters) {
  const stream = useLiveStatus();
  return useInfiniteQuery({
    queryKey: keys.allMessages(filters),
    queryFn: ({ pageParam }) => api.messages.list({ ...filters, limit: 50, cursor: pageParam }).then(withLiveRows),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: stream !== 'live' ? LIVE_POLL_MS : false,
  });
}

export const useMessage = (id: string | null) =>
  useQuery({ queryKey: keys.message(id ?? ''), queryFn: () => api.messages.get(id!), enabled: id !== null });

export const useWebhookSecrets = (channelId: string) =>
  useQuery({ queryKey: keys.webhookSecrets(channelId), queryFn: () => api.webhookSecrets.list(channelId) });

export function useRotateWebhookSecret(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.webhookSecrets.rotate(channelId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSecrets(channelId) }),
  });
}

export function useRevokeWebhookSecret(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.webhookSecrets.revoke(channelId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.webhookSecrets(channelId) }),
  });
}

export function useResendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.messages.resend(id),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: keys.message(m.id) });
      void qc.invalidateQueries({ queryKey: ['channels', m.channelId, 'messages'] });
      void qc.invalidateQueries({ queryKey: ['messages', 'all'] });
    },
  });
}

export const useApiKeys = (channelId: string) =>
  useQuery({ queryKey: keys.apiKeys(channelId), queryFn: () => api.apiKeys.list(channelId) });

export function useCreateApiKey(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => api.apiKeys.create(channelId, label),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.apiKeys(channelId) }),
  });
}

export function useRevokeApiKey(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.apiKeys.revoke(channelId, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.apiKeys(channelId) }),
  });
}

export function useSendMessage(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SendRequestInput) => api.channels.send(channelId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['channels', channelId, 'messages'] }),
  });
}

/** Inbound file channel: files in its error folder (refreshes while the page is open). */
export function useFileErrors(channelId: string, enabled = true) {
  return useQuery({
    queryKey: ['channels', channelId, 'file-errors'],
    queryFn: () => api.channels.fileErrors(channelId),
    enabled,
    refetchInterval: 10_000,
  });
}

export function useRetryFileError(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.channels.retryFileError(channelId, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['channels', channelId, 'file-errors'] });
      void qc.invalidateQueries({ queryKey: ['channels', channelId, 'messages'] });
    },
  });
}
