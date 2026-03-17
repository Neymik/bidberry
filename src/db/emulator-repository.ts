import { query, execute, transaction } from './connection';

// === INTERFACES ===

export interface EmulatorInstance {
  id: number;
  cabinet_id: number;
  emu_container_id: string | null;
  scrcpy_container_id: string | null;
  monitor_container_id: string | null;
  emu_container_name: string;
  scrcpy_container_name: string;
  monitor_container_name: string;
  status: 'created' | 'running' | 'stopped' | 'error';
  monitor_status: 'stopped' | 'running' | 'error';
  adb_port: number;
  scrcpy_port: number;
  ingest_api_key: string;
  last_heartbeat: Date | null;
  error_message: string | null;
  created_by: number;
  created_at: Date;
  updated_at: Date;
}

export interface EmuOrder {
  id: number;
  cabinet_id: number;
  dedup_key: string;
  article: string;
  product: string | null;
  size: string | null;
  quantity: string | null;
  status: string | null;
  price: string | null;
  price_cents: number | null;
  date_raw: string | null;
  date_parsed: Date | null;
  category: string | null;
  warehouse: string | null;
  arrival_city: string | null;
  first_seen: Date;
}

// === EMULATOR INSTANCES ===

const ADB_PORT_MIN = 5555;
const ADB_PORT_MAX = 5574;
const SCRCPY_PORT_MIN = 9090;
const SCRCPY_PORT_MAX = 9109;

export async function getAllInstances(): Promise<EmulatorInstance[]> {
  return query<EmulatorInstance[]>('SELECT * FROM emulator_instances ORDER BY id');
}

export async function getInstanceById(id: number): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>(
    'SELECT * FROM emulator_instances WHERE id = ?',
    [id]
  );
  return rows[0] || null;
}

export async function getInstanceByCabinetId(cabinetId: number): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>(
    'SELECT * FROM emulator_instances WHERE cabinet_id = ?',
    [cabinetId]
  );
  return rows[0] || null;
}

export async function getInstanceByApiKey(apiKey: string): Promise<EmulatorInstance | null> {
  const rows = await query<EmulatorInstance[]>(
    'SELECT * FROM emulator_instances WHERE ingest_api_key = ?',
    [apiKey]
  );
  return rows[0] || null;
}

export async function getRunningInstances(): Promise<EmulatorInstance[]> {
  return query<EmulatorInstance[]>(
    "SELECT * FROM emulator_instances WHERE status = 'running' ORDER BY id"
  );
}

export async function allocatePortsAndCreate(
  cabinetId: number,
  createdBy: number,
  ingestApiKey: string
): Promise<EmulatorInstance> {
  return transaction(async (connection) => {
    // Lock existing rows to prevent port allocation races
    const [existingRows] = await connection.query(
      'SELECT adb_port, scrcpy_port FROM emulator_instances FOR UPDATE'
    );
    const existing = existingRows as { adb_port: number; scrcpy_port: number }[];

    const usedAdbPorts = new Set(existing.map((r) => r.adb_port));
    const usedScrcpyPorts = new Set(existing.map((r) => r.scrcpy_port));

    let adbPort: number | null = null;
    for (let p = ADB_PORT_MIN; p <= ADB_PORT_MAX; p++) {
      if (!usedAdbPorts.has(p)) {
        adbPort = p;
        break;
      }
    }
    if (adbPort === null) {
      throw new Error(`No available ADB ports in range ${ADB_PORT_MIN}-${ADB_PORT_MAX}`);
    }

    let scrcpyPort: number | null = null;
    for (let p = SCRCPY_PORT_MIN; p <= SCRCPY_PORT_MAX; p++) {
      if (!usedScrcpyPorts.has(p)) {
        scrcpyPort = p;
        break;
      }
    }
    if (scrcpyPort === null) {
      throw new Error(`No available scrcpy ports in range ${SCRCPY_PORT_MIN}-${SCRCPY_PORT_MAX}`);
    }

    const emuContainerName = `emu-cab-${cabinetId}`;
    const scrcpyContainerName = `scrcpy-cab-${cabinetId}`;
    const monitorContainerName = `monitor-cab-${cabinetId}`;

    const [result] = await connection.execute(
      `INSERT INTO emulator_instances
        (cabinet_id, emu_container_name, scrcpy_container_name, monitor_container_name,
         adb_port, scrcpy_port, ingest_api_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cabinetId, emuContainerName, scrcpyContainerName, monitorContainerName,
       adbPort, scrcpyPort, ingestApiKey, createdBy]
    );

    const insertId = (result as any).insertId;

    const [rows] = await connection.query(
      'SELECT * FROM emulator_instances WHERE id = ?',
      [insertId]
    );
    return (rows as EmulatorInstance[])[0];
  });
}

export async function updateContainerIds(
  id: number,
  emuContainerId: string,
  scrcpyContainerId: string,
  monitorContainerId: string
): Promise<void> {
  await execute(
    `UPDATE emulator_instances
     SET emu_container_id = ?, scrcpy_container_id = ?, monitor_container_id = ?
     WHERE id = ?`,
    [emuContainerId, scrcpyContainerId, monitorContainerId, id]
  );
}

export async function updateStatus(
  id: number,
  status: EmulatorInstance['status'],
  errorMessage?: string
): Promise<void> {
  await execute(
    'UPDATE emulator_instances SET status = ?, error_message = ? WHERE id = ?',
    [status, errorMessage ?? null, id]
  );
}

export async function updateMonitorStatus(
  id: number,
  monitorStatus: EmulatorInstance['monitor_status']
): Promise<void> {
  await execute(
    'UPDATE emulator_instances SET monitor_status = ? WHERE id = ?',
    [monitorStatus, id]
  );
}

export async function updateHeartbeat(id: number): Promise<void> {
  await execute(
    'UPDATE emulator_instances SET last_heartbeat = NOW() WHERE id = ?',
    [id]
  );
}

export async function deleteInstance(id: number): Promise<void> {
  await execute('DELETE FROM emulator_instances WHERE id = ?', [id]);
}

// === EMU ORDERS ===

export async function insertOrders(
  cabinetId: number,
  orders: Array<{
    article: string;
    product?: string | null;
    size?: string | null;
    quantity?: string | null;
    status?: string | null;
    price?: string | null;
    price_cents?: number | null;
    date_raw?: string | null;
    date_parsed?: Date | null;
    category?: string | null;
    warehouse?: string | null;
    arrival_city?: string | null;
  }>
): Promise<{ inserted: number; duplicates: number }> {
  if (orders.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }

  let inserted = 0;
  let duplicates = 0;

  for (const order of orders) {
    const dedupKey = `${order.article}|${order.size ?? ''}|${order.status ?? ''}|${order.date_raw ?? ''}`;

    const result = await execute(
      `INSERT IGNORE INTO emu_orders
        (cabinet_id, dedup_key, article, product, size, quantity,
         status, price, price_cents, date_raw, date_parsed,
         category, warehouse, arrival_city)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        cabinetId,
        dedupKey,
        order.article,
        order.product ?? null,
        order.size ?? null,
        order.quantity ?? null,
        order.status ?? null,
        order.price ?? null,
        order.price_cents ?? null,
        order.date_raw ?? null,
        order.date_parsed ?? null,
        order.category ?? null,
        order.warehouse ?? null,
        order.arrival_city ?? null,
      ]
    );

    if (result.affectedRows > 0) {
      inserted++;
    } else {
      duplicates++;
    }
  }

  return { inserted, duplicates };
}

export async function getEmuOrdersToday(cabinetId: number): Promise<number> {
  const rows = await query<{ cnt: number }[]>(
    `SELECT COUNT(*) as cnt FROM emu_orders
     WHERE cabinet_id = ? AND DATE(first_seen) = CURDATE()`,
    [cabinetId]
  );
  return rows[0]?.cnt ?? 0;
}

export async function getLastEmuOrder(cabinetId: number): Promise<Date | null> {
  const rows = await query<{ latest: Date | null }[]>(
    `SELECT MAX(first_seen) as latest FROM emu_orders WHERE cabinet_id = ?`,
    [cabinetId]
  );
  return rows[0]?.latest ?? null;
}
