import { useNavigate } from "react-router";
import { useProject } from "./ProjectLayout.tsx";

// Branch dropdown that keeps the current view and path, changing only ?ref=.
export function RefPicker({ view, path }: { view: "" | "/tree" | "/blob" | "/commits"; path?: string }) {
  const { branches, base, ref } = useProject();
  const navigate = useNavigate();
  const isBranch = branches.some((b) => b.name === ref);

  return (
    <select
      className="ref-picker"
      value={ref ?? ""}
      onChange={(e) => {
        const params = new URLSearchParams({ ref: e.target.value });
        if (path) params.set("path", path);
        navigate(`${base}${view || (path ? "/tree" : "")}?${params}`);
      }}
    >
      {!isBranch && ref && <option value={ref}>{ref.slice(0, 8)}</option>}
      {branches.map((b) => (
        <option key={b.name} value={b.name}>
          {b.name}
        </option>
      ))}
    </select>
  );
}
