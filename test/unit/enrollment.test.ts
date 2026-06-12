import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/db/students", () => ({
  findStudentByUser: vi.fn(),
  claimStudent: vi.fn(),
  createStudent: vi.fn(),
}));

import { claimStudent, createStudent, findStudentByUser } from "../../src/lib/db/students";
import { resolveStudentForAccept } from "../../src/lib/domain/enrollment";

const db = {} as never; // never touched: the db functions are mocked

beforeEach(() => {
  vi.mocked(findStudentByUser).mockReset();
  vi.mocked(claimStudent).mockReset();
  vi.mocked(createStudent).mockReset();
});

describe("resolveStudentForAccept", () => {
  it("reuses an existing student linked by user_id", async () => {
    const existing = { id: "s1" } as never;
    vi.mocked(findStudentByUser).mockResolvedValue(existing);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
      rosterStudentId: "r1",
    });

    expect(result).toBe(existing);
    expect(claimStudent).not.toHaveBeenCalled();
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("claims the chosen roster row when none exists and rosterStudentId is given", async () => {
    vi.mocked(findStudentByUser).mockResolvedValue(null);
    const claimed = { id: "s2" } as never;
    vi.mocked(claimStudent).mockResolvedValue(claimed);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
      rosterStudentId: "r1",
    });

    expect(result).toBe(claimed);
    expect(claimStudent).toHaveBeenCalledWith(db, "r1", "c1", "u1", "octocat");
    expect(createStudent).not.toHaveBeenCalled();
  });

  it("creates a fresh student (skip path) when none exists and no rosterStudentId", async () => {
    vi.mocked(findStudentByUser).mockResolvedValue(null);
    const created = { id: "s3" } as never;
    vi.mocked(createStudent).mockResolvedValue(created);

    const result = await resolveStudentForAccept(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
    });

    expect(result).toBe(created);
    expect(createStudent).toHaveBeenCalledWith(db, {
      classroomId: "c1",
      userId: "u1",
      githubUsername: "octocat",
    });
    expect(claimStudent).not.toHaveBeenCalled();
  });
});
