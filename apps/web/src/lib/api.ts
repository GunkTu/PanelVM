export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = '';
let onUnauthorized: (() => void) | null = null;

export const setCsrfToken = (t: string): void => {
  csrfToken = t;
};
export const setUnauthorizedHandler = (fn: () => void): void => {
  onUnauthorized = fn;
};

/** Panggilan API same-origin. Pesan error dari server sudah berbahasa Indonesia dan aman ditampilkan. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      'network',
      'Tidak bisa menghubungi server. Periksa koneksi internet Anda lalu coba lagi.',
    );
  }
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
    throw new ApiError(
      res.status,
      data?.error ?? 'unknown',
      data?.message ?? 'Permintaan gagal. Muat ulang halaman lalu coba lagi.',
    );
  }
  return data as T;
}
