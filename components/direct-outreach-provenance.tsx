import { directOutreachInstructionExcerptFromCanonical } from "@/lib/directOutreachInstruction";

interface DirectOutreachProvenanceData {
  directOutreachIdentity: string | null;
  directOutreachRuleVersion: number | null;
  directOutreachRuleText: string | null;
  directOutreachManagerName: string | null;
  directOutreachManagerCompany: string | null;
  directOutreachEvidenceUrls: string[];
  directOutreachEvidence: string | null;
}

export function DirectOutreachProvenance({
  contact,
  className = "",
}: {
  contact: DirectOutreachProvenanceData;
  className?: string;
}) {
  if (
    !contact.directOutreachIdentity ||
    contact.directOutreachRuleVersion === null ||
    !contact.directOutreachRuleText ||
    !contact.directOutreachManagerName ||
    !contact.directOutreachEvidence
  ) {
    return null;
  }

  return (
    <div
      className={`rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100 ${className}`}
    >
      <p className="font-semibold">Agent-created direct outreach</p>
      <p className="mt-1">
        Manager: {contact.directOutreachManagerName}
        {contact.directOutreachManagerCompany
          ? ` · ${contact.directOutreachManagerCompany}`
          : ""}
      </p>
      <p className="mt-1">
        Trusted instruction v{contact.directOutreachRuleVersion}:{" "}
        {directOutreachInstructionExcerptFromCanonical(
          contact.directOutreachRuleText,
        )}
      </p>
      <p className="mt-1">{contact.directOutreachEvidence}</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        {contact.directOutreachEvidenceUrls.map((url, index) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-amber-800 underline dark:text-amber-200"
          >
            Evidence {index + 1} ↗
          </a>
        ))}
      </div>
    </div>
  );
}
