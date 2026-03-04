import { test, expect, describe, beforeEach } from 'bun:test';
import {
  WBApiClient,
  getWBClientForCabinet,
  invalidateCabinetClient,
  getWBClient,
} from './wb-client';

describe('WB Client Factory', () => {
  beforeEach(() => {
    // Clear cache between tests by invalidating known IDs
    invalidateCabinetClient(1);
    invalidateCabinetClient(2);
    invalidateCabinetClient(99);
  });

  test('getWBClientForCabinet returns WBApiClient instance', () => {
    const client = getWBClientForCabinet(1, 'test-api-key-1');
    expect(client).toBeInstanceOf(WBApiClient);
  });

  test('getWBClientForCabinet returns cached client for same cabinetId', () => {
    const client1 = getWBClientForCabinet(1, 'test-api-key-1');
    const client2 = getWBClientForCabinet(1, 'test-api-key-1');
    expect(client1).toBe(client2);
  });

  test('getWBClientForCabinet returns different clients for different cabinetIds', () => {
    const client1 = getWBClientForCabinet(1, 'test-api-key-1');
    const client2 = getWBClientForCabinet(2, 'test-api-key-2');
    expect(client1).not.toBe(client2);
  });

  test('invalidateCabinetClient removes cached client', () => {
    const client1 = getWBClientForCabinet(99, 'key-99');
    invalidateCabinetClient(99);
    const client2 = getWBClientForCabinet(99, 'key-99');
    expect(client1).not.toBe(client2);
  });

  test('getWBClient returns singleton instance', () => {
    const client1 = getWBClient('some-key');
    const client2 = getWBClient();
    expect(client1).toBe(client2);
    expect(client1).toBeInstanceOf(WBApiClient);
  });
});
