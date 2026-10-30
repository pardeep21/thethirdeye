// Faces wiring: SQLite path from EYESMART_DB (default ./eyesmart.db),
// stub embedder (see embed.ts for why human is out).
import { join } from "node:path";
import type { FaceMatcher } from "../adapters/index.js";
import { StubFaceEmbedder } from "./embed.js";
import { StoredFaceMatcher } from "./matcher.js";
import { PeopleStore } from "./store.js";

export function defaultDbPath(): string {
  return process.env.EYESMART_DB ?? join(process.cwd(), "eyesmart.db");
}

export function createFaceMatcher(store: PeopleStore): FaceMatcher {
  return new StoredFaceMatcher(store, new StubFaceEmbedder());
}
