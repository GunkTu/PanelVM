import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components';
import { api } from '../../lib/api';
import type { Job } from '../../lib/types';

export interface Task {
  id: string;
  kind: 'cron' | 'worker' | 'app';
  name: string;
  domain: string | null;
  runtime: 'node' | 'python' | 'other' | null;
  workdir: string;
  command: string;
  installCommand: string | null;
  schedule: string | null;
  port: number | null;
  gitUrl: string | null;
  siteId: string | null;
  state: string;
  createdAt: number;
}

export interface TaskOptions {
  sites: {
    id: string;
    domain: string;
    kind: string;
    phpVersion: string | null;
    rootPath: string;
  }[];
  nextPort: number | null;
}

export const stateTone = (s: string) =>
  s === 'active' ? 'success' : s === 'scheduled' ? 'info' : s === 'failed' ? 'error' : 'warning';
export const stateLabel = (s: string) =>
  ({
    active: 'Berjalan',
    inactive: 'Berhenti',
    failed: 'Gagal',
    activating: 'Memulai',
    scheduled: 'Terjadwal',
    unknown: 'Tidak diketahui',
  })[s] ?? s;

export function useTasks(vmId: string) {
  return useQuery({
    queryKey: ['tasks', vmId],
    refetchInterval: 10_000,
    queryFn: () => api<{ items: Task[] }>(`/api/vms/${vmId}/tasks`),
  });
}

export function useTaskOptions(vmId: string) {
  return useQuery({
    queryKey: ['task-options', vmId],
    queryFn: () => api<TaskOptions>(`/api/vms/${vmId}/tasks/options`),
  });
}

/** Aksi umum (start/stop/restart, hapus) dengan toast dan penyegaran daftar. */
export function useTaskActions(vmId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['tasks', vmId] });
  const act = useMutation({
    mutationFn: (v: { task: Task; action: 'start' | 'stop' | 'restart' }) =>
      api(`/api/vms/${vmId}/tasks/${v.task.id}/action`, {
        method: 'POST',
        body: { action: v.action },
      }),
    onSuccess: async (_r, v) => {
      toast.show('success', `${v.task.name}: perintah ${v.action} berhasil.`);
      await refresh();
    },
    onError: (e: Error) => toast.show('error', e.message),
  });
  const del = useMutation({
    mutationFn: (v: { task: Task; deleteFiles: boolean }) =>
      api(`/api/vms/${vmId}/tasks/${v.task.id}/delete`, {
        method: 'POST',
        body: { confirm: v.task.name, deleteFiles: v.deleteFiles },
      }),
    onSuccess: async (_r, v) => {
      toast.show('success', `${v.task.name} dihapus.`);
      await refresh();
    },
    onError: (e: Error) => toast.show('error', e.message),
  });
  const redeploy = useMutation({
    mutationFn: (task: Task) =>
      api<Job>(`/api/vms/${vmId}/tasks/${task.id}/redeploy`, { method: 'POST', body: {} }),
    onError: (e: Error) => toast.show('error', e.message),
  });
  return { act, del, redeploy, refresh };
}
