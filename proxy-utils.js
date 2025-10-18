// proxy-utils.js
import http from 'http';
import https from 'https';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { readFile } from 'fs/promises';
import { red, green, yellow } from 'colorette';

let proxies = [];
let lastProxy = null;

export async function loadProxies(filePath = 'proxies.txt') {
  try {
    const raw = await readFile(filePath, 'utf8');
    proxies = raw.split('\n').map(p => p.trim()).filter(Boolean);
    if (!proxies.length) throw new Error('No proxies found!');
    console.log(green(`✅ Loaded ${proxies.length} proxies.`));
  } catch (e) {
    console.error(red(`❌ Failed to load proxies: ${e.message}`));
    process.exit(1);
  }
}

export function pickProxy() {
  if (!proxies.length) throw new Error('Proxies not loaded yet');
  if (proxies.length === 1) return proxies[0];
  const pool = lastProxy ? proxies.filter(p => p !== lastProxy) : proxies;
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  lastProxy = chosen;
  return chosen;
}

export function applyGlobalProxy(proxyRaw) {
  const url = /^https?:\/\//i.test(proxyRaw) ? proxyRaw : `http://${proxyRaw}`;
  const agent = new HttpsProxyAgent(url);

  axios.defaults.httpsAgent = agent;
  axios.defaults.proxy = false;
  http.globalAgent = agent;
  https.globalAgent = agent;

  return agent;
}

export async function withProxyAgent(cb, retries = 3) {
  let attempt = 0;
  while (attempt < retries) {
    const proxy = pickProxy();
    const agent = applyGlobalProxy(proxy);
    try {
      return await cb(agent, proxy);
    } catch (err) {
      console.log(yellow(`⚠️ Proxy failed [${proxy}] — ${err.message}. Retrying...`));
      attempt++;
      if (attempt >= retries) throw err;
    }
  }
}
