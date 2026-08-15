/**
 * cekelig.js — OpenSea Drop Eligibility Checker
 * Flow per wallet: SIWE login (nonce -> sign -> verify) -> pakai access_token -> DropEligibilityQuery
 *
 * Input: wallet.txt (1 privkey per baris)
 * Output: eligibility_results.json
 */

const fs = require("fs");
const readline = require("readline");
const axios = require("axios");
const { ethers } = require("ethers");

const COLLECTION_SLUG_DEFAULT = "h00d--r00st";
let COLLECTION_SLUG = COLLECTION_SLUG_DEFAULT;
let COLLECTION_URI = `https://opensea.io/collection/${COLLECTION_SLUG}/overview`;
const PERSISTED_HASH = "e1b54354df0d26d39c6b81429bd5e5d37749eaa4bdc027f987128f8c1e7d2308";
const DOMAIN = "opensea.io";
const CHAIN_ID = 1;
const CONNECTOR_ID = "io.metamask";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/graphql-response+json, application/graphql+json, application/json, text/event-stream, multipart/mixed",
  "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  origin: "https://opensea.io",
  referer: "https://opensea.io/",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
};

function loadWallets() {
  const lines = fs
    .readFileSync("./wallet.txt", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((pk) => {
    const key = pk.startsWith("0x") ? pk : `0x${pk}`;
    const wallet = new ethers.Wallet(key);
    return { privateKey: key, address: wallet.address };
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function parseSlugFromInput(input) {
  // terima full URL (opensea.io/collection/slug/...) atau slug polos
  const match = input.match(/collection\/([^/?#]+)/);
  return match ? match[1] : input;
}

async function selectCollection() {
  const input = await ask(`Link/slug collection (kosongin buat default "${COLLECTION_SLUG_DEFAULT}"): `);
  if (input) {
    COLLECTION_SLUG = parseSlugFromInput(input);
    COLLECTION_URI = `https://opensea.io/collection/${COLLECTION_SLUG}/overview`;
  }
  console.log(`[*] Collection slug: ${COLLECTION_SLUG}`);
}

async function selectWallets(wallets) {
  console.log(`\nTotal wallet di wallet.txt: ${wallets.length}`);
  console.log("Pilih mode:");
  console.log("  1) 1 akun");
  console.log("  2) semua");
  console.log("  3) from x to end");
  const mode = await ask("Pilihan (1/2/3): ");

  if (mode === "1") {
    const idx = parseInt(await ask(`Nomor akun (1-${wallets.length}): `), 10);
    if (!idx || idx < 1 || idx > wallets.length) throw new Error("Nomor akun invalid");
    return [wallets[idx - 1]];
  }

  if (mode === "2") {
    return wallets;
  }

  if (mode === "3") {
    const from = parseInt(await ask(`Mulai dari nomor (1-${wallets.length}): `), 10);
    if (!from || from < 1 || from > wallets.length) throw new Error("Nomor invalid");
    return wallets.slice(from - 1);
  }

  throw new Error("Pilihan tidak valid");
}

function extractCookie(setCookieArr, name) {
  if (!setCookieArr) return null;
  for (const c of setCookieArr) {
    const match = c.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

function mergeCookies(existingJar, setCookieArr) {
  const newParts = (setCookieArr || []).map((c) => c.split(";")[0]);
  const existingMap = {};
  for (const part of (existingJar ? existingJar.split("; ") : [])) {
    const [k] = part.split("=");
    if (k) existingMap[k] = part;
  }
  for (const part of newParts) {
    const [k] = part.split("=");
    if (k) existingMap[k] = part; // overwrite kalau sama key (misal cookie di-refresh)
  }
  return Object.values(existingMap).join("; ");
}

async function loginWallet({ address, privateKey }) {
  const wallet = new ethers.Wallet(privateKey);

  // step 0: buka halaman collection dulu buat ambil cookie awal (cf_bm, os2AccessEx, dll)
  let cookieJar = "";
  const pageRes = await axios.get(COLLECTION_URI, {
    headers: { ...HEADERS, accept: "text/html,application/xhtml+xml", cookie: "" },
    validateStatus: () => true,
  });
  cookieJar = mergeCookies(cookieJar, pageRes.headers["set-cookie"]);

  const nonceRes = await axios.post(
    "https://opensea.io/__api/auth/siwe/nonce",
    {},
    { headers: { ...HEADERS, cookie: cookieJar }, validateStatus: () => true }
  );
  if (nonceRes.status !== 200) throw new Error(`nonce failed: ${nonceRes.status}`);
  const nonce = nonceRes.data.nonce;
  cookieJar = mergeCookies(cookieJar, nonceRes.headers["set-cookie"]);

  const checksumAddr = ethers.getAddress(address);
  const statement = `Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).`;
  const issuedAt = new Date().toISOString();

  // EIP-4361 message, format manual (ganti dependency siwe)
  const messageStr =
    `${DOMAIN} wants you to sign in with your Ethereum account:\n` +
    `${checksumAddr}\n\n` +
    `${statement}\n\n` +
    `URI: ${COLLECTION_URI}\n` +
    `Version: 1\n` +
    `Chain ID: ${CHAIN_ID}\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`;

  const signature = await wallet.signMessage(messageStr);

  const body = {
    message: {
      accountType: "Ethereum",
      address: checksumAddr,
      chainId: String(CHAIN_ID),
      domain: DOMAIN,
      issuedAt,
      nonce,
      statement,
      uri: COLLECTION_URI,
      version: "1",
    },
    chainArch: "EVM",
    connectorId: CONNECTOR_ID,
    signature,
  };

  const verifyRes = await axios.post("https://opensea.io/__api/auth/siwe/verify", body, {
    headers: { ...HEADERS, cookie: cookieJar },
    validateStatus: () => true,
  });
  if (verifyRes.status !== 200) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.data)}`);

  cookieJar = mergeCookies(cookieJar, verifyRes.headers["set-cookie"]);
  const accessToken = extractCookie(verifyRes.headers["set-cookie"] || [], "access_token");
  if (!accessToken) throw new Error("access_token tidak ditemukan di response");

  // tambahin hint cookies yang biasanya ke-set browser tapi gak ada di response header verify
  cookieJar = mergeCookies(cookieJar, [
    `connected-account-server-hint=${checksumAddr.toLowerCase()}`,
    `auth_access_hint=true`,
  ]);

  return { accessToken, cookieJar };
}

async function checkEligibility(address, cookieJar) {
  const variables = JSON.stringify({ address, collectionSlug: COLLECTION_SLUG });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: PERSISTED_HASH, version: 1 } });

  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=DropEligibilityQuery&variables=${encodeURIComponent(
    variables
  )}&extensions=${encodeURIComponent(extensions)}`;

  const res = await axios.get(url, { headers: { ...HEADERS, cookie: cookieJar }, validateStatus: () => true });

  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  if (res.data.errors) throw new Error(`GraphQL error: ${JSON.stringify(res.data.errors)}`);

  const stages = res.data.data?.dropBySlug?.stages || [];
  if (stages.length === 0) {
    console.log(`    [debug] raw response: ${JSON.stringify(res.data)}`);
  }
  return stages.map((s) => ({
    stage: s.stageType,
    stageIndex: s.stageIndex,
    isEligible: s.isEligible,
    limitPerWallet: s.eligibleMaxTotalMintableByWallet,
    priceUsd: s.eligiblePrice?.usd,
  }));
}

async function main() {
  const allWallets = loadWallets();
  await selectCollection();
  const selected = await selectWallets(allWallets);
  const results = [];

  for (let i = 0; i < selected.length; i++) {
    const { address, privateKey } = selected[i];
    try {
      console.log(`\n[${i + 1}/${selected.length}] login ${address} ...`);
      const { cookieJar } = await loginWallet({ address, privateKey });
      console.log(`[${i + 1}/${selected.length}] cek eligibility ${address} ...`);
      const stages = await checkEligibility(address, cookieJar);
      console.log(`    Hasil stage untuk ${address}:`);
      for (const s of stages) {
        const statusText = s.isEligible ? `${GREEN}ELIGIBLE${RESET}` : `${RED}NOT ELIGIBLE${RESET}`;
        console.log(`      - ${s.stage} (stageIndex ${s.stageIndex}): ${statusText} | limit ${s.limitPerWallet} | $${s.priceUsd}`);
      }
      const eligibleStages = stages.filter((s) => s.isEligible).map((s) => s.stage);
      console.log(
        eligibleStages.length
          ? `[+] ${address} ${GREEN}ELIGIBLE${RESET} di: ${eligibleStages.join(", ")}`
          : `[-] ${address} ${RED}NOT ELIGIBLE${RESET} di stage manapun`
      );
      results.push({ address, success: true, stages });
    } catch (e) {
      console.log(`[-] ${address} FAILED: ${e.message}`);
      results.push({ address, success: false, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\nDone. ${results.filter((r) => r.success).length}/${selected.length} berhasil dicek.`);
}

main();
