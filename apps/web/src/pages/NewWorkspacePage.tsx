import { useState } from "react";
import { useNavigate } from "react-router";
import type { Workspace } from "@cohort/shared";
import { api } from "../api.ts";
import { Form } from "../components/Form.tsx";
import { NameFields, useNameFields } from "../components/NameFields.tsx";

export function NewWorkspacePage() {
  const navigate = useNavigate();
  const fields = useNameFields();
  const [description, setDescription] = useState("");

  async function create() {
    const { workspace } = await api<{ workspace: Workspace }>("/api/workspaces", {
      body: { name: fields.name, slug: fields.slug, description },
    });
    navigate(`/${workspace.slug}`);
  }

  return (
    <section className="narrow">
      <h1>New workspace</h1>
      <Form onSubmit={create}>
        {(busy) => (
          <>
            <NameFields fields={fields} prefix={`${location.host}/`} />
            <label>
              Description <span className="muted">(optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <button type="submit" disabled={busy}>
              Create workspace
            </button>
          </>
        )}
      </Form>
    </section>
  );
}
