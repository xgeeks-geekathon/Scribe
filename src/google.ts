import { google } from "googleapis";
import { JSONClient } from "google-auth-library/build/src/auth/googleauth";
const { authenticate } = require("@google-cloud/local-auth");
import fs from "fs";
import path from "path";

const TOKEN_PATH = path.join(process.cwd(), "token.json");
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
];

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.promises.readFile(TOKEN_PATH, {
      encoding: "utf-8",
    });
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client: JSONClient) {
  const content = await fs.promises.readFile(CREDENTIALS_PATH, {
    encoding: "utf-8",
  });
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.promises.writeFile(TOKEN_PATH, payload);
}

export async function authorize() {
  const savedClient = await loadSavedCredentialsIfExist();
  if (savedClient) {
    return savedClient;
  } else {
    const newClient = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH,
    });
    if (newClient.credentials) {
      await saveCredentials(newClient);
    }
    return newClient;
  }
}
