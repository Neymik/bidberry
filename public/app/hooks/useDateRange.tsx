import React, { createContext, useContext, useState } from 'react';

interface DateRange {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (d: string) => void;
  setDateTo: (d: string) => void;
}

const DateRangeContext = createContext<DateRange>(null!);

export function DateRangeProvider({ children }: { children: React.ReactNode }) {
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [dateFrom, setDateFrom] = useState(weekAgo.toISOString().split('T')[0]!);
  const [dateTo, setDateTo] = useState(today.toISOString().split('T')[0]!);

  return (
    <DateRangeContext.Provider value={{ dateFrom, dateTo, setDateFrom, setDateTo }}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  return useContext(DateRangeContext);
}
