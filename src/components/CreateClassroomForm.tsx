import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch } from "./client/api";

interface Props {
  onSuccess?: () => void;
}

export default function CreateClassroomForm({ onSuccess = () => location.reload() }: Props) {
  const [name, setName] = useState("");
  const [githubOrg, setGithubOrg] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await apiFetch("/api/classrooms", {
        method: "POST",
        body: { name, github_org: githubOrg, timezone },
      });
      // busy intentionally stays true until unmount/reload; prevents double-submit
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else {
        setError("Request failed");
      }
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create classroom</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="cc-name">Name</Label>
            <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} />
            {fields.name && <p className="text-sm text-destructive">{fields.name}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc-org">GitHub org</Label>
            <Input id="cc-org" value={githubOrg} onChange={(e) => setGithubOrg(e.target.value)} />
            {fields.github_org && <p className="text-sm text-destructive">{fields.github_org}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc-tz">Timezone</Label>
            <Input id="cc-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            {fields.timezone && <p className="text-sm text-destructive">{fields.timezone}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            Create classroom
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
