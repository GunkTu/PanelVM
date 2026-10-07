import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** Bila diisi, pengguna harus mengetik teks ini persis sebelum bisa mengonfirmasi (aksi destruktif). */
  requireText?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmBody({
  open,
  title,
  message,
  confirmLabel = 'Konfirmasi',
  requireText,
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const allowed = !requireText || typed === requireText;

  const cancel = () => {
    setTyped('');
    onCancel();
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={cancel}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Batal
          </Button>
          <Button variant="danger" disabled={!allowed} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600"
        >
          <TriangleAlert className="h-5 w-5" />
        </span>
        <p className="pt-1">{message}</p>
      </div>
      {requireText && (
        <div className="mt-4">
          <Input
            label={`Ketik "${requireText}" untuk melanjutkan`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Modal>
  );
}

/** Dipasang hanya saat terbuka sehingga isian konfirmasi selalu mulai kosong. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return props.open ? <ConfirmBody {...props} /> : null;
}
