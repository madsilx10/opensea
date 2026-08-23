const fs = require('fs');

const WALLET_FILE = 'wallet.txt';
const OUTPUT_FILE = 'result.txt';
const DELAY_MS = 1000; // jeda antar request, naikin kalau kena rate limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkWallet(address) {
  try {
    const res = await fetch('https://www.mudlarknft.com/api/checker', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });

    const data = await res.json().catch(() => null);
    return { address, status: res.status, result: data };
  } catch (err) {
    return { address, status: 'ERROR', result: err.message };
  }
}

async function main() {
  const wallets = fs
    .readFileSync(WALLET_FILE, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  console.log(`Total wallet: ${wallets.length}`);

  const results = [];

  for (let i = 0; i < wallets.length; i++) {
    const address = wallets[i];
    const res = await checkWallet(address);

    const line = `${res.address} -> ${JSON.stringify(res.result)}`;
    console.log(`[${i + 1}/${wallets.length}] ${line}`);
    results.push(line);

    if (i < wallets.length - 1) await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUTPUT_FILE, results.join('\n'));
  console.log(`\nSelesai. Hasil disimpan di ${OUTPUT_FILE}`);
}

main();
