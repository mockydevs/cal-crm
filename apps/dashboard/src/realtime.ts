import { publicId } from '@repo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import * as z from 'zod';

const changed = z.strictObject({ businessId: publicId('business') });

/** Each mounted business owns its connection. Forms keep their own unsaved drafts. */
export function useRealtime(businessId: string): void {
  const cache = useQueryClient();
  useEffect(() => {
    const socket = io({ transports: ['websocket'], auth: { businessId } });
    let disposed = false;
    let refreshing = false;
    let generation = 0;
    const filters = {
      predicate: ({ queryKey }: { queryKey: readonly unknown[] }) =>
        queryKey.includes(businessId) || queryKey[0] === 'me',
    };
    const refresh = async () => {
      generation++;
      if (refreshing) return;
      refreshing = true;
      try {
        let readGeneration: number;
        let joinedFetch: boolean;
        do {
          readGeneration = generation;
          joinedFetch = cache.isFetching({ ...filters, type: 'active' }) > 0;
          // Cancellation rejects router workspace reads and discards appended pages.
          // Finish existing reads, then refetch for changes that arrived during them.
          await cache.invalidateQueries(filters, { cancelRefetch: false });
        } while (!disposed && (joinedFetch || readGeneration !== generation));
      } finally {
        refreshing = false;
      }
    };
    socket.on('connect', () => {
      void refresh();
    }); // Catches changes missed while disconnected.
    socket.on('business.changed', (payload: unknown) => {
      const result = changed.safeParse(payload);
      if (result.success && result.data.businessId === businessId) void refresh();
    });
    return () => {
      disposed = true;
      socket.disconnect();
    };
  }, [businessId, cache]);
}
