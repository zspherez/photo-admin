import { readFileSync } from "node:fs";
import { google, type sheets_v4 } from "googleapis";

function loadGoogleCredentials(): {
  client_email: string;
  private_key: string;
} {
  const json = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
  const path = process.env.GOOGLE_CREDENTIALS_PATH?.trim();
  let value: unknown;

  try {
    if (json) {
      value = JSON.parse(json);
    } else if (path) {
      value = JSON.parse(readFileSync(path, "utf8"));
    }
  } catch {
    throw new Error("Google service account credentials are invalid");
  }

  if (
    !value ||
    typeof value !== "object" ||
    typeof Reflect.get(value, "client_email") !== "string" ||
    !Reflect.get(value, "client_email") ||
    typeof Reflect.get(value, "private_key") !== "string" ||
    !Reflect.get(value, "private_key")
  ) {
    throw new Error(
      "GOOGLE_CREDENTIALS_JSON or GOOGLE_CREDENTIALS_PATH must contain Google service account credentials",
    );
  }

  return {
    client_email: Reflect.get(value, "client_email"),
    private_key: Reflect.get(value, "private_key"),
  };
}

export function hasGoogleSheetsCredentials(): boolean {
  return Boolean(
    process.env.GOOGLE_CREDENTIALS_JSON?.trim() ||
      process.env.GOOGLE_CREDENTIALS_PATH?.trim(),
  );
}

export function getGoogleSheetsClient(): sheets_v4.Sheets {
  const credentials = loadGoogleCredentials();
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}
