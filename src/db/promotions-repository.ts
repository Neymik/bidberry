import { query, execute } from './connection';

export async function upsertPromoParticipation(cabinetId: number, data: {
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
      (cabinet_id, nm_id, promo_id, promo_name, promo_type, start_date, end_date, is_participating)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      promo_name = VALUES(promo_name),
      promo_type = VALUES(promo_type),
      start_date = VALUES(start_date),
      end_date = VALUES(end_date),
      is_participating = VALUES(is_participating),
      synced_at = NOW()
  `, [
    cabinetId,
    data.nm_id,
    data.promo_id,
    data.promo_name ?? null,
    data.promo_type ?? null,
    data.start_date ? new Date(data.start_date) : null,
    data.end_date ? new Date(data.end_date) : null,
    data.is_participating,
  ]);
}

export async function getPromosByNmId(cabinetId: number, nmId: number): Promise<any[]> {
  return query<any[]>(
    'SELECT * FROM promotion_participation WHERE cabinet_id = ? AND nm_id = ? ORDER BY start_date DESC',
    [cabinetId, nmId]
  );
}

export async function getActivePromos(cabinetId: number): Promise<any[]> {
  return query<any[]>(
    `SELECT * FROM promotion_participation
     WHERE cabinet_id = ? AND is_participating = 1
     ORDER BY start_date DESC`,
    [cabinetId]
  );
}

export async function getActivePromosByNmId(cabinetId: number, nmId: number): Promise<any[]> {
  return query<any[]>(
    `SELECT * FROM promotion_participation
     WHERE cabinet_id = ? AND nm_id = ? AND is_participating = 1
     ORDER BY start_date DESC`,
    [cabinetId, nmId]
  );
}
