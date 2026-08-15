/**
 * cekelig.js — OpenSea Drop Eligibility Checker
 * Input: wallet.txt (1 privkey per baris)
 * Output: eligibility_results.json
 */

const fs = require("fs");
const axios = require("axios");
const { ethers } = require("ethers");

const COLLECTION_SLUG = "h00d--r00st"; // ganti sesuai collection target
const PERSISTED_HASH = "e1b54354df0d26d39c6b81429bd5e5d37749eaa4bdc027f987128f8c1e7d2308";

const HEADERS = {
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

async function checkEligibility(address) {
  const variables = JSON.stringify({ address, collectionSlug: COLLECTION_SLUG });
  const extensions = JSON.stringify({ persistedQuery: { sha256Hash: PERSISTED_HASH, version: 1 } });

  const url = `https://gql.opensea.io/graphql?app_id=os2-web&operationName=DropEligibilityQuery&variables=${encodeURIComponent(
    variables
  )}&extensions=${encodeURIComponent(extensions)}`;

  const res = await axios.get(url, { headers: HEADERS, validateStatus: () => true });

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  }
  if (res.data.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(res.data.errors)}`);
  }

  const stages = res.data.data?.dropBySlug?.stages || [];
  return stages.map((s) => ({
    stage: s.stageType,
    stageIndex: s.stageIndex,
    isEligible: s.isEligible,
    limitPerWallet: s.eligibleMaxTotalMintableByWallet,
    priceUsd: s.eligiblePrice?.usd,
  }));
}

async function main() {
  const wallets = loadWallets();
  const results = [];

  for (const { address } of wallets) {
    try {
      console.log(`[*] cek ${address} ...`);
      const stages = await checkEligibility(address);
      const eligibleStages = stages.filter((s) => s.isEligible).map((s) => s.stage);
      console.log(
        eligibleStages.length
          ? `[+] ${address} ELIGIBLE di: ${eligibleStages.join(", ")}`
          : `[-] ${address} NOT ELIGIBLE di stage manapun`
      );
      results.push({ address, success: true, stages });
    } catch (e) {
      console.log(`[-] ${address} FAILED: ${e.message}`);
      results.push({ address, success: false, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  fs.writeFileSync("./eligibility_results.json", JSON.stringify(results, null, 2));
  console.log(`\nDone. Saved to eligibility_results.json`);
}

main();
