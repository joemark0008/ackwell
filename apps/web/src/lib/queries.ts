import type { CreateChannelInput, UpdateChannel } from '@ackwell/schemas';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export const keys = {
  health: ['health'] as const,
  settings: ['settings'] as const,
  channels: ['channels'] as const,
  channel: (id: string) => ['channels', id] as const,
};

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
