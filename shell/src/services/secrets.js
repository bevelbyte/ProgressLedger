import { safeStorage } from "electron";

export function encryptSecret(secret) {
  if (!secret) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return {
      mode: "safeStorage",
      value: Buffer.from(safeStorage.encryptString(secret)).toString("base64"),
    };
  }
  return { mode: "plain", value: secret };
}

export function decryptSecret(secret) {
  if (!secret?.value) return "";
  if (secret.mode === "safeStorage") {
    return safeStorage.decryptString(Buffer.from(secret.value, "base64"));
  }
  return secret.value;
}
