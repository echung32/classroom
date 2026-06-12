import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError, apiFetch } from "./client/api";

interface AcceptResult {
  repoUrl: string;
  invitationUrl?: string;
  status: string;
}

interface Props {
  assignmentId: string;
  /** True when the user already has a student row in this classroom (claimed earlier). */
  enrolled: boolean;
  rosterOptions: { id: string; rosterIdentifier: string | null }[];
  /** Called when the user clicks Continue after success; defaults to a full reload. */
  onSuccess?: () => void;
}

/** Sentinel Select value for "I'm not on the list" (Radix forbids empty item values). */
const SKIP_VALUE = "__skip__";

export default function AcceptPanel({ assignmentId, enrolled, rosterOptions, onSuccess = () => location.reload() }: Props) {
  const [selection, setSelection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResult | null>(null);

  const needsSelection = !enrolled && rosterOptions.length > 0;
  const canSubmit = !submitting && (!needsSelection || selection !== "");

  async function accept() {
    setSubmitting(true);
    setError(null);
    try {
      const body =
        !enrolled && selection !== "" && selection !== SKIP_VALUE
          ? { rosterStudentId: selection }
          : {};
      setResult(
        await apiFetch<AcceptResult>(`/api/assignments/${assignmentId}/accept`, {
          method: "POST",
          body,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 502
            ? `${err.message} — GitHub may be temporarily unavailable, try again in a moment.`
            : err.message,
        );
      } else {
        setError("Request failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="font-medium">Assignment accepted</p>
        <p className="text-sm">
          Your repo:{" "}
          <a href={result.repoUrl} className="underline">
            {result.repoUrl}
          </a>
        </p>
        {result.invitationUrl && (
          <p className="text-sm">
            <a href={result.invitationUrl} className="underline">
              Accept the invite on GitHub
            </a>{" "}
            to get push access.
          </p>
        )}
        <Button onClick={onSuccess}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      {needsSelection && (
        <div className="space-y-1">
          <Label>Who are you?</Label>
          <Select value={selection} onValueChange={setSelection}>
            <SelectTrigger aria-label="Who are you?" className="w-64">
              <SelectValue placeholder="Select your name" />
            </SelectTrigger>
            <SelectContent>
              {rosterOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.rosterIdentifier ?? o.id}
                </SelectItem>
              ))}
              <SelectItem value={SKIP_VALUE}>I'm not on the list</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <Button onClick={accept} disabled={!canSubmit}>
        {submitting ? "Accepting…" : "Accept assignment"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
