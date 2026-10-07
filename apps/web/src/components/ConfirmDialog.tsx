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

export function ConfirmDialog({
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
      <p>{message}</p>
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
