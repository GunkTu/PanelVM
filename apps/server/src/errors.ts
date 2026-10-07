/** Error yang pesannya aman ditampilkan ke pengguna (Bahasa Indonesia: apa yang terjadi + langkah berikutnya). */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Data') =>
  new AppError(
    404,
    'not_found',
    `${what} tidak ditemukan. Muat ulang halaman dan pilih ulang dari daftar.`,
  );

export const forbidden = (
  message = 'Anda tidak punya izin untuk aksi ini. Hubungi admin bila perlu.',
) => new AppError(403, 'forbidden', message);

export const unauthorized = (
  message = 'Sesi Anda berakhir atau belum masuk. Silakan masuk kembali.',
) => new AppError(401, 'unauthorized', message);
