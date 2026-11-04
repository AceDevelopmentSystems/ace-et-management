import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/** Soft delete: DELETE the item, then refresh the lists that showed it and the trash. */
export function useRemove(keys: unknown[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.del<unknown>(path),
    onSuccess: () => {
      for (const queryKey of keys) qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['trash'] });
    },
  });
}

/** PATCH one item and refresh the lists that show it. `onDone` closes the edit form. */
export function usePatch(keys: unknown[][], onDone: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) => api.patch<unknown>(path, body),
    onSuccess: () => {
      for (const queryKey of keys) qc.invalidateQueries({ queryKey });
      onDone();
    },
  });
}
