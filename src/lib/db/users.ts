import type { D1Database } from "@cloudflare/workers-types";

export interface User {
  id: string;
  githubId: number;
  githubUsername: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string;
  github_id: number;
  github_username: string;
  created_at: string;
  last_login_at: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: row.github_id,
    githubUsername: row.github_username,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function upsertUser(
  db: D1Database,
  input: { githubId: number; githubUsername: string },
): Promise<User> {
  const row = await db
    .prepare(
      `INSERT INTO users (id, github_id, github_username, last_login_at)
       VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = excluded.github_username,
         last_login_at = datetime('now')
       RETURNING *`,
    )
    .bind(crypto.randomUUID(), input.githubId, input.githubUsername)
    .first<UserRow>();
  if (!row) throw new Error("upsertUser: INSERT ... RETURNING produced no row");
  return toUser(row);
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first<UserRow>();
  return row ? toUser(row) : null;
}
