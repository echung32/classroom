import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiFetch } from "./client/api";

export interface RosterStudent {
  id: string;
  rosterIdentifier: string | null;
  githubUsername: string | null;
}

interface Props {
  classroomId: string;
  students: RosterStudent[];
  onSuccess?: () => void;
}

export default function RosterPanel({
  classroomId,
  students,
  onSuccess = () => location.reload(),
}: Props) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const identifiers = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (identifiers.length === 0) {
      setError("Enter at least one roster name");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/classrooms/${classroomId}/students`, {
        method: "POST",
        body: { identifiers },
      });
      // busy intentionally stays true until unmount/reload; prevents double-submit
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roster</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {students.length === 0 ? (
          <p className="text-sm text-muted-foreground">No students yet.</p>
        ) : (
          <ul className="space-y-1">
            {students.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <span>{s.rosterIdentifier ?? "(no roster name)"}</span>
                {s.githubUsername ? (
                  <Badge variant="secondary">{s.githubUsername}</Badge>
                ) : (
                  <Badge variant="outline">unlinked</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={onSubmit} className="space-y-2">
          <Label htmlFor="roster-names">Roster names (one per line)</Label>
          <Textarea
            id="roster-names"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            Add to roster
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
