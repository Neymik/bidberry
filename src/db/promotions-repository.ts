import { query, execute } from './connection';

export async function upsertPromoParticipation(data: {
  nm_id: number;
  promo_id: number;
  promo_name: string;
  promo_type: string;
  start_date: string;
  end_date: string;
  is_participating: boolean;
}): Promise<void> {
  await execute(`
    INSERT INTO promotion_participation
      (nm_id, promo_id, promo_name, promo_type, start_date, end_date, is_participating)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      promo_name = VALUES(promo_name),
      promo_type = VALUES(promo_type),
      start_date = VALUES(start_date),
      end_date = VALUES(end_date),
      is_participating = VALUES(is_participating),
      synced_at = NOW()
  `, [
    data.nm_id,
    data.promo_id,
    data.promo_name ?? null,
    data.promo_type ?? null,
    data.start_date ? new Date(data.start_date) : null,
    data.end_date ? new Date(data.end_date) : null,
    data.is_participating,
  ]);
}

export async function getPromosByNmId(nmId: number): Promise<any[]> {
  return query<any[]>(
    'SELECT * FROM promotion_participation WHERE nm_id = ? ORDER BY start_date DESC',
    [nmId]
  );
}

export async function getActivePromos(): Promise<any[]> {
  return query<any[]>(
    `SELECT * FROM promotion_participation
     WHERE is_participating = 1
     ORDER BY start_date DESC`
  );
}

export async function getActivePromosByNmId(nmId: number): Promise<any[]> {
  return query<any[]>(
    `SELECT * FROM promotion_participation
     WHERE nm_id = ? AND is_participating = 1
     ORDER BY start_date DESC`,
    [nmId]
  );
}
