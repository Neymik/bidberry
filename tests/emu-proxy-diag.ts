/**
 * ws-scrcpy / emu-proxy diagnostic test
 * Tests each layer of the video streaming pipeline using the actual multiplexer protocol
 */

const WS_SCRCPY_DIRECT = 'http://127.0.0.1:22090';
const WS_SCRCPY_WS = 'ws://127.0.0.1:22090';

// Multiplexer message types
const MSG = {
  CreateChannel: 4,
  CloseChannel: 8,
  RawBinaryData: 16,
  RawStringData: 32,
  Data: 64,
} as const;

function createMessage(type: number, channelId: number, data?: Buffer): Buffer {
  const buf = Buffer.alloc(5 + (data ? data.byteLength : 0));
  buf.writeUInt8(type, 0);
  buf.writeUInt32LE(channelId, 1);
  if (data?.byteLength) {
    data.copy(buf, 5);
  }
  return buf;
}

function parseMessage(raw: ArrayBuffer) {
  const buf = Buffer.from(raw);
  return {
    type: buf.readUInt8(0),
    channelId: buf.readUInt32LE(1),
    data: buf.slice(5),
  };
}

function typeName(t: number): string {
  return Object.entries(MSG).find(([, v]) => v === t)?.[0] || `Unknown(${t})`;
}

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];

function log(name: string, pass: boolean, detail: string) {
  console.log(`${pass ? '✅' : '❌'} ${name}: ${detail}`);
  results.push({ name, pass, detail });
}

// ── Test 1: RedRoid health ──
async function testRedroid() {
  const proc = Bun.spawn(['docker', 'exec', 'redroid', 'sh', '-c',
    'echo "boot=$(getprop sys.boot_completed)" && screencap -p /dev/null && echo "screen=ok" && ss -tlnp | grep 8886 && echo "scrcpy=ok"']);
  const out = await new Response(proc.stdout).text();
  log('RedRoid: boot', out.includes('boot=1'), out.includes('boot=1') ? 'booted' : 'NOT BOOTED');
  log('RedRoid: screen', out.includes('screen=ok'), out.includes('screen=ok') ? 'capture works' : 'FAILED');
  log('RedRoid: scrcpy-server', out.includes('scrcpy=ok'), out.includes('scrcpy=ok') ? 'port 8886 listening' : 'NOT LISTENING');
}

// ── Test 2: H264 encoder ──
async function testEncoder() {
  const proc = Bun.spawn(['docker', 'exec', 'redroid', 'sh', '-c',
    'timeout 3 screenrecord --output-format h264 - 2>/dev/null | head -c 200 | od -A x -t x1 -N 32']);
  const out = await new Response(proc.stdout).text();
  const hasNAL = out.includes('00 00 00 01');
  log('RedRoid: H264 encode', hasNAL, hasNAL ? 'NAL units produced' : `no NAL: ${out.slice(0, 100)}`);
}

// ── Test 3: HTTP ──
async function testHttp() {
  const res = await fetch(`${WS_SCRCPY_DIRECT}/`);
  const html = await res.text();
  log('HTTP: ws-scrcpy', res.ok && html.includes('bundle.js'),
    `status=${res.status}, len=${html.length}`);
}

// ── Test 4: Multiplexer with GTRC (device tracker) ──
async function testMultiplexGTRC(): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      log('WS/Mux: GTRC channel', false, 'timeout 10s — no device data');
      resolve(null);
    }, 10000);

    const ws = new WebSocket(`${WS_SCRCPY_WS}/?action=multiplex`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      log('WS/Mux: connect', true, 'multiplex opened');
      // Send CreateChannel with id=1, data="GTRC"
      const channelData = Buffer.from('GTRC');
      const msg = createMessage(MSG.CreateChannel, 1, channelData);
      ws.send(msg);
      console.log(`   → Sent CreateChannel(id=1, data=GTRC) [${msg.length} bytes]`);
    };

    let udid: string | null = null;
    let msgCount = 0;

    ws.onmessage = (event) => {
      msgCount++;
      const parsed = parseMessage(event.data);
      const dataStr = parsed.data.toString('utf-8');

      console.log(`   ← msg#${msgCount}: type=${typeName(parsed.type)} ch=${parsed.channelId} len=${parsed.data.length}`);

      if (parsed.type === MSG.CreateChannel) {
        const code = parsed.data.slice(0, 4).toString('utf-8');
        console.log(`     CreateChannel code="${code}"`);
      }

      // Try to extract device info from string data
      if (parsed.type === MSG.RawStringData || parsed.type === MSG.Data) {
        try {
          const json = JSON.parse(dataStr);
          console.log(`     JSON:`, JSON.stringify(json).slice(0, 300));

          // Extract UDID from device list messages
          if (json.data?.udid) udid = json.data.udid;
          if (json.data?.serial) udid = json.data.serial;
          if (json.type === 'devicelist' && Array.isArray(json.data)) {
            for (const d of json.data) {
              if (d.udid || d.serial) {
                udid = d.udid || d.serial;
                break;
              }
            }
          }
        } catch {
          if (dataStr.length < 200) console.log(`     text: "${dataStr}"`);
        }
      }

      // Collect a few messages then resolve
      if (msgCount >= 5 || udid) {
        clearTimeout(timeout);
        log('WS/Mux: GTRC data', true,
          `${msgCount} messages, udid=${udid || 'not found yet'}`);
        ws.close();
        resolve(udid);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      log('WS/Mux: connect', false, 'WebSocket error');
      resolve(null);
    };

    ws.onclose = (e) => {
      clearTimeout(timeout);
      if (msgCount === 0) {
        log('WS/Mux: GTRC', false, `closed without data: code=${e.code} reason="${e.reason}"`);
        resolve(null);
      }
    };
  });
}

// ── Test 5: Stream channel via multiplexer ──
async function testStreamChannel(udid: string) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log('WS/Mux: stream', false, `timeout 10s — no video from udid=${udid}`);
      resolve();
    }, 10000);

    const ws = new WebSocket(`${WS_SCRCPY_WS}/?action=multiplex`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      // Create a stream channel. The DeviceTracker sends stream info,
      // but we need the actual stream endpoint. Let's try direct stream action too.
      const channelData = Buffer.from('GTRC');
      const msg = createMessage(MSG.CreateChannel, 1, channelData);
      ws.send(msg);
    };

    let msgCount = 0;
    let gotVideo = false;
    let totalBytes = 0;

    ws.onmessage = (event) => {
      msgCount++;
      const parsed = parseMessage(event.data);
      totalBytes += parsed.data.length;

      if (msgCount <= 8) {
        console.log(`   [stream] msg#${msgCount}: type=${typeName(parsed.type)} ch=${parsed.channelId} len=${parsed.data.length}`);
      }

      // Check for H264 NAL units in binary data
      if (parsed.type === MSG.RawBinaryData && parsed.data.length > 4) {
        const d = parsed.data;
        if ((d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1) ||
            (d[0] === 0 && d[1] === 0 && d[2] === 1)) {
          gotVideo = true;
          const nalType = (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 1) ? d[4] & 0x1f : d[3] & 0x1f;
          log('WS/Mux: H264 frame', true,
            `NAL type=${nalType} (${nalType === 7 ? 'SPS' : nalType === 8 ? 'PPS' : nalType === 5 ? 'IDR' : 'P-frame'})`);
        }
      }

      if (msgCount >= 15 || gotVideo) {
        clearTimeout(timeout);
        log('WS/Mux: stream summary', true,
          `${msgCount} msgs, ${totalBytes} bytes, video=${gotVideo}`);
        ws.close();
        resolve();
      }
    };

    ws.onerror = () => { clearTimeout(timeout); resolve(); };
    ws.onclose = () => { clearTimeout(timeout); resolve(); };
  });
}

// ── Test 6: Direct WebSocket stream action ──
async function testDirectStream(udid: string) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log('WS/Direct: stream', false, `timeout 8s — udid=${udid}`);
      resolve();
    }, 8000);

    const url = `${WS_SCRCPY_WS}/?action=stream&udid=${encodeURIComponent(udid)}`;
    console.log(`\n🔍 Direct stream: ${url}`);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    let msgCount = 0;

    ws.onopen = () => log('WS/Direct: connect', true, 'opened');

    ws.onmessage = (event) => {
      msgCount++;
      const data = new Uint8Array(event.data);
      console.log(`   [direct] msg#${msgCount}: ${data.byteLength} bytes, first=[${Array.from(data.slice(0, 16)).join(',')}]`);

      // Check for scrcpy_initial magic
      if (data.byteLength > 14) {
        const magic = new TextDecoder().decode(data.slice(0, 14));
        if (magic === 'scrcpy_initial') {
          log('WS/Direct: metadata', true, `scrcpy_initial ${data.byteLength}b`);
        }
      }

      // Check H264
      if (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) {
        log('WS/Direct: H264', true, `NAL type=${data[4] & 0x1f}`);
        clearTimeout(timeout);
        ws.close();
        resolve();
      }

      if (msgCount >= 10) {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      log('WS/Direct: stream', false, 'error');
      resolve();
    };

    ws.onclose = (e) => {
      clearTimeout(timeout);
      if (msgCount === 0) {
        log('WS/Direct: stream', false, `closed: code=${e.code} reason="${e.reason}"`);
      }
      resolve();
    };
  });
}

// ── Test 7: ADB connection from scrcpy-web ──
async function testAdbDevices() {
  const proc = Bun.spawn(['docker', 'exec', 'scrcpy-web', 'sh', '-c', 'adb devices -l']);
  const out = await new Response(proc.stdout).text();
  const hasDevice = out.includes('device ') && !out.includes('unauthorized');
  const devices = out.split('\n').filter(l => l.includes('device ')).map(l => l.split(/\s+/)[0]);
  log('ADB: devices', hasDevice, `found: [${devices.join(', ')}]`);
  return devices;
}

// ── Test 8: nginx proxy WebSocket ──
async function testNginxWsProxy() {
  // Test if nginx properly upgrades WebSocket for /emu-proxy/
  try {
    // We can't easily test WS through nginx without auth, but we can check headers
    const res = await fetch(`https://bidberry.animeenigma.ru/emu-proxy/`, { redirect: 'manual' });
    const csp = res.headers.get('content-security-policy');
    log('Nginx: CSP header', !!csp,
      csp ? `CSP set: ${csp.slice(0, 80)}...` : 'NO CSP header on /emu-proxy/');
    log('Nginx: auth redirect', res.status === 302, `status=${res.status}`);
  } catch (e: any) {
    log('Nginx: proxy', false, e.message);
  }
}

// ── Main ──
async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  ws-scrcpy / emu-proxy Diagnostic v2');
  console.log('═══════════════════════════════════════════════\n');

  console.log('── 1. Infrastructure ──');
  await testRedroid();
  await testEncoder();

  console.log('\n── 2. ADB ──');
  const adbDevices = await testAdbDevices();

  console.log('\n── 3. HTTP ──');
  await testHttp();
  await testNginxWsProxy();

  console.log('\n── 4. Multiplexer + GTRC (device tracker) ──');
  const udid = await testMultiplexGTRC();
  console.log(`   → UDID from tracker: ${udid || 'NONE'}`);

  const testUdid = udid || adbDevices[0] || 'emulator-5554';
  console.log(`   → Using UDID for stream tests: ${testUdid}`);

  console.log('\n── 5. Multiplexer stream channel ──');
  await testStreamChannel(testUdid);

  console.log('\n── 6. Direct stream action ──');
  await testDirectStream(testUdid);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(` SUMMARY: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n FAILURES:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name}: ${r.detail}`));
  }
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
