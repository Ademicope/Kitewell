import * as StellarSdk from "@stellar/stellar-sdk";
import { fetchAccountViaApi, fetchPaymentsViaApi } from "./api";
import {
  getActiveNetwork,
  getActiveNetworkId,
  isFriendbotAvailable,
} from "./network";

function getServer() {
  return new StellarSdk.Horizon.Server(getActiveNetwork().horizonUrl);
}

/** The Kitewell backend is configured for Testnet, so skip it elsewhere. */
function backendIsUsable() {
  return getActiveNetworkId() === "TESTNET";
}

export function explorerAccountUrl(publicKey) {
  return `${getActiveNetwork().explorerBase}/account/${publicKey}`;
}

export function explorerTxUrl(hash) {
  return `${getActiveNetwork().explorerBase}/tx/${hash}`;
}

export const MAX_ASSET_CODE_LENGTH = 12;

/** Stellar account flag bits (from Stellar's `AccountFlags`). */
export const ACCOUNT_FLAG_BITS = {
  authRequired: 1,
  authRevocable: 2,
  authImmutable: 4,
};

/** Auth immutable is irreversible, so the UI demands an explicit confirmation. */
export const IMMUTABLE_CONFIRMATION = "IMMUTABLE";
export const MAX_HOME_DOMAIN_BYTES = 32;

/**
 * Normalize the account flag fields Horizon exposes (snake_case) into the
 * camelCase shape the UI works with.
 */
export function mapAccountAuthConfig(account = {}) {
  const flags = account.flags || {};
  return {
    authRequired: Boolean(flags.auth_required ?? flags.authRequired),
    authRevocable: Boolean(flags.auth_revocable ?? flags.authRevocable),
    authImmutable: Boolean(flags.auth_immutable ?? flags.authImmutable),
    homeDomain: account.home_domain ?? account.homeDomain ?? "",
  };
}

/**
 * Read the current issuer flags + home domain straight from Horizon. The
 * backend account cache does not carry flags, so this path always goes direct.
 */
export async function getAccountAuthConfig(publicKey) {
  const account = await getServer().loadAccount(publicKey);
  return mapAccountAuthConfig(account);
}

/**
 * Pure validator/build step for a `setOptions` operation body.
 *
 * Flags are expressed as changes relative to `current`, so toggle controls can
 * send only the bits that actually change. Turning immutable on needs the
 * literal confirmation word, and turning it off is refused outright once it is
 * reported as set — it cannot be undone on-chain.
 */
export function buildSetOptionsBody({
  current = {},
  homeDomain,
  authRequired,
  authRevocable,
  authImmutable,
  immutableConfirmation = "",
} = {}) {
  const currentRequired = Boolean(current.authRequired);
  const currentRevocable = Boolean(current.authRevocable);
  const currentImmutable = Boolean(current.authImmutable);

  const wantRequired =
    authRequired === undefined ? currentRequired : Boolean(authRequired);
  const wantRevocable =
    authRevocable === undefined ? currentRevocable : Boolean(authRevocable);
  const wantImmutable =
    authImmutable === undefined ? currentImmutable : Boolean(authImmutable);

  if (currentImmutable && !wantImmutable) {
    throw new Error("Auth immutable cannot be turned off once it is set.");
  }

  let setFlags = 0;
  let clearFlags = 0;

  if (wantRequired !== currentRequired) {
    const bit = ACCOUNT_FLAG_BITS.authRequired;
    if (wantRequired) setFlags |= bit;
    else clearFlags |= bit;
  }
  if (wantRevocable !== currentRevocable) {
    const bit = ACCOUNT_FLAG_BITS.authRevocable;
    if (wantRevocable) setFlags |= bit;
    else clearFlags |= bit;
  }
  if (wantImmutable && !currentImmutable) {
    if (immutableConfirmation !== IMMUTABLE_CONFIRMATION) {
      throw new Error("Type IMMUTABLE to confirm turning on auth immutable.");
    }
    setFlags |= ACCOUNT_FLAG_BITS.authImmutable;
  }

  let normalizedHomeDomain;
  if (homeDomain !== undefined && homeDomain !== null) {
    normalizedHomeDomain = String(homeDomain).trim();
    if (
      new TextEncoder().encode(normalizedHomeDomain).length >
      MAX_HOME_DOMAIN_BYTES
    ) {
      throw new Error(
        `Home domain must be ${MAX_HOME_DOMAIN_BYTES} bytes or fewer.`
      );
    }
  }

  return {
    ...(normalizedHomeDomain !== undefined
      ? { homeDomain: normalizedHomeDomain }
      : {}),
    ...(setFlags ? { setFlags } : {}),
    ...(clearFlags ? { clearFlags } : {}),
  };
}

/**
 * List the accounts that hold assets issued by `publicKey`.
 *
 * Holder rows must come from Horizon's accounts-for-asset endpoint
 * (`/accounts?asset=CODE:ISSUER`); the `/assets?asset_issuer=…` response only
 * carries asset stats and has no holder account to authorize or revoke. When
 * `assetCode` is omitted the issuer's asset codes are discovered from that
 * stats endpoint, then each code is resolved through accounts-for-asset.
 */
export async function getIssuedAssetTrustlines(publicKey, assetCode) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Connect a valid Freighter address first.");
  }

  let codes;
  if (assetCode !== undefined && assetCode !== null) {
    const normalized = String(assetCode).trim().toUpperCase();
    if (!normalized || normalized.length > MAX_ASSET_CODE_LENGTH) {
      throw new Error(
        `Asset code must be 1–${MAX_ASSET_CODE_LENGTH} characters.`
      );
    }
    codes = [normalized];
  } else {
    const response = await getServer()
      .assets()
      .forIssuer(publicKey)
      .limit(200)
      .call();
    codes = [
      ...new Set((response.records || []).map((record) => record.asset_code)),
    ];
  }

  const rows = [];
  for (const code of codes) {
    const asset = new StellarSdk.Asset(code, publicKey);
    const response = await getServer()
      .accounts()
      .forAsset(asset)
      .limit(200)
      .call();

    for (const account of response.records || []) {
      const holder = account.account_id ?? account.id;
      const balance = (account.balances || []).find(
        (entry) =>
          entry.asset_code === code && entry.asset_issuer === publicKey
      );

      rows.push({
        key: `${code}:${holder}`,
        assetCode: code,
        assetIssuer: publicKey,
        holder,
        balance: balance?.balance ?? "0",
        limit: balance?.limit ?? null,
        isAuthorized:
          typeof balance?.is_authorized === "boolean"
            ? balance.is_authorized
            : null,
      });
    }
  }

  return rows;
}

/**
 * Convert a simple UI asset descriptor into an SDK Asset.
 * Native XLM is `{ isNative: true }`; a credit asset is
 * `{ isNative: false, code, issuer }`. Throws a user-facing error when the
 * descriptor is incomplete so callers can surface it in a toast.
 */
export function buildAsset({ isNative, code, issuer } = {}) {
  if (isNative) return StellarSdk.Asset.native();

  const normalizedCode = (code || "").trim();
  if (!normalizedCode) {
    throw new Error("Asset code is required for a credit asset.");
  }
  if (normalizedCode.length > MAX_ASSET_CODE_LENGTH) {
    throw new Error(
      `Asset code must be ${MAX_ASSET_CODE_LENGTH} characters or fewer.`
    );
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(issuer)) {
    throw new Error("Asset issuer must be a valid Stellar public key (G…).");
  }

  return new StellarSdk.Asset(normalizedCode.toUpperCase(), issuer);
}

/**
 * Parse a comma-separated intermediate path (e.g. `USDC:G…, XLM`) into SDK
 * Assets. An empty string yields an empty path, which lets Horizon route
 * through the direct order book.
 */
export function parsePathAssets(input) {
  if (!input) return [];

  return input
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (/^(xlm|native)$/i.test(entry)) return StellarSdk.Asset.native();

      const [code, issuer] = entry.split(":").map((part) => part.trim());
      if (!issuer) {
        throw new Error(
          `Path asset "${entry}" needs an issuer as CODE:ISSUER, or use XLM.`
        );
      }
      return buildAsset({ isNative: false, code, issuer });
    });
}

export async function fundWithFriendbot(publicKey) {
  if (!isFriendbotAvailable()) {
    throw new Error(
      `Friendbot is only available on Testnet, not ${getActiveNetwork().label}.`
    );
  }

  const response = await fetch(
    `${getActiveNetwork().friendbotUrl}?addr=${encodeURIComponent(publicKey)}`
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      text.includes("already") || response.status === 400
        ? "Account may already be funded. Refresh balances instead."
        : "Friendbot funding failed. Try again in a moment."
    );
  }
  return response.json();
}

function mapHorizonBalances(account) {
  return account.balances.map((b) => {
    if (b.asset_type === "liquidity_pool_shares") {
      return {
        key: `pool:${b.liquidity_pool_id}`,
        code: "POOL",
        issuer: null,
        balance: b.balance,
        limit: null,
        isNative: false,
        isPoolShare: true,
        poolId: b.liquidity_pool_id,
      };
    }
    if (b.asset_type === "native") {
      return {
        key: "native",
        code: "XLM",
        issuer: null,
        balance: b.balance,
        limit: null,
        isNative: true,
      };
    }
    return {
      key: `${b.asset_code}:${b.asset_issuer}`,
      code: b.asset_code,
      issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
      isNative: false,
    };
  });
}

/** Prefer the Kitewell backend on Testnet; otherwise read Horizon directly. */
export async function getAccountBalances(publicKey) {
  if (backendIsUsable()) {
    try {
      const data = await fetchAccountViaApi(publicKey);
      return data.balances;
    } catch {
      /* fall back to direct Horizon */
    }
  }

  const account = await getServer().loadAccount(publicKey);
  return mapHorizonBalances(account);
}

export async function getAccountDetails(publicKey) {
  if (backendIsUsable()) {
    try {
      return await fetchAccountViaApi(publicKey);
    } catch {
      /* fall back to direct Horizon */
    }
  }

  const account = await getServer().loadAccount(publicKey);
  return {
    id: account.id,
    sequence: account.sequenceNumber(),
    subentryCount: account.subentry_count,
    thresholds: account.thresholds,
    balances: mapHorizonBalances(account),
    explorerUrl: explorerAccountUrl(publicKey),
  };
}

export async function getBalance(publicKey) {
  const balances = await getAccountBalances(publicKey);
  const xlm = balances.find((b) => b.isNative);
  return xlm ? xlm.balance : "0";
}

/**
 * Load one liquidity pool (both reserves and total shares) from Horizon.
 *
 * @param {string} poolId Horizon liquidity-pool id (`hex`).
 * @returns {Promise<object>} The Horizon liquidity-pool record.
 */
export async function getLiquidityPool(poolId) {
  if (typeof poolId !== "string" || !poolId) {
    throw new Error("A liquidity pool id is required.");
  }

  return getServer().liquidityPools().liquidityPoolId(poolId).call();
}

/**
 * Load one page of payment history.
 *
 * @param {string} publicKey Account to page through.
 * @param {number} [limit] Page size; Horizon caps it at 50 server-side.
 * @param {string} [cursor] `nextCursor` from the previous page; omit for the
 *   first page.
 * @returns {Promise<{ records: object[], nextCursor: string|null }>} The
 *   mapped records plus the cursor for the next page (null on the last page).
 */
export async function getTransactions(publicKey, limit = 15, cursor) {
  if (backendIsUsable()) {
    try {
      return await fetchPaymentsViaApi(publicKey, limit, cursor);
    } catch {
      /* fall back to direct Horizon */
    }
  }

  const payments = await getServer()
    .payments()
    .forAccount(publicKey)
    .limit(limit)
    .order("desc")
    .call();

  return {
    records: payments.records
      .filter((p) => p.type === "payment")
      .map((p) => ({
        id: p.id,
        from: p.from,
        to: p.to,
        amount: p.amount,
        asset_type: p.asset_type,
        asset_code: p.asset_code || "XLM",
        transaction_hash: p.transaction_hash,
        created_at: p.created_at,
      })),
    // Paging straight off Horizon is out of scope, so this path is the last page.
    nextCursor: null,
  };
}

/**
 * Fetch a complete account snapshot from Horizon.
 *
 * @param {string} publicKey The account to snapshot.
 * @returns {Promise<object>} A comprehensive account snapshot including id,
 *   sequence, balances, signers, thresholds, data entries, offers, and
 *   subentry count. Secrets and signed XDR are never included.
 */
export async function getAccountSnapshot(publicKey) {
  if (!publicKey || typeof publicKey !== "string") {
    throw new Error("Public key is required.");
  }

  const account = await getServer().loadAccount(publicKey);

  // Fetch offers for this account
  let offers = [];
  try {
    const offersResponse = await getServer()
      .offers()
      .forAccount(publicKey)
      .limit(200)
      .call();
    offers = offersResponse.records.map((offer) => ({
      id: offer.id,
      selling: offer.selling,
      buying: offer.buying,
      amount: offer.amount,
      price: offer.price,
      price_r: offer.price_r,
    }));
  } catch {
    // Offers are optional; if fetch fails, continue with empty array
    offers = [];
  }

  // Process data entries, converting non-UTF-8 values to hex
  const dataEntries = {};
  if (account.data_attr) {
    Object.entries(account.data_attr).forEach(([key, value]) => {
      try {
        // Try to decode as UTF-8
        const decoded = Buffer.from(value, "base64").toString("utf8");
        // Check if it round-trips correctly (is valid UTF-8)
        if (Buffer.from(decoded, "utf8").toString("base64") === value) {
          dataEntries[key] = decoded;
        } else {
          // Not valid UTF-8, store as hex
          dataEntries[key] = Buffer.from(value, "base64").toString("hex");
        }
      } catch {
        // If decoding fails, store as hex
        dataEntries[key] = Buffer.from(value, "base64").toString("hex");
      }
    });
  }

  return {
    id: account.id,
    sequence: account.sequenceNumber(),
    subentryCount: account.subentry_count,
    thresholds: {
      low: account.thresholds.low_threshold,
      medium: account.thresholds.med_threshold,
      high: account.thresholds.high_threshold,
    },
    signers: account.signers.map((signer) => ({
      key: signer.key,
      weight: signer.weight,
      type: signer.type,
    })),
    balances: mapHorizonBalances(account),
    data: dataEntries,
    offers,
    network: getActiveNetworkId(),
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Download an account snapshot as a JSON file.
 *
 * @param {string} publicKey The account to snapshot.
 */
export async function downloadAccountSnapshot(publicKey) {
  const snapshot = await getAccountSnapshot(publicKey);

  const filename = `kitewell-account-${snapshot.id.slice(0, 8)}-${Date.now()}.json`;
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}
