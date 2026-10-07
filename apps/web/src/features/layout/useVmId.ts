import { useParams } from 'react-router-dom';

export function useVmId(): string {
  const { vmId } = useParams();
  if (!vmId) throw new Error('vmId tidak ada di rute');
  return vmId;
}
