/**
 * Thin TypeScript wrapper over the Docker Engine API via unix socket.
 * Requires /var/run/docker.sock to be mounted into the container.
 */

const DOCKER_SOCKET = '/var/run/docker.sock';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContainerCreateOptions {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  Entrypoint?: string[];
  HostConfig?: Record<string, unknown>;
  Labels?: Record<string, string>;
  Healthcheck?: Record<string, unknown>;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    OOMKilled: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: {
      Status: string;
    };
  };
}

export interface ContainerListEntry {
  Id: string;
  Names: string[];
  State: string;
  Labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class DockerError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    message: string,
  ) {
    super(`Docker ${method} ${path} responded ${status}: ${message}`);
    this.name = 'DockerError';
  }
}

async function dockerFetch(
  path: string,
  options: RequestInit & { unix?: string } = {},
): Promise<Response> {
  const url = `http://localhost${path}`;
  return fetch(url, {
    ...options,
    unix: DOCKER_SOCKET,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  } as any);
}

async function assertOk(
  res: Response,
  method: string,
  path: string,
  allowedStatuses: number[] = [],
): Promise<void> {
  if (res.ok || allowedStatuses.includes(res.status)) return;
  const body = await res.text().catch(() => '(no body)');
  throw new DockerError(res.status, method, path, body);
}

/**
 * Parse Docker multiplexed log stream.
 *
 * Each frame has an 8-byte header:
 *   byte 0   — stream type (1 = stdout, 2 = stderr)
 *   bytes 1-3 — padding
 *   bytes 4-7 — big-endian uint32 payload size
 *
 * We concatenate all frame payloads into a single string.
 */
function parseDockerLogStream(buffer: ArrayBuffer): string {
  const view = new DataView(buffer);
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    // bytes 4-7: payload size (big-endian uint32)
    const payloadSize = view.getUint32(offset + 4, false);
    offset += 8;

    if (offset + payloadSize > buffer.byteLength) break;

    const payload = new Uint8Array(buffer, offset, payloadSize);
    chunks.push(decoder.decode(payload));
    offset += payloadSize;
  }

  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a container with the given name and config.
 * Returns the container ID.
 */
export async function createContainer(
  name: string,
  config: ContainerCreateOptions,
): Promise<string> {
  const path = `/containers/create?name=${encodeURIComponent(name)}`;
  const res = await dockerFetch(path, {
    method: 'POST',
    body: JSON.stringify(config),
  });
  await assertOk(res, 'POST', path);
  const json = (await res.json()) as { Id: string };
  return json.Id;
}

/**
 * Start a container. Treats 304 (already started) as success.
 */
export async function startContainer(id: string): Promise<void> {
  const path = `/containers/${encodeURIComponent(id)}/start`;
  const res = await dockerFetch(path, { method: 'POST' });
  await assertOk(res, 'POST', path, [304]);
}

/**
 * Stop a container. Treats 304 (already stopped) as success.
 */
export async function stopContainer(
  id: string,
  timeout: number = 10,
): Promise<void> {
  const path = `/containers/${encodeURIComponent(id)}/stop?t=${timeout}`;
  const res = await dockerFetch(path, { method: 'POST' });
  await assertOk(res, 'POST', path, [304]);
}

/**
 * Remove a container. Treats 404 (already gone) as success.
 */
export async function removeContainer(
  id: string,
  force: boolean = false,
): Promise<void> {
  const path = `/containers/${encodeURIComponent(id)}?force=${force}`;
  const res = await dockerFetch(path, { method: 'DELETE' });
  await assertOk(res, 'DELETE', path, [404]);
}

/**
 * Inspect a container, returning its full state.
 */
export async function inspectContainer(
  id: string,
): Promise<ContainerInspect> {
  const path = `/containers/${encodeURIComponent(id)}/json`;
  const res = await dockerFetch(path, { method: 'GET' });
  await assertOk(res, 'GET', path);
  return (await res.json()) as ContainerInspect;
}

/**
 * Fetch container logs, parsing the Docker multiplexed stream format.
 * Returns the log text as a single string.
 */
export async function getContainerLogs(
  id: string,
  tail: number = 200,
): Promise<string> {
  const path = `/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=${tail}&timestamps=true`;
  const res = await dockerFetch(path, { method: 'GET' });
  await assertOk(res, 'GET', path);
  const buffer = await res.arrayBuffer();
  return parseDockerLogStream(buffer);
}

/**
 * Remove a volume by name. Treats 404 (already gone) as success.
 */
export async function removeVolume(name: string): Promise<void> {
  const path = `/volumes/${encodeURIComponent(name)}`;
  const res = await dockerFetch(path, { method: 'DELETE' });
  await assertOk(res, 'DELETE', path, [404]);
}

/**
 * List all containers with the label `wb.managed=true`.
 */
export async function listManagedContainers(): Promise<ContainerListEntry[]> {
  const filters = JSON.stringify({ label: ['wb.managed=true'] });
  const path = `/containers/json?all=true&filters=${encodeURIComponent(filters)}`;
  const res = await dockerFetch(path, { method: 'GET' });
  await assertOk(res, 'GET', path);
  return (await res.json()) as ContainerListEntry[];
}
