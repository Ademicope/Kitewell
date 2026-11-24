import * as StellarSdk from "@stellar/stellar-sdk";
import { fetchAccountViaApi, fetchPaymentsViaApi } from "./api";
import { normaliseTxHash } from "./txStatusWatch";
import {
  getActiveNetwork,
  getActiveNetworkId,
  isFriendbotAvailable,
  NETWORKS,
} from "./network";
import { calculateMinimumBalance } from "./accountReserve";

/** Shown in the lab panel when Horizon asks the client to slow down. */
export const HORIZON_SLOWDOWN_MESSAGE =
  "The network asked the lab to slow down.";

const HORIZON_429_BASE_WAIT_SEC = 2;
const HORIZON_429_MAX_WAIT_SEC = 30;

/**
 * Shared per-network 429 backoff clock. Balance and history reads (and any
 * other lab Horizon reads) advance the same streak for the active network.
 * @type {Map<string, { streak: number }>}
 */
const horizon429BackoffByNetwork = new Map();

function getServer() {
  return new StellarSdk.Horizon.Server(getActiveNetwork().horizonUrl);
}

export async function getLatestLedger(networkId = getActiveNetworkId()) {
  const network = NETWORKS[networkId];
  if (!network) {
    throw new Error(`Unsupported network: ${networkId}`);
  }

  const response = await new StellarSdk.Horizon.Server(network.horizonUrl)
    .ledgers()
    .order("desc")
    .limit(1)
    .call();
  const ledger = response.records?.[0];
  if (!ledger) {
    throw new Error("Horizon returned no latest ledger.");
  }

  const sequence = Number(ledger.sequence);
  const closedAt = Date.parse(ledger.closed_at);
  const baseFee = String(ledger.base_fee_in_stroops ?? "");
  const baseReserve = String(ledger.base_reserve_in_stroops ?? "");
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("Latest ledger has an invalid sequence.");
  }
  if (!Number.isFinite(closedAt)) {
    throw new Error("Latest ledger has an invalid close time.");
  }
  if (!/^\d+$/.test(baseFee)) {
    throw new Error("Latest ledger has an invalid base fee.");
  }
  if (!/^[1-9]\d*$/.test(baseReserve)) {
    throw new Error("Latest ledger has an invalid base reserve.");
  }

  return {
    sequence,
    closedAt: new Date(closedAt).toISOString(),
    baseFeeInStroops: baseFee,
    baseReserveInStroops: baseReserve,
  };
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

/**
 * Read Horizon's `/fee_stats` and expose the last ledger's charged-fee mode and
 * the p10/p99 percentiles used by the fee selector.
 *
 * @returns {Promise<{mode: string, p10: string, p99: string, lastLedger: string|null}>}
 */
export async function getFeeStats() {
  const stats = await getServer().feeStats();
  const charged = stats?.fee_charged ?? {};
  const fallback = String(
    stats?.last_ledger_base_fee ?? StellarSdk.BASE_FEE
  );

  return {
    mode: String(charged.mode ?? fallback),
    p10: String(charged.p10 ?? fallback),
    p99: String(charged.p99 ?? fallback),
    lastLedger: stats?.last_ledger ? String(stats.last_ledger) : null,
  };
}

export const MAX_ASSET_CODE_LENGTH = 12;
export const MAX_DATA_NAME_BYTES = 64;
export const MAX_DATA_VALUE_BYTES = 64;

export function utf8ByteLength(value) {
  return new TextEncoder().encode(value == null ? "" : String(value)).length;
}

export function validateDataName(name) {
  const normalized = String(name ?? "");
  if (!normalized) throw new Error("Data name is required.");
  if (utf8ByteLength(normalized) > MAX_DATA_NAME_BYTES) {
    throw new Error("Data name must be 64 UTF-8 bytes or fewer.");
  }
  return normalized;
}

export function validateDataValue(value) {
  const normalized = value == null ? "" : String(value);
  if (utf8ByteLength(normalized) > MAX_DATA_VALUE_BYTES) {
    throw new Error("Data value must be 64 UTF-8 bytes or fewer.");
  }
  return normalized;
}

export function formatDataValue(value) {
  if (value == null) return "";

  let bytes;
  if (typeof value === "string") {
    try {
      const binary = atob(value);
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      bytes = new TextEncoder().encode(value);
    }
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    bytes = new TextEncoder().encode(String(value));
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export function mapAccountDataEntries(account) {
  if (Array.isArray(account?.dataEntries)) {
    return account.dataEntries
      .filter((entry) => entry && typeof entry.name === "string")
      .map((entry) => ({ name: entry.name, value: entry.value }));
  }

  let data = account?.data_attr;
  if ((!data || typeof data !== "object") && typeof account?.data === "function") {
    data = account.data();
  } else if ((!data || typeof data !== "object") && account?.data && typeof account.data === "object") {
    data = account.data;
  }
  if (!data || typeof data !== "object") return [];
  return Object.entries(data)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
}

export const getAccountDataEntries = mapAccountDataEntries;
export const formatAccountDataValue = formatDataValue;
export const validateManageDataName = validateDataName;
export const validateManageDataValue = validateDataValue;

export function validateAccountMerge(source, destination, retypeDestination) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(source)) {
    throw new Error("Connect a valid Freighter address first.");
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(destination)) {
    throw new Error("Destination must be a valid Stellar public key (G…).");
  }
  if (destination === source) {
    throw new Error("The destination account cannot be the connected account.");
  }
  if (retypeDestination !== destination) {
    throw new Error("Retype the destination public key exactly as it appears.");
  }
  return destination;
}

export function mergeBlockersFromAccount(account) {
  const blockers = [];

  const trustlines = (account?.balances || []).filter(
    (balance) =>
      balance &&
      (balance.asset_type === "credit_alphanum4" ||
        balance.asset_type === "credit_alphanum12" ||
        (balance.isNative === false && Boolean(balance.code || balance.asset_code)))
  );
  if (trustlines.length) {
    blockers.push(
      `Trustlines: ${trustlines
        .map((balance) => balance.asset_code || balance.code || "unknown")
        .join(", ")}`
    );
  }

  if (Array.isArray(account?.signers) && account.signers.length > 1) {
    blockers.push(
      `Signers: ${account.signers
        .map((signer) => signer.key)
        .filter(Boolean)
        .join(", ")}`
    );
  }

  const offers = Array.isArray(account?.offers)
    ? account.offers
    : Array.isArray(account?.openOffers)
      ? account.openOffers
      : [];
  if (offers.length) {
    blockers.push(
      `Offers: ${offers
        .map((offer) => offer.id)
        .filter(Boolean)
        .join(", ") || `${offers.length} open offer(s)`}`
    );
  }

  return blockers;
}

export async function getAccountMergeBlockers(publicKey) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Connect a valid Freighter address first.");
  }

  let account;
  if (backendIsUsable()) {
    try {
      account = await fetchAccountViaApi(publicKey);
    } catch {
      account = await getServer().loadAccount(publicKey);
    }
  } else {
    account = await getServer().loadAccount(publicKey);
  }

  try {
    const page = await getServer()
      .offers()
      .forSeller(publicKey)
      .limit(200)
      .order("asc")
      .call();
    account = { ...account, offers: page.records || page };
  } catch {
    account = { ...account, offers: account.offers || [] };
  }

  return mergeBlockersFromAccount(account);
}

export const accountMergeBlockers = mergeBlockersFromAccount;
export const validateAccountMergeDestination = validateAccountMerge;

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

/** Read the public Horizon order book for a validated pair of SDK assets. */
export async function getOrderBook(selling, buying) {
  if (!selling || !buying) {
    throw new Error("Choose two different valid assets for the order book.");
  }
  if (selling.equals(buying)) {
    throw new Error("Selling and buying assets must be different.");
  }

  const book = await withHorizon429Backoff(() =>
    getServer().orderbook(selling, buying).limit(10).call()
  );
  return {
    bids: mapOrderBookRows(book.bids),
    asks: mapOrderBookRows(book.asks),
  };
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

/**
 * Spendable balance after reserves and selling liabilities.
 * Native XLM keeps the base reserve for the account plus each subentry.
 * Credit assets only subtract selling liabilities. Buying liabilities are reported, not subtracted.
 */
export function calculateAvailableBalance(
  balance,
  isNative,
  subentryCount = 0,
  baseReserve = 0.5
) {
  const total = parseFloat(balance.balance || "0");
  const sellingLiabilities = parseFloat(balance.selling_liabilities || "0");

  if (isNative) {
    const minBalance = baseReserve * (2 + subentryCount);
    return Math.max(0, total - minBalance - sellingLiabilities).toFixed(7);
  }

  return Math.max(0, total - sellingLiabilities).toFixed(7);
}

function liabilityFields(balance, isNative, subentryCount, baseReserve) {
  const sellingLiabilities = parseFloat(balance.selling_liabilities || "0");
  const buyingLiabilities = parseFloat(balance.buying_liabilities || "0");
  return {
    sellingLiabilities: sellingLiabilities.toFixed(7),
    buyingLiabilities: buyingLiabilities.toFixed(7),
    available: calculateAvailableBalance(balance, isNative, subentryCount, baseReserve),
  };
}

async function readBaseReserve() {
  let baseReserve = 0.5;
  try {
    if (getServer().ledgers) {
      const ledgerInfo = await getServer().ledgers().order("desc").limit(1).call();
      if (ledgerInfo.records[0]?.base_reserve_in_stroops) {
        baseReserve = parseFloat(ledgerInfo.records[0].base_reserve_in_stroops) / 10000000;
      }
    }
  } catch {
    // Keep the protocol default when the ledgers endpoint is unavailable.
  }
  return baseReserve;
}

function mapHorizonBalances(account, baseReserve = 0.5) {
  const subentryCount = account.subentry_count || 0;
  return account.balances.map((b) => {
    const sellingLiabilities = b.selling_liabilities ?? "0";
    const buyingLiabilities = b.buying_liabilities ?? "0";
    if (b.asset_type === "native") {
      return {
        key: "native",
        code: "XLM",
        issuer: null,
        balance: b.balance,
        limit: null,
        isNative: true,
        sellingLiabilities,
        buyingLiabilities,
      };
    }
    return {
      key: `${b.asset_code}:${b.asset_issuer}`,
      code: b.asset_code,
      issuer: b.asset_issuer,
      balance: b.balance,
      limit: b.limit,
      isNative: false,
      sellingLiabilities,
      buyingLiabilities,
    };
  });
}

function mapClaimableBalance(record, publicKey) {
  const [code, issuer] = (record.asset || "").split(":");
  return {
    id: record.id,
    amount: record.amount,
    code: code || "XLM",
    issuer: issuer || null,
    createdByAccount: record.sponsor === publicKey,
    clawbackEnabled: Boolean(record.asset && issuer && record.flags?.auth_clawback_enabled),
    claimants: record.claimants || [],
    createdAt: record.last_modified_time || null,
  };
}

/**
 * Load claimable balances sponsored by the connected account. Horizon's
 * sponsor filter is the creator for balances created by this account; keep
 * the filter server-side so another account's balance is never offered for
 * clawback.
 */
export async function getClaimableBalances(publicKey) {
  const records = await getServer()
    .claimableBalances()
    .forSponsor(publicKey)
    .limit(200)
    .call();

  const balances = await Promise.all(
    (records.records || []).map(async (record) => {
      const mapped = mapClaimableBalance(record, publicKey);
      if (!mapped.issuer) return mapped;

      try {
        const assets = await getServer()
          .assets()
          .forCode(mapped.code)
          .forIssuer(mapped.issuer)
          .call();
        return {
          ...mapped,
          clawbackEnabled: Boolean(assets.records?.[0]?.flags?.auth_clawback_enabled),
        };
      } catch {
        return { ...mapped, clawbackEnabled: false };
      }
    })
  );

  return balances.filter((balance) => balance.createdByAccount);
}

/** Prefer the Kitewell backend on Testnet; otherwise read Horizon directly. */
export async function getAccountBalances(publicKey, options = {}) {
  if (backendIsUsable()) {
    try {
      const data = await fetchAccountViaApi(publicKey);
      return data.balances;
    } catch {
      /* fall back to direct Horizon */
    }
  }

  return withHorizon429Backoff(async () => {
    const account = await getServer().loadAccount(publicKey);
    return mapHorizonBalances(account, await readBaseReserve());
  }, options);
}

export async function getAccountDetails(publicKey, options = {}) {
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
    signers: account.signers,
    balances: mapHorizonBalances(account),
    dataEntries: mapAccountDataEntries(account),
    signers: account.signers || [],
    explorerUrl: explorerAccountUrl(publicKey),
  };
  return withHorizon429Backoff(async () => {
    const account = await getServer().loadAccount(publicKey);
    const baseReserve = await readBaseReserve();
    return {
      id: account.id,
      sequence: account.sequenceNumber(),
      subentryCount: account.subentry_count,
      thresholds: account.thresholds,
      balances: mapHorizonBalances(account, baseReserve),
      explorerUrl: explorerAccountUrl(publicKey),
    };
  }, options);
}

function offerAssetDescriptor(asset) {
  if (asset === "native" || asset?.asset_type === "native") {
    return { isNative: true };
  }
  if (typeof asset === "string") {
    const separator = asset.indexOf(":");
    if (separator <= 0 || separator === asset.length - 1) {
      throw new Error(`Horizon returned an invalid offer asset: ${asset}`);
    }
    return {
      isNative: false,
      code: asset.slice(0, separator),
      issuer: asset.slice(separator + 1),
    };
  }
  if (asset && asset.asset_code && asset.asset_issuer) {
    return {
      isNative: false,
      code: asset.asset_code,
      issuer: asset.asset_issuer,
    };
  }
  throw new Error("Horizon returned an invalid offer asset.");
}

/**
 * Load and normalize the active offers for a Stellar account.
 */
export async function getAccountOffers(publicKey, options = {}) {
  return withHorizon429Backoff(async () => {
    const page = await getServer()
      .offers()
      .forAccount(publicKey)
      .order("desc")
      .call({ signal: options.signal });

    return page.records.map((offer) => {
      const offerId = offer.id ?? offer.offer_id ?? offer.offerId;
      const price = offer.price_r ?? offer.price;
      if (
        offerId === undefined ||
        offer.amount === undefined ||
        !price ||
        price.n === undefined ||
        price.d === undefined
      ) {
        throw new Error("Horizon returned an incomplete offer record.");
      }

      return {
        offerId: String(offerId),
        selling: offerAssetDescriptor(offer.selling),
        buying: offerAssetDescriptor(offer.buying),
        amount: String(offer.amount),
        priceNumerator: String(price.n),
        priceDenominator: String(price.d),
      };
    });
  }, options);
}

function positivePricePart(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number > 2147483647) {
    throw new Error(`${label} exceeds the Stellar price limit.`);
  }
  if (number < 1) throw new Error(`${label} must be a positive integer.`);
  return number;
}

/**
 * Build a manageSellOffer operation, including the zero-amount form used to
 * cancel an existing offer by its offer ID.
 */
export function buildManageSellOffer({
  selling,
  buying,
  amount,
  priceNumerator,
  priceDenominator,
  offerId = "0",
} = {}) {
  const sellingAsset = buildAsset(selling);
  const buyingAsset = buildAsset(buying);
  if (sellingAsset.toString() === buyingAsset.toString()) {
    throw new Error("Selling and buying assets must be different.");
  }

  return StellarSdk.Operation.manageSellOffer({
    selling: sellingAsset,
    buying: buyingAsset,
    amount: String(amount ?? ""),
    price: {
      n: positivePricePart(priceNumerator, "Price numerator"),
      d: positivePricePart(priceDenominator, "Price denominator"),
    },
    offerId: String(offerId),
  });
}

export async function getBalance(publicKey, options = {}) {
  const balances = await getAccountBalances(publicKey, options);
  const xlm = balances.find((b) => b.isNative);
  return xlm ? xlm.balance : "0";
}

export async function getClaimableBalances(publicKey) {
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Connect a valid Freighter address first.");
  }

  const page = await getServer()
    .claimableBalances()
    .claimant(publicKey)
    .limit(200)
    .order("desc")
    .call();

  return (page.records || []).map((balance) => ({
    id: balance.id,
    asset:
      balance.asset === "native"
        ? "XLM"
        : `${balance.asset_code || balance.asset}`,
    assetCode: balance.asset_code,
    assetIssuer: balance.asset_issuer,
    amount: balance.amount,
    claimants: balance.claimants || [],
    sponsor: balance.sponsor || null,
  }));
}

export const listClaimableBalances = getClaimableBalances;

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

function validateLiquidityPoolId(poolId) {
  if (typeof poolId !== "string" || !/^[0-9a-f]{64}$/i.test(poolId)) {
    throw new Error("Pool ID must be 64 hexadecimal characters.");
  }
  return poolId.toLowerCase();
}

/**
 * Build a constant-product liquidity pool deposit operation.
 *
 * @param {string} poolId Horizon liquidity-pool id (`hex`).
 * @param {string} maxAmountA Maximum amount of reserve A to deposit.
 * @param {string} maxAmountB Maximum amount of reserve B to deposit.
 * @param {string} minPrice Minimum accepted reserve A/B price.
 * @param {string} maxPrice Maximum accepted reserve A/B price.
 * @returns {StellarSdk.xdr.Operation} The liquidity pool deposit operation.
 */
export function liquidityPoolDeposit(
  poolId,
  maxAmountA,
  maxAmountB,
  minPrice,
  maxPrice
) {
  return StellarSdk.Operation.liquidityPoolDeposit({
    liquidityPoolId: validateLiquidityPoolId(poolId),
    maxAmountA,
    maxAmountB,
    minPrice,
    maxPrice,
  });
}

/**
 * Build a constant-product liquidity pool withdrawal operation.
 *
 * @param {string} poolId Horizon liquidity-pool id (`hex`).
 * @param {string} amount Pool shares to burn.
 * @param {string} minAmountA Minimum reserve A to receive.
 * @param {string} minAmountB Minimum reserve B to receive.
 * @returns {StellarSdk.xdr.Operation} The liquidity pool withdrawal operation.
 */
export function liquidityPoolWithdraw(poolId, amount, minAmountA, minAmountB) {
  return StellarSdk.Operation.liquidityPoolWithdraw({
    liquidityPoolId: validateLiquidityPoolId(poolId),
    amount,
    minAmountA,
    minAmountB,
  });
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
export async function getTransactions(publicKey, limit = 15, cursor, options = {}) {
  if (backendIsUsable()) {
    try {
      return await fetchPaymentsViaApi(publicKey, limit, cursor);
    } catch {
      /* fall back to direct Horizon */
    }
  }

  return withHorizon429Backoff(async () => {
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
  }, options);
}

/** Read one transaction and all its operations directly from the active Horizon. */
export async function getTransactionByHash(input, options = {}) {
  const hash = normaliseTxHash(input);
  const base = getActiveNetwork().horizonUrl;

  const read = async (url) => {
    const response = await fetch(url, { signal: options.signal });
    if (response.status === 404) {
      throw new Error("Transaction not found on this network.");
    }
    if (!response.ok) {
      const error = new Error(`Could not load transaction (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  return withHorizon429Backoff(async () => {
    const transaction = await read(`${base}/transactions/${hash}`);
    const operationPage = await read(`${base}/transactions/${hash}/operations?limit=200`);
    return { transaction, operations: operationPage?._embedded?.records || [] };
  }, options);
}

/** Deep-link into the hash status watch panel for a transaction. */
export function statusWatchHref(hash) {
  return `#status-watch/${encodeURIComponent(hash)}`;
}

/**
 * Map a Horizon pending-queue record into the fields the panel renders.
 * Accepts both short lab names and classic Horizon transaction field names.
 */
export function mapPendingTransaction(record) {
  const status = String(
    record.status ?? record.tx_status ?? "pending"
  ).toLowerCase();

  return {
    hash: record.hash,
    fee: String(record.fee ?? record.fee_charged ?? record.max_fee ?? ""),
    sequence: String(
      record.sequence ?? record.source_account_sequence ?? ""
    ),
    status,
  };
}

/**
 * Fetch and parse stellar.toml for a domain or issuer account.
 *
 * @param {string} domainOrIssuer Either a domain (e.g., "example.com") or a
 *   Stellar public key (G...). When an issuer is provided, the SDK resolves
 *   the home_domain from the account's on-chain data.
 * @returns {Promise<object>} Parsed stellar.toml with keys like
 *   TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER, CURRENCIES, etc.
 */
export async function fetchStellarToml(domainOrIssuer) {
  if (!domainOrIssuer || typeof domainOrIssuer !== "string") {
    throw new Error("Domain or issuer address is required.");
  }

  const trimmed = domainOrIssuer.trim();
  if (!trimmed) {
    throw new Error("Domain or issuer address is required.");
  }

  return StellarSdk.StellarTomlResolver.resolve(trimmed, {
    allowHttp: false,
  });
}

/**
 * Fetch the SEP-24 info endpoint from a transfer server URL.
 *
 * @param {string} transferServerUrl The TRANSFER_SERVER URL from stellar.toml.
 * @returns {Promise<object>} The parsed JSON response from the /info endpoint,
 *   including deposit and withdraw asset details.
 */
export async function fetchTransferServerInfo(transferServerUrl) {
  if (!transferServerUrl || typeof transferServerUrl !== "string") {
    throw new Error("Transfer server URL is required.");
  }

  const trimmed = transferServerUrl.trim();
  if (!trimmed) {
    throw new Error("Transfer server URL is required.");
  }

  // Only allow HTTPS URLs for security
  if (!trimmed.startsWith("https://")) {
    throw new Error("Transfer server URL must use HTTPS.");
  }

  // Build info endpoint URL, ensuring no double slashes
  const baseUrl = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  const infoUrl = `${baseUrl}/info`;

  const response = await fetch(infoUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch transfer server info: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Fetch stellar.toml and optionally the transfer server info for a domain or issuer.
 *
 * @param {string} domainOrIssuer Either a domain (e.g., "example.com") or a
 *   Stellar public key (G...).
 * @returns {Promise<object>} An object with:
 *   - toml: The parsed stellar.toml
 *   - transferServerInfo: The parsed /info response (null if TRANSFER_SERVER
 *     is absent or the fetch fails)
 */
export async function fetchAnchorInfo(domainOrIssuer) {
  const toml = await fetchStellarToml(domainOrIssuer);

  let transferServerInfo = null;
  if (toml.TRANSFER_SERVER) {
    try {
      transferServerInfo = await fetchTransferServerInfo(toml.TRANSFER_SERVER);
    } catch {
      // If the info endpoint fails, we still return the toml data
      transferServerInfo = null;
    }
  }

  return {
    toml,
    transferServerInfo,
  };
}
