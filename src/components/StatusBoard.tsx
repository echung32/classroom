import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiError, apiFetch } from "./client/api";
import { shortSha, statusBadgeClass } from "./client/format";

export interface SubmissionRow {
  studentId: string;
  githubUsername: string | null;
  repoName: string;
  status: string | null;
  deadlineSha: string | null;
  deadlineCommitAt: string | null;
  latestSha: string | null;
  latestCommitAt: string | null;
  gradeDecision: string;
  evaluatedAt: string | null;
}

export interface EvalResult {
  dueState: string;
  submissions: SubmissionRow[];
  errors: { studentId: string; repoName: string; message: string }[];
}

interface GraderResult {
  graderRepo: string;
  htmlUrl: string;
  commitSha: string;
  included: { username: string; sha: string; source: "deadline" | "latest" }[];
  skipped: { username: string | null; studentId: string; reason: string }[];
}

interface Props {
  assignmentId: string;
  initial: EvalResult;
  graderRepo: string | null;
}

const DECISION_LABELS: Record<string, string> = {
  at_deadline: "At deadline",
  accept_late: "Accept late",
  exclude: "Exclude",
};

export default function StatusBoard({ assignmentId, initial, graderRepo }: Props) {
  const [rows, setRows] = useState(initial.submissions);
  const [evalErrors, setEvalErrors] = useState(initial.errors);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [boardError, setBoardError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [grader, setGrader] = useState<GraderResult | null>(null);
  const [graderError, setGraderError] = useState<string | null>(null);

  async function changeDecision(studentId: string, decision: string) {
    const prevDecision = rows.find((r) => r.studentId === studentId)?.gradeDecision;
    setRows((cur) =>
      cur.map((r) => (r.studentId === studentId ? { ...r, gradeDecision: decision } : r)),
    );
    setRowErrors((e) => ({ ...e, [studentId]: "" }));
    try {
      await apiFetch(`/api/assignments/${assignmentId}/submissions/${studentId}/decision`, {
        method: "PUT",
        body: { decision },
      });
    } catch (err) {
      // Per-row functional revert: never clobbers concurrent refresh/other-row state.
      setRows((cur) =>
        cur.map((r) =>
          r.studentId === studentId && prevDecision !== undefined
            ? { ...r, gradeDecision: prevDecision }
            : r,
        ),
      );
      setRowErrors((e) => ({
        ...e,
        [studentId]: err instanceof ApiError ? err.message : "Request failed",
      }));
    }
  }

  async function refresh() {
    setRefreshing(true);
    setBoardError(null);
    try {
      const result = await apiFetch<EvalResult>(
        `/api/assignments/${assignmentId}/submissions/refresh`,
        { method: "POST" },
      );
      setRows(result.submissions);
      setEvalErrors(result.errors);
    } catch (err) {
      setBoardError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function buildGrader() {
    setBuilding(true);
    setGraderError(null);
    try {
      const result = await apiFetch<GraderResult>(`/api/assignments/${assignmentId}/grader`, {
        method: "POST",
      });
      setGrader(result);
    } catch (err) {
      setGraderError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
        <Button onClick={buildGrader} disabled={building}>
          {building ? "Building…" : "Build grader"}
        </Button>
        {graderRepo && !grader && (
          <a href={`https://github.com/${graderRepo}`} className="text-sm underline">
            Current grader: {graderRepo}
          </a>
        )}
      </div>

      {boardError && (
        <p role="alert" className="text-sm text-destructive">
          {boardError}
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Student</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Deadline commit</TableHead>
            <TableHead>Latest commit</TableHead>
            <TableHead>Decision</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const who = r.githubUsername ?? r.studentId;
            return (
              <TableRow key={r.studentId}>
                <TableCell>{r.githubUsername ?? <span className="text-muted-foreground">(unlinked)</span>}</TableCell>
                <TableCell>
                  <Badge className={statusBadgeClass(r.status)}>{r.status ?? "—"}</Badge>
                </TableCell>
                <TableCell>
                  <code>{shortSha(r.deadlineSha)}</code>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.deadlineCommitAt ?? ""}
                  </span>
                </TableCell>
                <TableCell>
                  <code>{shortSha(r.latestSha)}</code>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {r.latestCommitAt ?? ""}
                  </span>
                </TableCell>
                <TableCell>
                  <Select
                    value={r.gradeDecision}
                    onValueChange={(value) => changeDecision(r.studentId, value)}
                  >
                    <SelectTrigger aria-label={`Decision for ${who}`} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="at_deadline">{DECISION_LABELS.at_deadline}</SelectItem>
                      <SelectItem value="accept_late">{DECISION_LABELS.accept_late}</SelectItem>
                      <SelectItem value="exclude">{DECISION_LABELS.exclude}</SelectItem>
                    </SelectContent>
                  </Select>
                  {rowErrors[r.studentId] && (
                    <p className="mt-1 text-xs text-destructive">{rowErrors[r.studentId]}</p>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {evalErrors.length > 0 && (
        <div className="text-sm text-destructive">
          {evalErrors.map((e) => (
            <p key={e.studentId}>
              {e.repoName}: {e.message}
            </p>
          ))}
        </div>
      )}

      {graderError && (
        <p role="alert" className="text-sm text-destructive">
          {graderError}
        </p>
      )}

      {grader && (
        <Card>
          <CardHeader>
            <CardTitle>Grader built</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <a href={grader.htmlUrl} className="underline">
                {grader.graderRepo}
              </a>{" "}
              @ <code>{shortSha(grader.commitSha)}</code>
            </p>
            <div>
              <h3 className="font-medium">Included ({grader.included.length})</h3>
              <ul>
                {grader.included.map((i) => (
                  <li key={i.username}>
                    {i.username} — {i.source} @ <code>{shortSha(i.sha)}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="font-medium">Skipped ({grader.skipped.length})</h3>
              <ul>
                {grader.skipped.map((s) => (
                  <li key={s.studentId}>
                    {s.username ?? s.studentId} — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
