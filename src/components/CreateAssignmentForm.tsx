import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, apiFetch } from "./client/api";
import { localDateTimeToUtcIso } from "./client/format";

interface Props {
  classroomId: string;
  onSuccess?: () => void;
}

export default function CreateAssignmentForm({
  classroomId,
  onSuccess = () => location.reload(),
}: Props) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [templateRepo, setTemplateRepo] = useState("");
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      await apiFetch(`/api/classrooms/${classroomId}/assignments`, {
        method: "POST",
        body: {
          slug,
          title,
          template_repo: templateRepo,
          // undefined when blank — JSON.stringify drops the key, schema treats it as "no deadline"
          deadline_at: localDateTimeToUtcIso(deadline),
        },
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
        <CardTitle>Create assignment</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="ca-slug">Slug</Label>
            <Input id="ca-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
            {fields.slug && <p className="text-sm text-destructive">{fields.slug}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ca-title">Title</Label>
            <Input id="ca-title" value={title} onChange={(e) => setTitle(e.target.value)} />
            {fields.title && <p className="text-sm text-destructive">{fields.title}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ca-repo">Template repo</Label>
            <Input
              id="ca-repo"
              placeholder="owner/name"
              value={templateRepo}
              onChange={(e) => setTemplateRepo(e.target.value)}
            />
            {fields.template_repo && (
              <p className="text-sm text-destructive">{fields.template_repo}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="ca-deadline">Deadline</Label>
            <Input
              id="ca-deadline"
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
            {fields.deadline_at && <p className="text-sm text-destructive">{fields.deadline_at}</p>}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            Create assignment
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
