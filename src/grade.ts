export type Trait = { trait_type?: string; value?: string | number };

const GRADERS = ["PSA", "CGC", "BGS", "SGC", "TAG", "ACE", "HGA"];

export const gradeLabel = (attributes: Trait[], rarity?: string | null) => {
  const rows = attributes.filter((attr) => attr && (attr.trait_type || attr.value != null));
  const grade = rows.find((attr) => {
    const type = String(attr.trait_type || "");
    if (/company|grader|service|authority/i.test(type)) return false;
    return /grade/i.test(type);
  });
  const company = rows.find((attr) => /company|grader|service|authority/i.test(String(attr.trait_type || "")));
  if (grade?.value != null && String(grade.value).trim()) {
    const value = String(grade.value).trim();
    const who = company?.value != null ? String(company.value).trim() : "";
    if (who && !value.toUpperCase().includes(who.toUpperCase())) return `${who} ${value}`;
    return value;
  }
  const blob = rows.map((attr) => `${attr.trait_type || ""} ${attr.value ?? ""}`).join(" ");
  for (const grader of GRADERS) {
    const match = blob.match(new RegExp(`${grader}\\s*([0-9]+(?:\\.[0-9])?)`, "i"));
    if (match) return `${grader} ${match[1]}`;
  }
  if (rarity && rarity.trim()) return `${rarity.trim()} card`;
  return "Graded card";
};
