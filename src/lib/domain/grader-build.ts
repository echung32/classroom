import { ValidationError } from "../http/errors";
import type { TreeEntry } from "../github/git-data";
import {
  buildDevcontainer,
  buildGitmodules,
  buildReadme,
  selectGraderEntries,
  type GraderEntry,
  type SkippedEntry,
  type SubmissionForSelection,
} from "./grader";
import { AssignmentNotFoundError } from "./evaluation";

interface AssignmentForBuild {
  id: string;
  classroomId: string;
  slug: string;
  title: string;
  deadlineAt: string | null;
}
interface ClassroomForBuild {
  id: string;
}

export interface GraderBuildDeps {
  token: string;
  org: string;
  fetchImpl?: typeof fetch;
  loadAssignment: (id: string) => Promise<AssignmentForBuild | null>;
  loadClassroom: (id: string) => Promise<ClassroomForBuild | null>;
  listSubmissionsWithStudents: (assignmentId: string) => Promise<SubmissionForSelection[]>;
  setGraderBuilt: (assignmentId: string, graderRepo: string) => Promise<void>;
  ensureOrgRepo: (input: {
    token: string;
    org: string;
    name: string;
    fetchImpl?: typeof fetch;
  }) => Promise<{ fullName: string; htmlUrl: string }>;
  createTree: (input: {
    token: string;
    org: string;
    repo: string;
    tree: TreeEntry[];
    fetchImpl?: typeof fetch;
  }) => Promise<string>;
  getMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    fetchImpl?: typeof fetch;
  }) => Promise<string | null>;
  createCommit: (input: {
    token: string;
    org: string;
    repo: string;
    message: string;
    tree: string;
    parents: string[];
    fetchImpl?: typeof fetch;
  }) => Promise<string>;
  createMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    sha: string;
    fetchImpl?: typeof fetch;
  }) => Promise<void>;
  updateMainRef: (input: {
    token: string;
    org: string;
    repo: string;
    sha: string;
    fetchImpl?: typeof fetch;
  }) => Promise<void>;
}

export interface GraderBuildResult {
  graderRepo: string;
  htmlUrl: string;
  commitSha: string;
  included: { username: string; sha: string; source: "deadline" | "latest" }[];
  skipped: SkippedEntry[];
}

/**
 * Assemble org/grader-{slug} via the Git Data API only. Requires submissions to
 * already be evaluated (decide-first-then-build). The whole tree is rebuilt every
 * time (no base_tree) so re-runs pick up changed decisions and are idempotent.
 */
export async function buildGrader(
  deps: GraderBuildDeps,
  input: { assignmentId: string; now: string },
): Promise<GraderBuildResult> {
  const assignment = await deps.loadAssignment(input.assignmentId);
  if (!assignment) throw new AssignmentNotFoundError();

  if (assignment.deadlineAt === null || Date.parse(input.now) < Date.parse(assignment.deadlineAt)) {
    throw new ValidationError("Cannot build a grader before the assignment deadline has passed");
  }

  // Existence check only — the org now comes from deps.org, not the classroom row.
  const classroom = await deps.loadClassroom(assignment.classroomId);
  if (!classroom) throw new AssignmentNotFoundError();

  const submissions = await deps.listSubmissionsWithStudents(assignment.id);
  const { included, skipped } = selectGraderEntries(submissions);
  if (included.length === 0) {
    throw new ValidationError("Nothing to build: no submissions are eligible for the grader");
  }

  const org = deps.org;
  const name = `grader-${assignment.slug}`;
  const repo = await deps.ensureOrgRepo({ token: deps.token, org, name, fetchImpl: deps.fetchImpl });

  const tree = buildTree(included, org, name, assignment.title);
  const treeSha = await deps.createTree({ token: deps.token, org, repo: name, tree, fetchImpl: deps.fetchImpl });

  const parent = await deps.getMainRef({ token: deps.token, org, repo: name, fetchImpl: deps.fetchImpl });
  const commitSha = await deps.createCommit({
    token: deps.token,
    org,
    repo: name,
    message: `Build grader for ${assignment.title}`,
    tree: treeSha,
    parents: parent ? [parent] : [],
    fetchImpl: deps.fetchImpl,
  });

  if (parent) {
    await deps.updateMainRef({ token: deps.token, org, repo: name, sha: commitSha, fetchImpl: deps.fetchImpl });
  } else {
    await deps.createMainRef({ token: deps.token, org, repo: name, sha: commitSha, fetchImpl: deps.fetchImpl });
  }

  const graderRepo = `${org}/${name}`;
  await deps.setGraderBuilt(assignment.id, graderRepo);

  return {
    graderRepo,
    htmlUrl: repo.htmlUrl,
    commitSha,
    included: included.map((e) => ({ username: e.username, sha: e.sha, source: e.source })),
    skipped,
  };
}

/** The full tree: inline text blobs + one 160000 gitlink per included entry. */
function buildTree(included: GraderEntry[], org: string, name: string, title: string): TreeEntry[] {
  const tree: TreeEntry[] = [
    { path: ".gitmodules", mode: "100644", type: "blob", content: buildGitmodules(included, org) },
    {
      path: ".devcontainer/devcontainer.json",
      mode: "100644",
      type: "blob",
      content: buildDevcontainer(included, org, name),
    },
    { path: "README.md", mode: "100644", type: "blob", content: buildReadme(title, included) },
  ];
  for (const e of included) {
    tree.push({ path: `submissions/${e.username}`, mode: "160000", type: "commit", sha: e.sha });
  }
  return tree;
}
