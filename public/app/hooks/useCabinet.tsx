import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from './useApi';

interface Cabinet {
  id: number;
  account_id: number;
  name: string;
  is_active: boolean;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CabinetContextType {
  cabinets: Cabinet[];
  selectedCabinetId: number | null;
  selectedCabinet: Cabinet | null;
  selectCabinet: (id: number) => void;
  loading: boolean;
  refresh: () => Promise<void>;
}

const CabinetContext = createContext<CabinetContextType>(null!);

export function CabinetProvider({ children }: { children: React.ReactNode }) {
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [selectedCabinetId, setSelectedCabinetId] = useState<number | null>(
    () => {
      const stored = localStorage.getItem('selectedCabinetId');
      return stored ? parseInt(stored) : null;
    }
  );
  const [loading, setLoading] = useState(true);

  async function fetchCabinets() {
    try {
      const data = await api<Cabinet[]>('/cabinets');
      setCabinets(data);

      // Auto-select first cabinet if none selected or selected not in list
      if (data.length > 0) {
        const validSelection = selectedCabinetId && data.some(c => c.id === selectedCabinetId);
        if (!validSelection) {
          setSelectedCabinetId(data[0].id);
          localStorage.setItem('selectedCabinetId', String(data[0].id));
        }
      }
    } catch {
      // Not logged in yet or error — ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCabinets();
  }, []);

  function selectCabinet(id: number) {
    setSelectedCabinetId(id);
    localStorage.setItem('selectedCabinetId', String(id));
  }

  const selectedCabinet = cabinets.find(c => c.id === selectedCabinetId) || null;

  return (
    <CabinetContext.Provider value={{
      cabinets,
      selectedCabinetId,
      selectedCabinet,
      selectCabinet,
      loading,
      refresh: fetchCabinets,
    }}>
      {children}
    </CabinetContext.Provider>
  );
}

export function useCabinet() {
  return useContext(CabinetContext);
}
