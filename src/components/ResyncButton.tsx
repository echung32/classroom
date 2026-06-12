import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, apiFetch } from "./client/api";

interface ResyncResult {
  status: "invited" | "already_member";
  invitationUrl?: string;
}

interface Props {
  assignmentId: string;
}

export default function ResyncButton({ assignmentId }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resync() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiFetch<ResyncResult>(`/api/assignments/${assignmentId}/resync`, {
          method: "POST",
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={resync} disabled={busy}>
        {busy ? "Fixing…" : "Fix my access"}
      </Button>
      {result?.status === "already_member" && (
        <p className="text-sm">You already have push access to your repo.</p>
      )}
      {result?.status === "invited" && (
        <p className="text-sm">
          Invite re-sent —{" "}
          {result.invitationUrl ? (
            <a href={result.invitationUrl} className="underline">
              accept it on GitHub
            </a>
          ) : (
            "check your GitHub notifications"
          )}{" "}
          to restore push access.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
