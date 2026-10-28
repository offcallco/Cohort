import { Navigate, Route, Routes } from "react-router";
import { useSession } from "./session.tsx";
import { AppShell } from "./shell/AppShell.tsx";
import { Placeholder } from "./pages/Placeholder.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { MissionControlPage } from "./pages/MissionControlPage.tsx";
import { ReviewsPage } from "./pages/ReviewsPage.tsx";
import { AuthPage } from "./pages/AuthPage.tsx";
import { ReposPage } from "./pages/ReposPage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";
import { NewWorkspacePage } from "./pages/NewWorkspacePage.tsx";
import { WorkspacePage } from "./pages/WorkspacePage.tsx";
import { ProjectLayout } from "./pages/project/ProjectLayout.tsx";
import { TreeView } from "./pages/project/TreeView.tsx";
import { BlobView } from "./pages/project/BlobView.tsx";
import { CommitsView } from "./pages/project/CommitsView.tsx";
import { CommitView } from "./pages/project/CommitView.tsx";
import { BranchesView } from "./pages/project/BranchesView.tsx";
import { IssuesView } from "./pages/project/IssuesView.tsx";
import { NewIssueView } from "./pages/project/NewIssueView.tsx";
import { IssueView } from "./pages/project/IssueView.tsx";
import { JobsView } from "./pages/project/JobsView.tsx";
import { JobView } from "./pages/project/JobView.tsx";
import { MergeRequestsView } from "./pages/project/MergeRequestsView.tsx";
import { NewMergeRequestView } from "./pages/project/NewMergeRequestView.tsx";
import { MergeRequestView } from "./pages/project/MergeRequestView.tsx";
import { SettingsView } from "./pages/project/SettingsView.tsx";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { AllIssuesPage } from "./pages/AllIssuesPage.tsx";
import { PipelinesView } from "./pages/project/PipelinesView.tsx";
import { PipelineView } from "./pages/project/PipelineView.tsx";
import { WorkshopsView } from "./pages/project/WorkshopsView.tsx";
import { NewWorkshopView } from "./pages/project/NewWorkshopView.tsx";
import { WorkshopView } from "./pages/project/WorkshopView.tsx";

export function App() {
  const { status, error } = useSession();

  if (error) {
    return (
      <main className="centered">
        <div className="card">
          <h1>Can't reach Cohort</h1>
          <p className="muted">{error}. Check that the server is running.</p>
        </div>
      </main>
    );
  }
  if (!status) return null;

  if (status.setupRequired) {
    return (
      <Routes>
        <Route path="/setup" element={<AuthPage mode="setup" />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }
  if (!status.user) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<MissionControlPage />} />
        <Route path="repos" element={<ReposPage />} />
        <Route path="work" element={<AllIssuesPage />} />
        <Route path="issues" element={<Navigate to="/work" replace />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="activity" element={<Placeholder title="Activity">Who and what changed what, and when.</Placeholder>} />
        <Route path="settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="/settings/tokens" replace />} />
          <Route path="tokens" element={<TokensPage />} />
        </Route>
        <Route path="settings/runners" element={<Navigate to="/agents" replace />} />
        <Route path="new" element={<NewWorkspacePage />} />
        <Route path=":workspace" element={<WorkspacePage />} />
        <Route path=":workspace/:project" element={<ProjectLayout />}>
          <Route index element={<TreeView />} />
          <Route path="tree" element={<TreeView />} />
          <Route path="blob" element={<BlobView />} />
          <Route path="commits" element={<CommitsView />} />
          <Route path="commit/:sha" element={<CommitView />} />
          <Route path="branches" element={<BranchesView />} />
          <Route path="issues" element={<IssuesView />} />
          <Route path="issues/new" element={<NewIssueView />} />
          <Route path="issues/:number" element={<IssueView />} />
          <Route path="merge_requests" element={<MergeRequestsView />} />
          <Route path="merge_requests/new" element={<NewMergeRequestView />} />
          <Route path="merge_requests/:number" element={<MergeRequestView />} />
          <Route path="workshops" element={<WorkshopsView />} />
          <Route path="workshops/new" element={<NewWorkshopView />} />
          <Route path="workshops/:id" element={<WorkshopView />} />
          <Route path="pipelines" element={<PipelinesView />} />
          <Route path="pipelines/:id" element={<PipelineView />} />
          <Route path="jobs" element={<JobsView />} />
          <Route path="jobs/:id" element={<JobView />} />
          <Route path="settings" element={<SettingsView />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
