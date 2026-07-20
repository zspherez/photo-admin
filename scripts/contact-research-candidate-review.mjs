export function validateCandidateReview(input) {
  const candidateEmails = input.candidates.map((candidate) =>
    candidate.email.toLowerCase()
  );
  const reviewedByEmail = new Map(
    input.reviewedEmails.map((reviewed) => [
      reviewed.email.toLowerCase(),
      reviewed,
    ])
  );
  const unreviewed = candidateEmails.filter(
    (email) => !reviewedByEmail.has(email)
  );
  if (unreviewed.length > 0) {
    throw new Error(
      `Candidate email(s) missing from reviewedEmails: ${unreviewed.join(", ")}`
    );
  }
  const excludedSubmitted = candidateEmails.filter(
    (email) =>
      reviewedByEmail.get(email)?.classification ===
      "excluded_non_manager"
  );
  if (excludedSubmitted.length > 0) {
    throw new Error(
      `Excluded non-manager email(s) cannot be submitted: ${excludedSubmitted.join(", ")}`
    );
  }
  const namedManagerEmails = input.reviewedEmails
    .filter(
      (reviewed) => reviewed.classification === "named_manager"
    )
    .map((reviewed) => reviewed.email.toLowerCase());
  const omittedNamedManagers = namedManagerEmails.filter(
    (email) => !candidateEmails.includes(email)
  );
  if (omittedNamedManagers.length > 0) {
    throw new Error(
      `Candidate submission omitted named manager email(s): ${omittedNamedManagers.join(", ")}`
    );
  }
  if (
    namedManagerEmails.length > 0 &&
    !namedManagerEmails.includes(candidateEmails[0])
  ) {
    throw new Error(
      "The first candidate must be a named manager's direct email"
    );
  }
  for (const candidate of input.candidates) {
    const reviewed = reviewedByEmail.get(
      candidate.email.toLowerCase()
    );
    if (
      reviewed?.classification === "named_manager" &&
      !candidate.name
    ) {
      throw new Error(
        `Named manager candidate ${candidate.email} requires a contact name`
      );
    }
  }
}
