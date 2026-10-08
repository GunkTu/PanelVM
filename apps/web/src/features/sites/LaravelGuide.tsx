import { BookOpen, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';

const ENV_EXAMPLE = `APP_ENV=production
APP_DEBUG=false
APP_URL=https://domain-anda.com

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=nama_database
DB_USERNAME=nama_user
DB_PASSWORD=password_dari_menu_database`;

/** Panduan ringkas deploy Laravel dari nol sampai tampil, mengikuti urutan fitur di panel. */
export function LaravelGuide({ vmId }: { vmId: string }) {
  const to = (page: string) => `/vms/${vmId}/${page}`;
  const link = 'font-medium text-info underline';
  return (
    <details className="group mt-4 card p-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-4 font-semibold text-navy">
        <BookOpen aria-hidden="true" className="h-5 w-5 text-slate-500" />
        Panduan deploy Laravel, langkah demi langkah
        <ChevronDown
          aria-hidden="true"
          className="ml-auto h-4 w-4 text-slate-400 transition-transform group-open:rotate-180"
        />
      </summary>
      <ol className="list-decimal space-y-3 border-t border-slate-200 p-4 pl-9 text-sm text-slate-700">
        <li>
          <strong>Pasang software</strong> di menu{' '}
          <Link className={link} to={to('software')}>
            Aplikasi
          </Link>
          : Alat dasar, <em>satu</em> web server (Nginx <em>atau</em> Apache; keduanya tidak bisa
          dipasang bersamaan), PHP versi yang cocok dengan <code>composer.json</code> proyekmu,
          Composer, dan database (MariaDB, MySQL, atau PostgreSQL).
        </li>
        <li>
          <strong>Buat database dan user</strong> di menu{' '}
          <Link className={link} to={to('databases')}>
            Database
          </Link>
          . Catat nama database, user, dan password. Password hanya tampil sekali.
        </li>
        <li>
          Klik <strong>Tambah situs</strong> di halaman ini: pilih jenis <em>Laravel</em>, isi
          domain, dan pilih versi PHP.
        </li>
        <li>
          Klik <strong>Deploy kode</strong>: unggah <code>.zip</code> (tanpa folder{' '}
          <code>vendor</code> dan <code>node_modules</code>), atau pakai tab{' '}
          <em>Dari URL / Google Drive</em> untuk file besar, atau tab <em>Dari Git</em>. Composer
          akan memasang dependensi otomatis.
        </li>
        <li>
          <strong>Isi file .env</strong> lewat tombol <em>Edit .env</em> di kartu situs. Bagian yang
          harus kamu sesuaikan:
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
            {ENV_EXAMPLE}
          </pre>
          <p className="mt-2">
            Kalau kamu mencentang <em>Jalankan migrasi</em> saat deploy tetapi <code>.env</code>{' '}
            belum benar, proses <strong>berhenti dan menunggu</strong> (tidak gagal). Perbaiki{' '}
            <code>.env</code>, lalu klik <strong>Lanjutkan</strong> di log proses.
          </p>
        </li>
        <li>
          Jalankan perintah lewat tombol <strong>Artisan</strong>: <code>migrate</code> (bila belum
          dijalankan saat deploy), <code>db:seed</code> bila perlu, lalu <code>optimize</code>.{' '}
          <code>storage:link</code> sudah dijalankan otomatis.
        </li>
        <li>
          Cek tombol <strong>Folder dokumen</strong>: Laravel memakai folder <code>public</code>.
          Kalau arsipmu berstruktur lain, panel mencari folder yang berisi <code>index.php</code>{' '}
          dan memilihnya otomatis; kamu bisa mengubahnya dari daftar.
        </li>
        <li>
          <strong>Lihat hasilnya</strong>: arahkan domain ke IP VM port 80, atau buka menu{' '}
          <Link className={link} to={to('previews')}>
            Preview Web
          </Link>{' '}
          (port <code>80</code>, isi <em>Host situs</em> dengan domain situsmu). Selama memakai
          preview, set <code>APP_URL</code> ke alamat preview agar link dan aset tampil benar.
        </li>
      </ol>
    </details>
  );
}
