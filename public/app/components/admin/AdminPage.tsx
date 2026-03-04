import React, { useState, useEffect } from 'react';
import { api } from '../../hooks/useApi';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';

type Tab = 'users' | 'accounts' | 'whitelist';

export default function AdminPage() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('accounts');

  if (!isAdmin) {
    return (
      <div className="p-8 text-center text-gray-500">
        Доступ запрещён. Требуются права администратора.
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'accounts', label: 'Аккаунты и кабинеты' },
    { key: 'users', label: 'Пользователи' },
    { key: 'whitelist', label: 'Белый список' },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-800 mb-6">Администрирование</h1>
      <div className="flex space-x-1 bg-gray-100 p-1 rounded-lg mb-6 w-fit">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm rounded-md transition-colors ${
              tab === t.key
                ? 'bg-white text-purple-700 font-medium shadow-sm'
                : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'accounts' && <AccountsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'whitelist' && <WhitelistTab />}
    </div>
  );
}

// === ACCOUNTS & CABINETS TAB ===

function AccountsTab() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAccountName, setNewAccountName] = useState('');
  const [showNewCabinet, setShowNewCabinet] = useState<number | null>(null);
  const [newCabinet, setNewCabinet] = useState({ name: '', wbApiKey: '' });
  const { showToast } = useToast();

  async function load() {
    try {
      const data = await api<any[]>('/admin/accounts');
      setAccounts(data);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function createAccount() {
    if (!newAccountName.trim()) return;
    try {
      await api('/admin/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: newAccountName }),
      });
      setNewAccountName('');
      showToast('Аккаунт создан', 'success');
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  async function createCabinet(accountId: number) {
    if (!newCabinet.name.trim() || !newCabinet.wbApiKey.trim()) return;
    try {
      await api('/admin/cabinets', {
        method: 'POST',
        body: JSON.stringify({ accountId, ...newCabinet }),
      });
      setNewCabinet({ name: '', wbApiKey: '' });
      setShowNewCabinet(null);
      showToast('Кабинет создан', 'success');
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  async function toggleCabinet(id: number, isActive: boolean) {
    try {
      await api(`/admin/cabinets/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !isActive }),
      });
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  async function deleteCabinet(id: number, name: string) {
    if (!confirm(`Удалить кабинет "${name}"?`)) return;
    try {
      await api(`/admin/cabinets/${id}`, { method: 'DELETE' });
      showToast('Кабинет удалён', 'success');
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  if (loading) return <div className="text-gray-400">Загрузка...</div>;

  return (
    <div className="space-y-6">
      {/* Create account */}
      <div className="flex items-center space-x-3">
        <input
          type="text"
          placeholder="Название нового аккаунта"
          value={newAccountName}
          onChange={e => setNewAccountName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createAccount()}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:ring-2 focus:ring-purple-500"
        />
        <button
          onClick={createAccount}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700"
        >
          Создать аккаунт
        </button>
      </div>

      {/* Account list */}
      {accounts.map(account => (
        <div key={account.id} className="bg-white rounded-xl shadow-sm border p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">
              {account.name}
              <span className="text-xs text-gray-400 ml-2">ID: {account.id}</span>
            </h3>
            <button
              onClick={() => setShowNewCabinet(showNewCabinet === account.id ? null : account.id)}
              className="text-sm text-purple-600 hover:text-purple-800"
            >
              + Добавить кабинет
            </button>
          </div>

          {/* Users in account */}
          {account.users?.length > 0 && (
            <div className="mb-3 text-xs text-gray-500">
              Пользователи: {account.users.map((u: any) => `${u.username || u.first_name} (${u.role})`).join(', ')}
            </div>
          )}

          {/* New cabinet form */}
          {showNewCabinet === account.id && (
            <div className="flex items-center space-x-2 mb-3 p-3 bg-gray-50 rounded-lg">
              <input
                type="text"
                placeholder="Название кабинета"
                value={newCabinet.name}
                onChange={e => setNewCabinet({ ...newCabinet, name: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm flex-1"
              />
              <input
                type="password"
                placeholder="WB API Key"
                value={newCabinet.wbApiKey}
                onChange={e => setNewCabinet({ ...newCabinet, wbApiKey: e.target.value })}
                className="border border-gray-300 rounded px-2 py-1.5 text-sm flex-1"
              />
              <button
                onClick={() => createCabinet(account.id)}
                className="bg-purple-600 text-white px-3 py-1.5 rounded text-sm hover:bg-purple-700"
              >
                Создать
              </button>
            </div>
          )}

          {/* Cabinets list */}
          {account.cabinets?.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 text-xs">
                  <th className="pb-2">ID</th>
                  <th className="pb-2">Название</th>
                  <th className="pb-2">Статус</th>
                  <th className="pb-2">Посл. синхр.</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {account.cabinets.map((cab: any) => (
                  <tr key={cab.id} className="border-t border-gray-100">
                    <td className="py-2 text-gray-400">{cab.id}</td>
                    <td className="py-2">{cab.name}</td>
                    <td className="py-2">
                      <button
                        onClick={() => toggleCabinet(cab.id, cab.is_active)}
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          cab.is_active
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {cab.is_active ? 'Активен' : 'Отключён'}
                      </button>
                    </td>
                    <td className="py-2 text-xs text-gray-400">
                      {cab.last_sync_at ? new Date(cab.last_sync_at).toLocaleString('ru-RU') : '-'}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => deleteCabinet(cab.id, cab.name)}
                        className="text-xs text-red-400 hover:text-red-600"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-gray-400">Нет кабинетов</div>
          )}
        </div>
      ))}

      {accounts.length === 0 && (
        <div className="text-gray-400 text-center py-8">Нет аккаунтов</div>
      )}
    </div>
  );
}

// === USERS TAB ===

function UsersTab() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  async function load() {
    try {
      const data = await api<any[]>('/admin/users');
      setUsers(data);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <div className="text-gray-400">Загрузка...</div>;

  return (
    <div className="bg-white rounded-xl shadow-sm border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 text-xs border-b">
            <th className="px-4 py-3">ID</th>
            <th className="px-4 py-3">Username</th>
            <th className="px-4 py-3">Имя</th>
            <th className="px-4 py-3">Роль</th>
            <th className="px-4 py-3">Аккаунты</th>
            <th className="px-4 py-3">Регистрация</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id} className="border-t border-gray-50 hover:bg-gray-50">
              <td className="px-4 py-3 text-gray-400">{user.id}</td>
              <td className="px-4 py-3 font-medium">{user.username || '-'}</td>
              <td className="px-4 py-3">{user.first_name} {user.last_name || ''}</td>
              <td className="px-4 py-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  user.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {user.role || 'user'}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">
                {user.account_ids || '-'}
              </td>
              <td className="px-4 py-3 text-xs text-gray-400">
                {user.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 && (
        <div className="text-gray-400 text-center py-8">Нет пользователей</div>
      )}
    </div>
  );
}

// === WHITELIST TAB ===

function WhitelistTab() {
  const [allowed, setAllowed] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState('');
  const { showToast } = useToast();

  async function load() {
    try {
      const data = await api<any[]>('/admin/whitelist');
      setAllowed(data);
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function addUser() {
    if (!newUsername.trim()) return;
    try {
      await api('/admin/whitelist', {
        method: 'POST',
        body: JSON.stringify({ username: newUsername.trim() }),
      });
      setNewUsername('');
      showToast('Пользователь добавлен', 'success');
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  async function removeUser(username: string) {
    if (!confirm(`Удалить "${username}" из белого списка?`)) return;
    try {
      await api(`/admin/whitelist/${encodeURIComponent(username)}`, { method: 'DELETE' });
      showToast('Пользователь удалён', 'success');
      load();
    } catch (e: any) {
      showToast(e.message, 'error');
    }
  }

  if (loading) return <div className="text-gray-400">Загрузка...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-3">
        <input
          type="text"
          placeholder="Telegram username (без @)"
          value={newUsername}
          onChange={e => setNewUsername(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addUser()}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-64 focus:ring-2 focus:ring-purple-500"
        />
        <button
          onClick={addUser}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-purple-700"
        >
          Добавить
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs border-b">
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Добавлен</th>
              <th className="px-4 py-3">Дата</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {allowed.map(u => (
              <tr key={u.id} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium">@{u.username}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{u.added_by || '-'}</td>
                <td className="px-4 py-3 text-xs text-gray-400">
                  {u.created_at ? new Date(u.created_at).toLocaleDateString('ru-RU') : '-'}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => removeUser(u.username)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {allowed.length === 0 && (
          <div className="text-gray-400 text-center py-8">Белый список пуст</div>
        )}
      </div>
    </div>
  );
}
