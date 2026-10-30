// Enrolled-people store: embeddings only in SQLite (MVP.md section 2
// component 7). Photos are embedded and discarded; no face images are kept.
import Database from "better-sqlite3";

export interface PersonRow {
  id: number;
  name: string;
  faces: number;
  enrolledAt: string;
}

export interface StoredEmbedding {
  personId: number;
  name: string;
  embedding: number[];
}

export class PeopleStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        embedding TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_person ON embeddings(person_id);
    `);
  }

  addPerson(name: string, embeddings: number[][]): PersonRow {
    const clean = name.trim();
    if (!clean) throw new Error("name is required");
    if (embeddings.length === 0) throw new Error("at least one embedding is required");
    const insertPerson = this.db.prepare("INSERT INTO people (name) VALUES (?)");
    const insertEmb = this.db.prepare("INSERT INTO embeddings (person_id, embedding) VALUES (?, ?)");
    const tx = this.db.transaction((n: string, embs: number[][]): number => {
      const row = insertPerson.run(n);
      for (const e of embs) insertEmb.run(row.lastInsertRowid, JSON.stringify(e));
      return Number(row.lastInsertRowid);
    });
    const id = tx(clean, embeddings);
    return { id, name: clean, faces: embeddings.length, enrolledAt: new Date().toISOString() };
  }

  removePerson(id: number): boolean {
    const tx = this.db.transaction((pid: number): boolean => {
      this.db.prepare("DELETE FROM embeddings WHERE person_id = ?").run(pid);
      return this.db.prepare("DELETE FROM people WHERE id = ?").run(pid).changes > 0;
    });
    return tx(id);
  }

  listPeople(): PersonRow[] {
    return this.db
      .prepare(
        `SELECT p.id AS id, p.name AS name, COUNT(e.id) AS faces, p.created_at AS enrolledAt
         FROM people p LEFT JOIN embeddings e ON e.person_id = p.id
         GROUP BY p.id ORDER BY p.id`
      )
      .all() as PersonRow[];
  }

  allEmbeddings(): StoredEmbedding[] {
    const rows = this.db
      .prepare(
        `SELECT e.person_id AS personId, p.name AS name, e.embedding AS embedding
         FROM embeddings e JOIN people p ON p.id = e.person_id`
      )
      .all() as Array<{ personId: number; name: string; embedding: string }>;
    return rows.map((r) => ({ personId: r.personId, name: r.name, embedding: JSON.parse(r.embedding) as number[] }));
  }

  close(): void {
    this.db.close();
  }
}
