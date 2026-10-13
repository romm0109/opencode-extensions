/**
 * A Codex checkpoint is replayable only when every identity boundary is known.
 * This models the invariant that pi-codex-compact enforces; it does not claim
 * OpenCode 2.0.28 exposes these values or implement the Codex wire protocol.
 */
export interface CodexCheckpointProvenance {
  version: 1;
  providerID: string;
  modelID: string;
  accountFingerprint: string;
  endpointOrigin: string;
  protocol: "responses-compact" | "remote-v2" | "context-management";
  checkpointID: string;
  providerState: Record<string, unknown>;
}

export interface CodexReplayIdentity {
  providerID: string;
  modelID: string;
  accountFingerprint?: string;
  endpointOrigin?: string;
  protocol?: CodexCheckpointProvenance["protocol"];
}

export function parseCodexCheckpointProvenance(value: unknown): CodexCheckpointProvenance | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const { providerID, modelID, accountFingerprint, endpointOrigin, protocol, checkpointID, providerState } = value;
  if (typeof providerID !== "string" || !providerID.trim() || typeof modelID !== "string" || !modelID.trim())
    return undefined;
  if (typeof accountFingerprint !== "string" || !/^[a-f0-9]{32,128}$/u.test(accountFingerprint)) return undefined;
  if (typeof endpointOrigin !== "string" || !isOrigin(endpointOrigin)) return undefined;
  if (protocol !== "responses-compact" && protocol !== "remote-v2" && protocol !== "context-management")
    return undefined;
  if (typeof checkpointID !== "string" || !/^[A-Za-z0-9._:-]{8,256}$/u.test(checkpointID)) return undefined;
  if (!isRecord(providerState)) return undefined;
  const serialized = JSON.stringify(providerState);
  if (Buffer.byteLength(serialized, "utf8") > 512 * 1024) return undefined;
  return { version: 1, providerID, modelID, accountFingerprint, endpointOrigin, protocol, checkpointID, providerState };
}

export function codexReplayDecision(
  checkpoint: unknown,
  current: CodexReplayIdentity,
): { replay: true; providerState: Record<string, unknown> } | { replay: false; reason: string } {
  const parsed = parseCodexCheckpointProvenance(checkpoint);
  if (!parsed) return { replay: false, reason: "checkpoint provenance is incomplete or invalid" };
  if (!current.accountFingerprint || !current.endpointOrigin || !current.protocol)
    return { replay: false, reason: "active account, endpoint, or protocol provenance is unavailable" };
  if (parsed.providerID !== current.providerID) return { replay: false, reason: "provider changed" };
  if (parsed.modelID !== current.modelID) return { replay: false, reason: "model changed" };
  if (parsed.accountFingerprint !== current.accountFingerprint) return { replay: false, reason: "account changed" };
  if (parsed.endpointOrigin !== current.endpointOrigin) return { replay: false, reason: "endpoint changed" };
  if (parsed.protocol !== current.protocol) return { replay: false, reason: "compaction protocol changed" };
  return { replay: true, providerState: parsed.providerState };
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
