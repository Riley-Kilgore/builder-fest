import { useEffect, useMemo, useState } from "react";
import { MeshTxBuilder } from "@meshsdk/transaction";
import { BlockfrostProvider } from "@meshsdk/provider";
import { addressToBech32, deserializeAddress } from "@meshsdk/core-cst";
import {
  csl,
  deserializeTx as deserializeTxCsl,
  deserializeTxBody,
  deserializeTxWitnessSet,
  fromBytes,
} from "@meshsdk/core-csl";
import {
  SLOT_CONFIG_NETWORK,
  stringToHex,
  unixTimeToEnclosingSlot,
  type Data,
  type LanguageVersion,
  type UTxO,
} from "@meshsdk/common";
import "./styles.css";

type Cip30WalletApi = {
  getUtxos: () => Promise<string[] | undefined>;
  getChangeAddress: () => Promise<string>;
  getCollateral?: () => Promise<string[] | undefined>;
  signTx: (tx: string, partialSign?: boolean) => Promise<string>;
  submitTx: (tx: string) => Promise<string>;
};

type Cip30WalletHandle = {
  name?: string;
  icon?: string;
  enable: () => Promise<Cip30WalletApi>;
};

const ALLOWED_WALLETS = [{ key: "lace", label: "Lace" }] as const;
const PRIMARY_WALLET = ALLOWED_WALLETS[0];
const BLOCKFROST_PROJECT_ID = import.meta.env.VITE_BLOCKFROST_PROJECT_ID as
  | string
  | undefined;
const BLOCKFROST_BASE_URL = "https://cardano-mainnet.blockfrost.io/api/v0";
const ISSUER_BEACON_POLICY =
  "e1ddde8138579e255482791d9fba0778cb1f5c7b435be7b3e42069de";
const ISSUER_BEACON_NAME = "425549444c45524645535432303236";
const TREASURY_ADDRESS =
  "addr1qx0decp93g2kwym5cz0p68thamd2t9pehlxqe02qae5r6nycv42qmjppm2rr8fj6qlzfhm6ljkd5f0tjlgudtmt5kzyqmy8x82";
const ISSUER_SCRIPT_REF = "31596ecbdcf102c8e5c17e75c65cf9780996285879d18903f035964f3a7499a8#0";
const TICKET_POLICY =
  "1d9c0b541adc300c19ddc6b9fb63c0bfe32b1508305ba65b8762dc7b";
const ISSUER_ADDRESS =
  "addr1wywecz65rtwrqrqemhrtn7mrczl7x2c4pqc9hfjmsa3dc7cr5pvqw";
const PRICE_CUTOFF_UTC = Date.UTC(2026, 1, 1, 12, 0, 0);

const shorten = (value: string, head = 10, tail = 6) => {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
};

export default function App() {
  const [walletHandle, setWalletHandle] = useState<Cip30WalletHandle | null>(
    null,
  );
  const [walletApi, setWalletApi] = useState<Cip30WalletApi | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [utxos, setUtxos] = useState<UTxO[]>([]);
  const [status, setStatus] = useState("Waiting for wallet connection.");
  const [busy, setBusy] = useState(false);
  const [txCbor, setTxCbor] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [detectedWalletKeys, setDetectedWalletKeys] = useState<string[]>([]);

  const utxoCount = useMemo(() => utxos.length, [utxos.length]);
  const hasWallet = Boolean(walletApi);
  const canConnect = Boolean(walletHandle);
  const blockfrost = useMemo(
    () =>
      BLOCKFROST_PROJECT_ID
        ? new BlockfrostProvider(BLOCKFROST_PROJECT_ID)
        : null,
    [],
  );

  useEffect(() => {
    let mounted = true;
    let attempts = 0;
    const maxAttempts = 12;

    const poll = () => {
      const cardano = (window as { cardano?: Record<string, Cip30WalletHandle> })
        .cardano;
      const keys = cardano ? Object.keys(cardano) : [];
      const normalized = keys.map((key) => key.toLowerCase());
      const foundKey =
        keys.find((key) => key.toLowerCase() === PRIMARY_WALLET.key) ??
        keys.find(
          (key) => cardano?.[key]?.name?.toLowerCase() === PRIMARY_WALLET.key,
        );

      if (mounted) {
        setDetectedWalletKeys(normalized);
        setWalletHandle(foundKey ? cardano?.[foundKey] ?? null : null);
        if (!foundKey && attempts >= maxAttempts) {
          setStatus("Lace wallet not detected in this browser.");
        }
      }

      attempts += 1;
      if (!foundKey && attempts <= maxAttempts) {
        window.setTimeout(poll, 250);
      }
    };

    poll();
    return () => {
      mounted = false;
    };
  }, []);

  const connectWallet = async (name: string) => {
    setBusy(true);
    setStatus(`Connecting to ${name}...`);

    try {
      if (!walletHandle) {
        throw new Error("Wallet not found in window.cardano.");
      }
      const connected = await walletHandle.enable();
      setWalletApi(connected);
      setWalletName(walletHandle.name ?? name);

      const changeAddress = await connected.getChangeAddress();
      const bech32Address = addressToBech32(deserializeAddress(changeAddress));

      setUtxos([]);
      setAddress(bech32Address ?? null);
      setStatus(`Connected to ${name}.`);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`Failed to connect to ${name}. ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshWallet = async () => {
    if (!walletApi) return;
    if (!blockfrost) {
      setStatus("Missing Blockfrost key. Set VITE_BLOCKFROST_PROJECT_ID.");
      return;
    }
    setBusy(true);
    setStatus("Building a draft transaction...");
    setTxCbor(null);
    setTxHash(null);

    try {
      const rawChangeAddress = address ?? (await walletApi.getChangeAddress());
      const bech32Change = rawChangeAddress.startsWith("addr")
        ? rawChangeAddress
        : addressToBech32(deserializeAddress(rawChangeAddress));
      const latestUtxos = await blockfrost.fetchAddressUTxOs(bech32Change);
      setUtxos(latestUtxos);

      if (latestUtxos.length === 0) {
        setStatus("No UTxOs available to build a draft.");
        return;
      }

      const totalLovelace = sumLovelace(latestUtxos);
      const requiredLovelace = BigInt(getTicketPrice()) + 5_000_000n;
      if (totalLovelace < requiredLovelace) {
        setStatus(
          `Insufficient ADA. Need at least ${formatAda(
            requiredLovelace,
          )} (ticket + fees), have ${formatAda(totalLovelace)}.`,
        );
        return;
      }

      const pureLovelaceUtxos = latestUtxos
        .filter(
          (utxo) =>
            utxo.output.amount.length === 1 &&
            utxo.output.amount[0].unit === "lovelace",
        )
        .sort((a, b) => {
          const aQty = getLovelace(a);
          const bQty = getLovelace(b);
          if (aQty === bQty) return 0;
          return aQty < bQty ? -1 : 1;
        });
      const collateralUtxo =
        pureLovelaceUtxos.find((utxo) => getLovelace(utxo) >= 5_000_000n) ??
        null;
      if (!collateralUtxo) {
        setStatus(
          pureLovelaceUtxos.length === 0
            ? "No ADA-only UTxO available for collateral."
            : "Collateral UTxO must be at least 5 ADA.",
        );
        return;
      }

      const beaconUnit = `${ISSUER_BEACON_POLICY}${ISSUER_BEACON_NAME}`;
      const stateUtxos = await blockfrost.fetchAddressUTxOs(
        ISSUER_ADDRESS,
        beaconUnit,
      );
      const stateUtxo = stateUtxos[0];
      if (!stateUtxo) {
        setStatus("State UTxO not found. Please retry.");
        return;
      }

      const ticketNo = parseTicketNumber(stateUtxo);
      if (ticketNo === null) {
        setStatus("Unable to read ticket counter datum.");
        return;
      }

      console.info("Ticket counter parsed", {
        ticketNo,
        nextTicketNo: ticketNo,
      });

      const nextTicketNo = ticketNo;
      const nextTicketDatum = buildTicketDatum(nextTicketNo + 1);
      const ticketName = `TICKET${nextTicketNo}`;
      const ticketNameHex = stringToHex(ticketName);
      console.info("Ticket metadata prepared", {
        nextTicketNo,
        ticketName,
        ticketNameHex,
        datum: nextTicketDatum,
      });
      const [scriptTxHash, scriptTxIndex] = ISSUER_SCRIPT_REF.split("#");
      console.info("Fetching script ref UTxO", {
        scriptTxHash,
        scriptTxIndex,
      });
      let scriptRefInfo: ScriptRefInfo | null = null;
      try {
        scriptRefInfo = await fetchScriptRefInfo(
          scriptTxHash,
          Number(scriptTxIndex),
        );
      } catch (error) {
        const errorDetails = describeUnknownError(error);
        console.error("Script ref fetch failed", errorDetails);
        setStatus(
          `Failed to fetch issuer script reference (not a balance issue). ${extractErrorMessage(
            errorDetails,
          )}`,
        );
        return;
      }
      console.info("Script ref UTxO", scriptRefInfo?.utxo);
      if (!scriptRefInfo) {
        setStatus(
          "Script reference UTxO not found. This is not a wallet balance issue.",
        );
        return;
      }
      const { utxo: scriptRefUtxo, version: scriptVersion, scriptSize } =
        scriptRefInfo;
      console.info("Script ref meta", {
        scriptVersion,
        scriptSize,
      });

      const txBuilder = new MeshTxBuilder({
        fetcher: blockfrost,
        verbose: true,
      });
      const ticketUnit = `${TICKET_POLICY}${ticketNameHex}`;

      console.info("Tx inputs", { collateralUtxo, stateUtxo });
      applySpendingVersion(txBuilder, scriptVersion)
        .txIn(
          stateUtxo.input.txHash,
          stateUtxo.input.outputIndex,
          stateUtxo.output.amount,
          stateUtxo.output.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue({ alternative: 0, fields: [] })
        .spendingTxInReference(
          scriptRefUtxo.input.txHash,
          scriptRefUtxo.input.outputIndex,
          scriptSize,
          scriptRefUtxo.output.scriptHash,
        );
      console.info("Redeem state UTxO configured");

      applyMintVersion(txBuilder, scriptVersion)
        .mint("1", TICKET_POLICY, ticketNameHex)
        .mintTxInReference(
          scriptRefUtxo.input.txHash,
          scriptRefUtxo.input.outputIndex,
          scriptSize,
          scriptRefUtxo.output.scriptHash,
        )
        .mintRedeemerValue({ alternative: 0, fields: [] });
      console.info("Mint configured", {
        ticketName,
        ticketNameHex,
        ticketUnit,
      });

      txBuilder
        .txOut(bech32Change, [
          { unit: "lovelace", quantity: "2000000" },
          { unit: ticketUnit, quantity: "1" },
        ])
        .txOut(ISSUER_ADDRESS, stateUtxo.output.amount)
        .txOutInlineDatumValue(nextTicketDatum)
        .txOut(TREASURY_ADDRESS, [
          { unit: "lovelace", quantity: String(getTicketPrice()) },
        ])
        .invalidHereafter(getValidityUpperBound())
        .changeAddress(bech32Change)
        .txInCollateral(
          collateralUtxo.input.txHash,
          collateralUtxo.input.outputIndex,
          collateralUtxo.output.amount,
          collateralUtxo.output.address,
        )
        .selectUtxosFrom(latestUtxos);

      console.info("Building unsigned tx...");
      const unsignedTx = await txBuilder.complete();
      console.info("Unsigned tx built");
      setTxCbor(unsignedTx);
      setStatus("Draft transaction built. Awaiting signature...");

      console.info("Requesting wallet signature...");
      const signedWitnesses = await walletApi.signTx(unsignedTx, true);
      const signed = normalizeSignedTx(unsignedTx, signedWitnesses);
      console.info("Signed tx received");
      setStatus("Submitting signed transaction...");

      const submittedHash = await submitToBlockfrost(signed);
      console.info("Transaction submitted", { txHash: submittedHash });
      setTxHash(submittedHash);
      setStatus(`Transaction submitted: ${shorten(submittedHash)}`);
    } catch (error) {
      const errorDetails = describeUnknownError(error);
      console.error("Draft build error", errorDetails);
      setStatus(
        `Draft build or signing failed. ${extractErrorMessage(errorDetails)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span>Builder Fest 2026</span>
        </div>
        <button
          className="ghost"
          onClick={() => void connectWallet(PRIMARY_WALLET.label)}
          disabled={busy || !canConnect || hasWallet}
        >
          {hasWallet
            ? `Connected: ${walletName ?? PRIMARY_WALLET.label}`
            : canConnect
              ? `Connect ${PRIMARY_WALLET.label}`
              : `Install ${PRIMARY_WALLET.label}`}
        </button>
      </header>

      <main className="center-stage">
        <div className="hero-card">
          <p className="eyebrow">Ticket Checkout</p>
          <h1>Buy tickets for Builder Fest 2026 in Buenos Aires</h1>
          <p className="subhead">
            Purchase your Builder Fest 2026 pass with your wallet. We build the
            draft transaction automatically, no forms or manual inputs.
          </p>

          <button
            className="primary large"
            onClick={refreshWallet}
            disabled={!hasWallet || busy}
          >
            {hasWallet ? "Build Ticket Purchase Draft" : "Connect wallet first"}
          </button>

          <div className="details">
            <div>
              <span className="label">Status</span>
              <strong>{status}</strong>
            </div>
            <div>
              <span className="label">Detected wallets</span>
              <strong>
                {detectedWalletKeys.length
                  ? detectedWalletKeys.join(", ")
                  : "—"}
              </strong>
            </div>
            <div>
              <span className="label">Wallet</span>
              <strong>{walletName ?? "—"}</strong>
            </div>
            <div>
              <span className="label">Change address</span>
              <strong>{address ? shorten(address) : "—"}</strong>
            </div>
            <div>
              <span className="label">UTxOs</span>
              <strong>{hasWallet ? utxoCount : "—"}</strong>
            </div>
            <div>
              <span className="label">Unsigned tx (cbor)</span>
              <strong>{txCbor ? shorten(txCbor, 14, 10) : "—"}</strong>
            </div>
            <div>
              <span className="label">Submitted tx hash</span>
              <div className="hash-row">
                <code>{txHash ?? "—"}</code>
                <button
                  className="ghost ghost-small"
                  type="button"
                  onClick={() => {
                    if (!txHash) return;
                    void navigator.clipboard
                      .writeText(txHash)
                      .then(() => setStatus("Transaction hash copied."))
                      .catch(() =>
                        setStatus("Unable to copy transaction hash."),
                      );
                  }}
                  disabled={!txHash}
                >
                  Copy
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
  const buildTicketDatum = (ticketNo: number): Data => ({
    alternative: 0,
    fields: [ticketNo],
  });

  const parseTicketNumber = (stateUtxo: UTxO): number | null => {
    const plutusData = stateUtxo.output.plutusData;
    if (!plutusData) return null;
    try {
      return parseTicketNumberFromCbor(plutusData);
    } catch (error) {
      console.warn("Failed to parse state datum", error);
      return null;
    }
  };

  const parseTicketNumberFromCbor = (hex: string): number | null => {
    const bytes = hexToBytes(hex);
    if (bytes.length < 3) return null;
    if (bytes[0] !== 0xd8 || bytes[1] !== 0x79) return null;
    let offset = 2;
    const listInfo = bytes[offset++];
    if ((listInfo & 0xe0) !== 0x80) return null;
    const listLen = listInfo & 0x1f;
    if (listLen < 1) return null;
    const [value] = decodeCborInt(bytes, offset) ?? [];
    return value ?? null;
  };

  const decodeCborInt = (
    bytes: Uint8Array,
    offset: number,
  ): [number | null, number] | null => {
    if (offset >= bytes.length) return null;
    const initial = bytes[offset++];
    const major = initial >> 5;
    let additional = initial & 0x1f;
    if (major !== 0 && major !== 1) return [null, offset];

    let value = 0;
    if (additional < 24) {
      value = additional;
    } else if (additional === 24) {
      if (offset + 1 > bytes.length) return null;
      value = bytes[offset++];
    } else if (additional === 25) {
      if (offset + 2 > bytes.length) return null;
      value = (bytes[offset] << 8) | bytes[offset + 1];
      offset += 2;
    } else if (additional === 26) {
      if (offset + 4 > bytes.length) return null;
      value =
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
      offset += 4;
    } else {
      return null;
    }

    if (major === 1) {
      return [-1 - value, offset];
    }
    return [value, offset];
  };

  const hexToBytes = (hex: string) => {
    const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
    const result = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < normalized.length; i += 2) {
      result[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
    }
    return result;
  };

  const getTicketPrice = () =>
    Date.now() < PRICE_CUTOFF_UTC ? 400_000_000 : 500_000_000;

const getValidityUpperBound = () => {
  const ttlUnix = Date.now() + 2 * 60 * 60 * 1000;
  return unixTimeToEnclosingSlot(ttlUnix, SLOT_CONFIG_NETWORK.mainnet);
};

const describeUnknownError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      kind: "Error",
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === "string") {
    try {
      return { kind: "string", raw: error, parsed: JSON.parse(error) };
    } catch {
      return { kind: "string", raw: error };
    }
  }
  if (error && typeof error === "object") {
    return {
      kind: "object",
      name: (error as { name?: string }).name,
      ctor: (error as { constructor?: { name?: string } }).constructor?.name,
      keys: Object.getOwnPropertyNames(error),
      json: safeStringify(error),
    };
  }
  return { kind: typeof error, value: error };
};

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const extractErrorMessage = (details: ReturnType<typeof describeUnknownError>) => {
  if (details && typeof details === "object") {
    if ("message" in details && details.message) return String(details.message);
    if ("raw" in details && details.raw) return String(details.raw);
    if ("json" in details && details.json) return String(details.json);
    if ("value" in details && details.value) return String(details.value);
  }
  return safeStringify(details);
};

type BlockfrostTxUtxos = {
  outputs: BlockfrostTxOutput[];
};

type BlockfrostTxOutput = {
  address: string;
  amount: { unit: string; quantity: string }[];
  output_index: number;
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
};

type BlockfrostScriptInfo = {
  type: string;
};

type BlockfrostScriptCbor = {
  cbor: string;
};

type ScriptRefInfo = {
  utxo: UTxO;
  version: LanguageVersion;
  scriptSize: string;
};

const fetchScriptRefInfo = async (
  txHash: string,
  outputIndex: number,
): Promise<ScriptRefInfo> => {
  const txUtxos = await fetchBlockfrostJson<BlockfrostTxUtxos>(
    `txs/${txHash}/utxos`,
  );
  console.info("Blockfrost tx utxos loaded", {
    txHash,
    outputs: txUtxos.outputs.length,
  });
  const output = txUtxos.outputs.find(
    (item) => item.output_index === outputIndex,
  );
  if (!output) {
    throw new Error(`Script ref output not found at index ${outputIndex}.`);
  }
  const scriptHash = output.reference_script_hash;
  if (!scriptHash) {
    throw new Error("Script ref output has no reference script hash.");
  }
  const scriptInfo = await fetchBlockfrostJson<BlockfrostScriptInfo>(
    `scripts/${scriptHash}`,
  );
  console.info("Blockfrost script info loaded", {
    scriptHash,
    type: scriptInfo.type,
  });
  const scriptCbor = await fetchBlockfrostJson<BlockfrostScriptCbor>(
    `scripts/${scriptHash}/cbor`,
  );
  console.info("Blockfrost script cbor loaded", {
    scriptHash,
    cborBytes: scriptCbor.cbor.length / 2,
  });
  const version = normalizeBlockfrostVersion(scriptInfo.type);
  const scriptRef = scriptCbor.cbor;
  if (!isHexString(scriptRef)) {
    throw new Error("Script CBOR is not valid hex.");
  }
  const scriptSize = String(scriptRef.length / 2);

  console.info("Script ref details", {
    scriptHash,
    type: scriptInfo.type,
    version,
  });

  return {
    utxo: {
      input: { txHash, outputIndex },
      output: {
        address: output.address,
        amount: output.amount,
        dataHash: output.data_hash ?? undefined,
        plutusData: output.inline_datum ?? undefined,
        scriptRef,
        scriptHash,
      },
    },
    version,
    scriptSize,
  };
};

const fetchBlockfrostJson = async <T,>(path: string): Promise<T> => {
  if (!BLOCKFROST_PROJECT_ID) {
    throw new Error("Missing Blockfrost key.");
  }
  let response: Response;
  try {
    response = await fetch(`${BLOCKFROST_BASE_URL}/${path}`, {
      headers: { project_id: BLOCKFROST_PROJECT_ID },
    });
  } catch (error) {
    throw new Error(
      `Blockfrost request failed (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const text = await response.text();
  const body = parseJsonLoose(text);
  if (!response.ok) {
    const details = typeof body === "string" ? body : safeStringify(body);
    throw new Error(
      `Blockfrost ${response.status} ${response.statusText} (${path}): ${details}`,
    );
  }
  return body as T;
};

const submitToBlockfrost = async (signedTxCbor: string): Promise<string> => {
  if (!BLOCKFROST_PROJECT_ID) {
    throw new Error("Missing Blockfrost key.");
  }
  const normalized = normalizeHexString(signedTxCbor, "Signed transaction");
  const response = await fetch(`${BLOCKFROST_BASE_URL}/tx/submit`, {
    method: "POST",
    headers: {
      project_id: BLOCKFROST_PROJECT_ID,
      "content-type": "application/cbor",
    },
    body: hexToBytes(normalized),
  });
  const text = await response.text();
  if (!response.ok) {
    const details = text ? text : response.statusText;
    throw new Error(`Blockfrost submit failed: ${details}`);
  }
  return text.trim();
};

const parseJsonLoose = (text: string): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const normalizeBlockfrostVersion = (type: string): LanguageVersion => {
  const normalized = type
    .toLowerCase()
    .replace("plutus", "")
    .replace(":", "")
    .toUpperCase();
  if (normalized === "V1" || normalized === "V2" || normalized === "V3") {
    return normalized as LanguageVersion;
  }
  throw new Error(`Unsupported script type from Blockfrost: ${type}`);
};

const isHexString = (value: string) =>
  value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);

const applySpendingVersion = (
  builder: MeshTxBuilder,
  version: LanguageVersion,
) => {
  switch (version) {
    case "V1":
      return builder.spendingPlutusScriptV1();
    case "V2":
      return builder.spendingPlutusScriptV2();
    case "V3":
      return builder.spendingPlutusScriptV3();
    default:
      throw new Error(`Unsupported spending script version: ${version}`);
  }
};

const applyMintVersion = (builder: MeshTxBuilder, version: LanguageVersion) => {
  switch (version) {
    case "V1":
      return builder.mintPlutusScriptV1();
    case "V2":
      return builder.mintPlutusScriptV2();
    case "V3":
      return builder.mintPlutusScriptV3();
    default:
      throw new Error(`Unsupported minting script version: ${version}`);
  }
};

const sumLovelace = (utxos: UTxO[]) =>
  utxos.reduce((total, utxo) => {
    const lovelace =
      utxo.output.amount.find((asset) => asset.unit === "lovelace")?.quantity ??
      "0";
    return total + BigInt(lovelace);
  }, 0n);

const getLovelace = (utxo: UTxO) => {
  const lovelace =
    utxo.output.amount.find((asset) => asset.unit === "lovelace")?.quantity ??
    "0";
  return BigInt(lovelace);
};

const formatAda = (lovelace: bigint) => {
  const sign = lovelace < 0n ? "-" : "";
  const abs = lovelace < 0n ? -lovelace : lovelace;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${fracStr ? `.${fracStr}` : ""} ADA`;
};

const normalizeSignedTx = (unsignedTx: string, signedResult: string) => {
  if (signedResult.trim() === "") {
    throw new Error("Wallet did not return a signature.");
  }
  const normalizedSigned = normalizeHexString(
    signedResult,
    "Signed transaction",
  );
  const normalizedUnsigned = normalizeHexString(
    unsignedTx,
    "Unsigned transaction",
  );
  if (isFullTransactionCbor(normalizedSigned)) {
    return normalizedSigned;
  }
  return addWitnessesToUnsigned(normalizedUnsigned, normalizedSigned);
};

const addWitnessesToUnsigned = (unsignedTx: string, witnessesCbor: string) => {
  const tx = parseUnsignedTransaction(unsignedTx);
  const incomingWitnessSet = deserializeTxWitnessSet(witnessesCbor);
  const currentWitnessSet = tx.witness_set();
  const combinedVkeys = csl.Vkeywitnesses.new();
  const addVkeys = (vkeys?: csl.Vkeywitnesses) => {
    if (!vkeys) return;
    for (let i = 0; i < vkeys.len(); i += 1) {
      const witness = vkeys.get(i);
      combinedVkeys.add(witness);
    }
  };
  addVkeys(currentWitnessSet.vkeys());
  addVkeys(incomingWitnessSet.vkeys());

  if (combinedVkeys.len() === 0) {
    throw new Error("Wallet returned an empty witness set.");
  }
  currentWitnessSet.set_vkeys(combinedVkeys);
  const mergedTx = csl.Transaction.new(
    tx.body(),
    currentWitnessSet,
    tx.auxiliary_data(),
  );
  return fromBytes(mergedTx.to_bytes());
};

const normalizeHexString = (value: string, label: string) => {
  const trimmed = value.trim();
  const withoutPrefix = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;
  if (!isHexString(withoutPrefix)) {
    throw new Error(`${label} is not valid hex.`);
  }
  return withoutPrefix;
};

const parseUnsignedTransaction = (unsignedTx: string) => {
  try {
    return deserializeTxCsl(unsignedTx);
  } catch (error) {
    try {
      const txBody = deserializeTxBody(unsignedTx);
      return csl.Transaction.new(txBody, csl.TransactionWitnessSet.new());
    } catch (innerError) {
      throw new Error(
        `Unable to parse unsigned transaction CBOR. ${
          innerError instanceof Error ? innerError.message : String(innerError)
        }`,
      );
    }
  }
};

const isFullTransactionCbor = (txHex: string) => {
  try {
    deserializeTxCsl(txHex);
    return true;
  } catch {
    return false;
  }
};
