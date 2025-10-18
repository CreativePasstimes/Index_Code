// utils.js
import { readFile } from 'fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * A small list of “worth‐checking” clothing names.
 * Used in the inventory checker to highlight rare items.
 */
const clothworth = [
  "Spiked Collar",
  "Elf Tail Armor",
  "Spiked Wrist",
  "Magenta",
  "Headdress",
  "Tiki",
  "Phantom Beanie"
];

/**
 * Prompt the user on the command line and return their answer.
 */
export async function askQuestion(prompt) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(prompt);
  rl.close();
  return answer;
}

/**
 * Check if a given item name matches one of our “worth checking” patterns.
 */
export function CheckClothWorth(name) {
  if (typeof name !== 'string') return false;
  return clothworth.some(c => name.includes(c));
}

/**
 * Parse a JSON string into an object.
 */
export async function loadJson(data) {
  return JSON.parse(data);
}

/**
 * Read a JSON file off disk and parse it.
 */
export async function loadJsonFile(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

/**
 * Simple async sleep.
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}