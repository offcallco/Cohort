import { useState } from "react";
import { Markdown } from "./Markdown.tsx";

// Textarea with a Write / Preview toggle.
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="md-editor">
      <div className="md-tabs">
        <button type="button" className={preview ? "" : "active"} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" className={preview ? "active" : ""} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <div className="md-preview">
          {value.trim() ? <Markdown source={value} /> : <p className="muted">Nothing to preview.</p>}
        </div>
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          autoFocus={autoFocus}
        />
      )}
    </div>
  );
}
