import React from 'react';
import { Routes, Route } from 'react-router-dom';
import AppHeader from './components/layout/AppHeader';
import AppSidebar from './components/layout/AppSidebar';
import ToastContainer from './components/layout/ToastContainer';
import DashboardPage from './components/dashboard/DashboardPage';
import CampaignsPage from './components/campaigns/CampaignsPage';
import ProductsPage from './components/products/ProductsPage';
import KeywordsPage from './components/keywords/KeywordsPage';
import FinancialPage from './components/financial/FinancialPage';
import ImportExportPage from './components/import-export/ImportExportPage';
import AdminPage from './components/admin/AdminPage';
import LoginPage from './components/auth/LoginPage';
import { ToastProvider } from './hooks/useToast';
import { DateRangeProvider } from './hooks/useDateRange';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { CabinetProvider } from './hooks/useCabinet';

function ProtectedApp() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-500 text-lg">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <CabinetProvider>
      <DateRangeProvider>
        <div className="min-h-screen bg-gray-100">
          <AppHeader />
          <div className="flex">
            <AppSidebar />
            <main className="flex-1 p-6 max-w-7xl">
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/campaigns" element={<CampaignsPage />} />
                <Route path="/products" element={<ProductsPage />} />
                <Route path="/keywords" element={<KeywordsPage />} />
                <Route path="/financial" element={<FinancialPage />} />
                <Route path="/import-export" element={<ImportExportPage />} />
                <Route path="/admin" element={<AdminPage />} />
              </Routes>
            </main>
          </div>
          <ToastContainer />
        </div>
      </DateRangeProvider>
    </CabinetProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <ProtectedApp />
      </AuthProvider>
    </ToastProvider>
  );
}
