import { and, eq } from "drizzle-orm";
import { projects, workspaces, type Db } from "@cohort/db";

// Looks up a project by its workspace and project slugs.
export function findProject(db: Db, workspace: string, project: string) {
  return db
    .select({ project: projects })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(workspaces.slug, workspace), eq(projects.slug, project)))
    .get()?.project;
}
