import { ApiError, getCsrfToken } from './api';

/** Unggah file sebagai body mentah (stream di server) dengan progress. */
export function uploadRaw<T = unknown>(
  method: 'PUT' | 'POST',
  url: string,
  file: Blob,
  onProgress: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', getCsrfToken());
    xhr.upload.onprogress = (e) =>
      e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () =>
      reject(
        new ApiError(0, 'network', 'Unggah terputus. Periksa koneksi internet lalu coba lagi.'),
      );
    xhr.onload = () => {
      const parse = (): { error?: string; message?: string } | null => {
        try {
          return JSON.parse(xhr.responseText) as { error?: string; message?: string };
        } catch {
          return null;
        }
      };
      const data = parse();
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      reject(
        new ApiError(
          xhr.status,
          data?.error ?? 'unknown',
          data?.message ?? 'Unggah gagal. Coba lagi.',
        ),
      );
    };
    xhr.send(file);
  });
}
