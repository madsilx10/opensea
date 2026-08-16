/**
 * mint.js — OpenSea SeaDrop Mint Bot
 * Extend dari cekelig.js — flow: SIWE login -> cek eligible -> fetch calldata -> sign & submit tx
 * Auto-detect chain dari collection, pilih RPC otomatis dari .env
 *
 * Input  : wallet.txt (1 privkey per baris)
 * Config : .env (lihat contoh di bawah)
 *
 * .env contoh:
 *   RPC_URL_ETHEREUM=https://eth-mainnet.g.alchemy.com/v2/KEY
 *   RPC_URL_BASE=https://base-mainnet.g.alchemy.com/v2/KEY
 *   RPC_URL_POLYGON=https://polygon-mainnet.g.alchemy.com/v2/KEY
 *   RPC_URL_ARBITRUM=https://arb-mainnet.g.alchemy.com/v2/KEY
 *   RPC_URL_OPTIMISM=https://opt-mainnet.g.alchemy.com/v2/KEY
 *   RPC_URL_ROBINHOOD=https://robinhoodchain.rpc.url
 *   RPC_URL_ZORA=https://rpc.zora.energy
 *
 * Install: npm install axios ethers dotenv
 * Run    : node mint.js
 */

require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const axios = require("axios");
const { ethers } = require("ethers");

// ─── CHAIN MAP ────────────────────────────────────────────────────────────────
// .env cukup: ETHEREUM=https://... BASE=https://... ROBINHOOD=https://... dst
const CHAIN_MAP = {
  ethereum          : { envKey: "ETHEREUM",  chainId: 1       },
  base              : { envKey: "BASE",      chainId: 8453    },
  polygon           : { envKey: "POLYGON",   chainId: 137     },
  arbitrum          : { envKey: "ARBITRUM",  chainId: 42161   },
  optimism          : { envKey: "OPTIMISM",  chainId: 10      },
  robinhood         : { envKey: "ROBINHOOD", chainId: 4663    },
  zora              : { envKey: "ZORA",      chainId: 7777777 },
  avalanche         : { envKey: "AVALANCHE", chainId: 43114   },
  blast             : { envKey: "BLAST",     chainId: 81457   },
  // alias kalau OpenSea kasih nama beda
  "ethereum-mainnet": { envKey: "ETHEREUM",  chainId: 1       },
  "base-mainnet"    : { envKey: "BASE",      chainId: 8453    },
};

// Public RPC fallback kalau .env gak ada — lebih lambat tapi tetap jalan
const PUBLIC_RPC = {
  ethereum  : "https://eth.llamarpc.com",
  base      : "https://mainnet.base.org",
  polygon   : "https://polygon-rpc.com",
  arbitrum  : "https://arb1.arbitrum.io/rpc",
  optimism  : "https://mainnet.optimism.io",
  zora      : "https://rpc.zora.energy",
  robinhood : "https://peel.rpc.robinhood.com",
};

// ─── GRAPHQL HASHES ───────────────────────────────────────────────────────────
const MINT_MODULE_HASH   = "98b96c9357f51630dc14c3bcab0de47684337a0aa726277b82820d6ee354217d";
const ELIG_HASH          = "e1b54354df0d26d39c6b81429bd5e5d37749eaa4bdc027f987128f8c1e7d2308";
const MINT_TIMELINE_HASH = "4e1ef4c8393b2025b5e9a72621b61af83b1bb2d6cf1c5614ef0f4be7d0c2cde8";
const COLLECTION_HASH    = "a3ef324c1a5ec024ef99614e3ba09d7eff6e7706e5a62cc0aaff1394a28b1de7"; // CollectionQuery — buat detect chain

const DOMAIN       = "opensea.io";
const CONNECTOR_ID = "io.metamask";

const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const RESET  = "\x1b[0m";

const BASE_HEADERS = {
  "content-type"   : "application/json",
  accept           : "application/graphql-response+json, application/graphql+json, application/json",
  "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  origin           : "https://opensea.io",
  referer          : "https://opensea.io/",
  "user-agent"     : "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
};

let COLLECTION_SLUG = "";
let COLLECTION_URI  = "";
let CHAIN_NAME      = "";  // diisi otomatis setelah detectChain()
let CHAIN_ID        = 1;   // diisi otomatis
let RPC_URL         = "";  // diisi otomatis

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function loadWallets() {
  return fs.readFileSync("./wallet.txt", "utf8")
    .split("\n").map(l => l.trim()).filter(Boolean)
    .map(pk => {
      const key    = pk.startsWith("0x") ? pk : `0x${pk}`;
      const wallet = new ethers.Wallet(key);
      return { privateKey: key, address: wallet.address };
    });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function parseSlugFromInput(input) {
  const match = input.match(/collection\/([^/?#]+)/);
  return match ? match[1] : input;
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
  const newParts   = (setCookieArr || []).map(c => c.split(";")[0]);
  const existingMap = {};
  for (const part of (existingJar ? existingJar.split("; ") : [])) {
    const [k] = part.split("=");
    if (k) existingMap[k] = part;
  }
  for (const part of newParts) {
    const [k] = part.split("=");
    if (k) existingMap[k] = part;
  }
  return Object.values(existingMap).join("; ");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getRpcForChain(chainName) {
  const key  = chainName.toLowerCase();
  const info = CHAIN_MAP[key];
  if (!info) return null;

  // Coba ambil dari .env dulu
  const fromEnv = process.env[info.envKey];
  if (fromEnv) return { rpc: fromEnv, chainId: info.chainId };

  // Fallback ke public RPC
  const pub = PUBLIC_RPC[key];
  if (pub) {
    console.log(`${YELLOW}[!] ${info.envKey}= tidak ada di .env, pakai public RPC (lebih lambat)${RESET}`);
    return { rpc: pub, chainId: info.chainId };
  }

  return null;
}

// ─── DETECT CHAIN OTOMATIS ────────────────────────────────────────────────────
async function detectChain() {
  const variables  = JSON.stringify({ collectionSlug: COLLECTION_SLUG });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: COLLECTION_HASH, version: 1 } });
  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=CollectionQuery&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;

  const res = await axios.get(url, { headers: BASE_HEADERS, validateStatus: () => true });

  // Coba ambil chain dari berbagai path response
  const col  = res.data?.data?.collection || res.data?.data?.collectionBySlug;
  let chain  = col?.chain
    || col?.defaultChain
    || col?.nativeChain
    || res.data?.data?.dropBySlug?.chain
    || null;

  if (!chain) {
    // Coba dari MintModuleQuery yang udah ada
    const vars2 = JSON.stringify({ collectionSlug: COLLECTION_SLUG });
    const ext2  = JSON.stringify({ persistedQuery: { sha256Hash: MINT_MODULE_HASH, version: 1 } });
    const url2  = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=MintModuleQuery&variables=${encodeURIComponent(vars2)}&extensions=${encodeURIComponent(ext2)}`;
    const res2  = await axios.get(url2, { headers: BASE_HEADERS, validateStatus: () => true });
    chain = res2.data?.data?.dropBySlug?.chain || null;
  }

  if (!chain) throw new Error("Gagal detect chain collection — coba input chain manual");

  return chain.toLowerCase();
}

// ─── SETUP ────────────────────────────────────────────────────────────────────
async function selectCollection() {
  let input = "";
  while (!input) input = await ask("Link/slug collection: ");
  COLLECTION_SLUG = parseSlugFromInput(input);
  COLLECTION_URI  = `https://opensea.io/collection/${COLLECTION_SLUG}/overview`;
  console.log(`[*] Collection: ${COLLECTION_SLUG}`);

  // Detect chain otomatis
  process.stdout.write(`[*] Detect chain... `);
  try {
    CHAIN_NAME = await detectChain();
    const rpcInfo = getRpcForChain(CHAIN_NAME);
    if (!rpcInfo) {
      // Chain diketahui tapi belum ada di map — minta manual
      console.log(`${YELLOW}chain "${CHAIN_NAME}" belum ada di config${RESET}`);
      const manualRpc = await ask(`RPC URL untuk chain "${CHAIN_NAME}": `);
      RPC_URL  = manualRpc;
      CHAIN_ID = parseInt(await ask(`Chain ID untuk "${CHAIN_NAME}": `), 10) || 1;
    } else {
      RPC_URL  = rpcInfo.rpc;
      CHAIN_ID = rpcInfo.chainId;
      console.log(`${GREEN}${CHAIN_NAME} (chainId: ${CHAIN_ID})${RESET}`);
    }
  } catch (e) {
    console.log(`${YELLOW}gagal (${e.message})${RESET}`);
    const manualRpc = await ask(`Input RPC URL manual: `);
    const manualId  = await ask(`Chain ID manual (misal 1=ETH, 8453=Base): `);
    RPC_URL  = manualRpc;
    CHAIN_ID = parseInt(manualId, 10) || 1;
    CHAIN_NAME = "unknown";
  }

  console.log(`[*] RPC: ${RPC_URL.slice(0, 50)}...`);
}

async function selectWallets(wallets) {
  console.log(`\nTotal wallet: ${wallets.length}`);
  console.log("  1) 1 akun\n  2) semua\n  3) from x to end");
  const mode = await ask("Pilihan (1/2/3): ");
  if (mode === "1") {
    const idx = parseInt(await ask(`Nomor akun (1-${wallets.length}): `), 10);
    return [wallets[idx - 1]];
  }
  if (mode === "2") return wallets;
  if (mode === "3") {
    const from = parseInt(await ask(`Mulai dari nomor: `), 10);
    return wallets.slice(from - 1);
  }
  throw new Error("Pilihan tidak valid");
}

async function askMintParams() {
  const qtyStr  = await ask("Jumlah mint per wallet (default 1): ");
  const quantity = parseInt(qtyStr) || 1;

  console.log("\nJenis stage yang mau di-mint:");
  console.log("  1) Semua stage yang eligible (WL + FCFS + public)");
  console.log("  2) Public mint aja");
  console.log("  3) WL/allowlist aja");
  const stageMode = await ask("Pilihan (1/2/3): ");

  return { quantity, stageMode };
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function loginWallet({ address, privateKey }) {
  const wallet = new ethers.Wallet(privateKey);

  let cookieJar = "";
  const pageRes = await axios.get(COLLECTION_URI, {
    headers: { ...BASE_HEADERS, accept: "text/html,application/xhtml+xml", cookie: "" },
    validateStatus: () => true,
  });
  cookieJar = mergeCookies(cookieJar, pageRes.headers["set-cookie"]);

  const nonceRes = await axios.post("https://opensea.io/__api/auth/siwe/nonce", {}, {
    headers: { ...BASE_HEADERS, cookie: cookieJar },
    validateStatus: () => true,
  });
  if (nonceRes.status !== 200) throw new Error(`nonce failed: ${nonceRes.status}`);
  const nonce = nonceRes.data.nonce;
  cookieJar = mergeCookies(cookieJar, nonceRes.headers["set-cookie"]);

  const checksumAddr = ethers.getAddress(address);
  const statement    = `Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).`;
  const issuedAt     = new Date().toISOString();

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

  const verifyRes = await axios.post("https://opensea.io/__api/auth/siwe/verify", {
    message: { accountType: "Ethereum", address: checksumAddr, chainId: String(CHAIN_ID),
      domain: DOMAIN, issuedAt, nonce, statement, uri: COLLECTION_URI, version: "1" },
    chainArch: "EVM", connectorId: CONNECTOR_ID, signature,
  }, {
    headers: { ...BASE_HEADERS, cookie: cookieJar },
    validateStatus: () => true,
  });
  if (verifyRes.status !== 200) throw new Error(`verify failed: ${verifyRes.status}`);

  cookieJar = mergeCookies(cookieJar, verifyRes.headers["set-cookie"]);
  const accessToken = extractCookie(verifyRes.headers["set-cookie"] || [], "access_token");
  if (!accessToken) throw new Error("access_token tidak ditemukan");

  cookieJar = mergeCookies(cookieJar, [
    `connected-account-server-hint=${checksumAddr.toLowerCase()}`,
    `auth_access_hint=true`,
  ]);

  return { accessToken, cookieJar };
}

// ─── ELIGIBILITY ──────────────────────────────────────────────────────────────
async function getStageLabels() {
  const variables  = JSON.stringify({ collectionSlug: COLLECTION_SLUG });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: MINT_MODULE_HASH, version: 1 } });
  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=MintModuleQuery&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;
  try {
    const res    = await axios.get(url, { headers: BASE_HEADERS, validateStatus: () => true });
    const stages = res.data?.data?.dropBySlug?.stages || [];
    const map    = {};
    for (const s of stages) map[s.stageIndex] = s.label;
    return map;
  } catch { return {}; }
}

async function checkEligibility(address, cookieJar, stageLabels) {
  const variables  = JSON.stringify({ address, collectionSlug: COLLECTION_SLUG });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: ELIG_HASH, version: 1 } });
  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=DropEligibilityQuery&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;

  const res = await axios.get(url, { headers: { ...BASE_HEADERS, cookie: cookieJar }, validateStatus: () => true });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  if (res.data.errors) throw new Error(`GraphQL: ${JSON.stringify(res.data.errors)}`);

  const stages = res.data.data?.dropBySlug?.stages || [];
  return stages.map(s => ({
    stage         : stageLabels[s.stageIndex] || s.stageType,
    stageIndex    : s.stageIndex,
    stageType     : s.stageType,
    isEligible    : s.isEligible,
    limitPerWallet: s.eligibleMaxTotalMintableByWallet,
    priceUsd      : s.eligiblePrice?.usd,
  }));
}

// ─── FETCH MINT CALLDATA ──────────────────────────────────────────────────────
async function fetchMintCalldata(address, cookieJar, stageIndex, quantity) {
  const variables  = JSON.stringify({
    collectionSlug: COLLECTION_SLUG,
    address,
    stageIndex,
    quantity,
    action: "MINT",
  });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: MINT_TIMELINE_HASH, version: 1 } });
  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=MintActionTimelineQuery&variables=${encodeURIComponent(variables)}&extensions=${encodeURIComponent(extensions)}`;

  const res = await axios.get(url, {
    headers: { ...BASE_HEADERS, cookie: cookieJar },
    validateStatus: () => true,
  });

  if (res.status !== 200) throw new Error(`calldata HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  if (res.data.errors) throw new Error(`calldata GraphQL: ${JSON.stringify(res.data.errors)}`);

  const drop     = res.data?.data?.dropBySlug;
  const timeline = drop?.mintActionTimeline || drop?.timeline;
  const action   = timeline?.actions?.[0] || timeline?.[0];
  const txData   = action?.transactionSubmissionData || action?.transaction;

  if (!txData) {
    console.log(`    [debug] calldata response: ${JSON.stringify(res.data).slice(0, 500)}`);
    throw new Error("transactionSubmissionData tidak ditemukan di response");
  }

  return {
    to   : txData.toAddress || txData.to,
    data : txData.calldata  || txData.data,
    value: txData.value     || "0",
  };
}

// ─── SUBMIT TRANSAKSI ─────────────────────────────────────────────────────────
async function submitMint(privateKey, txData) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(privateKey, provider);

  const feeData = await provider.getFeeData();
  const nonce   = await provider.getTransactionCount(wallet.address, "latest");

  const tx = {
    to                  : txData.to,
    data                : txData.data,
    value               : BigInt(txData.value),
    nonce,
    maxFeePerGas        : feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    gasLimit            : 300_000n,
  };

  try {
    const estimated = await provider.estimateGas({ ...tx, from: wallet.address });
    tx.gasLimit = (estimated * 120n) / 100n;
    console.log(`    [gas] estimated: ${estimated.toString()}, limit: ${tx.gasLimit.toString()}`);
  } catch (e) {
    console.log(`    [warn] estimateGas gagal (${e.message}), pakai default 300k`);
  }

  const sentTx  = await wallet.sendTransaction(tx);
  console.log(`    [tx] hash: ${sentTx.hash}`);
  console.log(`    [tx] nunggu konfirmasi...`);
  const receipt = await sentTx.wait(1);
  return receipt;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== OpenSea Mint Bot ===\n");

  const allWallets = loadWallets();
  await selectCollection();         // detect chain + RPC otomatis di sini
  const stageLabels = await getStageLabels();
  const selected    = await selectWallets(allWallets);
  const { quantity, stageMode } = await askMintParams();

  console.log(`\n${CYAN}[*] Chain   : ${CHAIN_NAME} (chainId: ${CHAIN_ID})${RESET}`);
  console.log(`${CYAN}[*] Wallet  : ${selected.length}${RESET}`);
  console.log(`${CYAN}[*] Quantity: ${quantity} per wallet${RESET}\n`);

  const results = [];

  for (let i = 0; i < selected.length; i++) {
    const { address, privateKey } = selected[i];
    console.log(`\n[${i + 1}/${selected.length}] ${address}`);

    try {
      process.stdout.write(`    login... `);
      const { cookieJar } = await loginWallet({ address, privateKey });
      console.log(`${GREEN}OK${RESET}`);

      process.stdout.write(`    cek eligible... `);
      const stages = await checkEligibility(address, cookieJar, stageLabels);
      console.log(`${GREEN}OK${RESET}`);

      let targetStages = stages.filter(s => s.isEligible);
      if (stageMode === "2") targetStages = targetStages.filter(s => s.stageType === "PUBLIC");
      if (stageMode === "3") targetStages = targetStages.filter(s => s.stageType !== "PUBLIC");

      if (targetStages.length === 0) {
        console.log(`    ${YELLOW}tidak ada stage eligible yang cocok, skip${RESET}`);
        results.push({ address, status: "skipped", reason: "no eligible stage" });
        await sleep(1500);
        continue;
      }

      console.log(`    eligible di ${targetStages.length} stage: ${targetStages.map(s => s.stage).join(", ")}`);

      const mintResults = [];
      for (const stage of targetStages) {
        console.log(`    [stage ${stage.stageIndex}] ${stage.stage} — fetch calldata...`);
        try {
          const txData  = await fetchMintCalldata(address, cookieJar, stage.stageIndex, quantity);
          console.log(`    [stage ${stage.stageIndex}] calldata OK — to: ${txData.to}, value: ${txData.value}`);

          const receipt = await submitMint(privateKey, txData);
          if (receipt.status === 1) {
            console.log(`    ${GREEN}[stage ${stage.stageIndex}] MINT SUCCESS — block ${receipt.blockNumber}${RESET}`);
            mintResults.push({ stage: stage.stage, txHash: receipt.hash, status: "success" });
          } else {
            console.log(`    ${RED}[stage ${stage.stageIndex}] tx REVERTED${RESET}`);
            mintResults.push({ stage: stage.stage, txHash: receipt.hash, status: "reverted" });
          }
        } catch (e) {
          console.log(`    ${RED}[stage ${stage.stageIndex}] GAGAL: ${e.message}${RESET}`);
          mintResults.push({ stage: stage.stage, status: "error", error: e.message });
        }
        await sleep(1000);
      }

      results.push({ address, status: "done", stages: mintResults });

    } catch (e) {
      console.log(`    ${RED}GAGAL: ${e.message}${RESET}`);
      results.push({ address, status: "error", error: e.message });
    }

    if (i < selected.length - 1) await sleep(2000);
  }

  fs.writeFileSync("mint_results.json", JSON.stringify(results, null, 2));

  const success = results.filter(r =>
    r.status === "done" && r.stages?.some(s => s.status === "success")
  ).length;

  console.log(`\n=== SELESAI ===`);
  console.log(`Berhasil mint: ${success}/${selected.length} wallet`);
  console.log(`Detail: mint_results.json`);
}

main().catch(e => {
  console.error(`${RED}Fatal: ${e.message}${RESET}`);
  process.exit(1);
});
