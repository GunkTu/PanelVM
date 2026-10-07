import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, ConfirmDialog, Table, ToastProvider, useToast } from '.';

describe('ConfirmDialog', () => {
  it('menonaktifkan konfirmasi sampai nama resource diketik persis', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Hapus database"
        message="Data hilang permanen."
        requireText="blog_db"
        confirmLabel="Hapus"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Hapus' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Ketik/), { target: { value: 'blog_d' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Ketik/), { target: { value: 'blog_db' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('Toast', () => {
  function Trigger() {
    const toast = useToast();
    return (
      <>
        <button onClick={() => toast.show('success', 'Tersimpan')}>ok</button>
        <button
          onClick={() => toast.show('error', 'Gagal terhubung. Periksa koneksi lalu coba lagi.')}
        >
          err
        </button>
      </>
    );
  }

  it('sukses hilang otomatis, error tetap sampai ditutup', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('ok'));
    fireEvent.click(screen.getByText('err'));
    expect(screen.getByText('Tersimpan')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText('Tersimpan')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('Table', () => {
  it('menampilkan pesan kosong dan skeleton saat loading', () => {
    const cols = [{ header: 'Nama', render: (r: { n: string }) => r.n }];
    const { rerender } = render(
      <Table
        columns={cols}
        rows={[]}
        rowKey={(r) => r.n}
        emptyMessage="Belum ada VM. Klik Tambah VM."
      />,
    );
    expect(screen.getByText('Belum ada VM. Klik Tambah VM.')).toBeInTheDocument();
    rerender(
      <Table columns={cols} rows={undefined} loading rowKey={(r) => r.n} emptyMessage="x" />,
    );
    expect(screen.queryByText('x')).not.toBeInTheDocument();
  });
});

describe('Button', () => {
  it('tidak bisa diklik saat loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Simpan
      </Button>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
