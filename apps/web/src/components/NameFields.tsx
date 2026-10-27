import { useState } from "react";
import { slugify } from "../format.ts";

// Name + URL inputs where the URL follows the name until it's edited by hand.
export function useNameFields() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  return {
    name,
    slug: slugEdited ? slug : slugify(name),
    setName,
    setSlug: (value: string) => {
      setSlug(value);
      setSlugEdited(true);
    },
  };
}

export function NameFields({
  fields,
  prefix,
}: {
  fields: ReturnType<typeof useNameFields>;
  prefix: string;
}) {
  return (
    <>
      <label>
        Name
        <input value={fields.name} onChange={(e) => fields.setName(e.target.value)} autoFocus required />
      </label>
      <label>
        URL
        <div className="prefixed">
          <span className="muted">{prefix}</span>
          <input value={fields.slug} onChange={(e) => fields.setSlug(e.target.value)} required />
        </div>
      </label>
    </>
  );
}
