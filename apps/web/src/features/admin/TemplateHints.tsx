import { Copy } from 'lucide-react';
import { Button, useToast } from '../../components';

export interface TemplateHint {
  node: string;
  osId: string;
  label: string;
  fromNode: string;
  newVmid: number;
  name: string;
  commands: string[];
  /** Alasan template tidak bisa disalin otomatis. */
  blocked?: string;
}

/**
 * Node yang belum punya template sebuah OS: perintah siap-salin untuk membuatnya dari template bersama.
 * Dijalankan admin di Shell Proxmox; panel tidak menjalankannya.
 */
export function TemplateHints({ hints }: { hints: TemplateHint[] }) {
  const toast = useToast();
  if (hints.length === 0) return null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show('success', 'Perintah disalin.');
    } catch {
      toast.show('warning', 'Browser menolak menyalin otomatis. Blok teksnya lalu salin manual.');
    }
  };
  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">
      <p className="font-medium">Buat template di node yang belum punya</p>
      <p className="mt-1">
        VM baru hanya bisa dibuat dari template yang ada di <strong>node yang sama</strong>: Proxmox
        hanya mengizinkan clone lintas node ke storage bersama, sedangkan VM sebaiknya berjalan di
        storage lokal (local-lvm). Template yang sudah ada bisa disalin ke node lain lewat storage
        bersama. Jalankan di <strong>Shell node asalnya</strong>, satu perintah per kali dari atas
        ke bawah (langkah <code>qm set ... --delete</code> hanya muncul sekali per OS), lalu muat
        ulang pilihan (di wizard) atau klik Tes lagi.
      </p>
      <ul className="mt-2 space-y-3">
        {hints.map((h) => (
          <li key={`${h.node}-${h.osId}`}>
            <p>
              <strong>{h.label}</strong> belum ada di <strong>{h.node}</strong>. Jalankan di Shell
              node <strong>{h.fromNode}</strong>:
            </p>
            {h.blocked ? (
              <p className="mt-1 rounded-lg bg-amber-100 p-2 text-amber-950">{h.blocked}</p>
            ) : (
              <>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-2 text-xs text-slate-100">
                  {h.commands.join('\n')}
                </pre>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-1"
                  icon={<Copy className="h-4 w-4" />}
                  onClick={() => void copy(h.commands.join('\n'))}
                >
                  Salin
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs">
        Template baru otomatis masuk pool panel, sehingga hak token yang sudah ada berlaku. Pesan
        peringatan <code>chattr</code> pada storage SMB boleh diabaikan.
      </p>
    </div>
  );
}
