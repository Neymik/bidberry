import { test, expect, describe, mock, beforeEach } from 'bun:test';

const mockSendTelegram = mock(async (_text: string) => {});
const mockGetCabinetById = mock(async (id: number) => ({
  id,
  account_id: 1,
  name: 'Test',
  wb_api_key: 'k',
  is_active: true,
  last_sync_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}));
const mockGetPhoneTotals = mock((_a: string, _b: string) => [
  { article: '12345', vendorCode: 'VC1', orders: 1 },
]);
const mockGetCampaignsForProduct = mock(async (_c: number, _n: number) => []);
const mockGetHourlySpendFromSnapshots = mock(async () => []);
const mockGetSpendForCampaigns = mock(async () => 0);
const mockGetOrderCountForProduct = mock(async () => 0);

mock.module('./telegram-notifier', () => ({ sendTelegramMessage: mockSendTelegram }));
mock.module('../db/cabinets-repository', () => ({ getCabinetById: mockGetCabinetById }));
mock.module('./wbpartners-phone-db', () => ({ getPhoneTotalsByArticle: mockGetPhoneTotals }));
mock.module('../db/monitoring-repository', () => ({
  getCampaignsForProduct: mockGetCampaignsForProduct,
  getHourlySpendFromSnapshots: mockGetHourlySpendFromSnapshots,
  getSpendForCampaigns: mockGetSpendForCampaigns,
  getOrderCountForProduct: mockGetOrderCountForProduct,
}));

describe('sendCabinetReport cooldown', () => {
  beforeEach(() => {
    mockSendTelegram.mockClear();
  });

  test('first call sends', async () => {
    const { sendCabinetReport, _resetCooldownForTests } = await import('./cabinet-report');
    _resetCooldownForTests();
    const ok = await sendCabinetReport(101);
    expect(ok).toBe(true);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });

  test('immediate second call to same cabinet is suppressed', async () => {
    const { sendCabinetReport, _resetCooldownForTests } = await import('./cabinet-report');
    _resetCooldownForTests();
    await sendCabinetReport(202);
    const ok = await sendCabinetReport(202);
    expect(ok).toBe(false);
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
  });

  test('different cabinets do not share cooldown', async () => {
    const { sendCabinetReport, _resetCooldownForTests } = await import('./cabinet-report');
    _resetCooldownForTests();
    await sendCabinetReport(303);
    await sendCabinetReport(404);
    expect(mockSendTelegram).toHaveBeenCalledTimes(2);
  });
});
